import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.AUTH_SECRET = 'test-secret-value-at-least-32-bytes-long!!';
process.env.DB_DRIVER = 'memory';
process.env.NODE_ENV = 'test';

const {
  MAX_HOT_LINKS, hotKey, hotValue, isHotEligible, maskKey, routingEntries, staleKeys,
} = await import('../src/publish.ts');
import type { Block, Profile } from '../src/domain/types.ts';
import type { TRule } from '../src/domain/schema.ts';

const profile = (over: Partial<Profile> = {}): Profile => ({
  id: 'p1', userId: 'u1', handle: 'erin', title: 'Erin', version: 4,
  publishedVersion: 4, createdAt: 0, updatedAt: 0, ...over,
});

const link = (id: string, over: Partial<Block> = {}): Block => ({
  id, profileId: 'p1', rank: `a${id}`, kind: 'link', label: id,
  target: `https://example.com/${id}`, hidden: false, rules: [],
  createdAt: 0, updatedAt: 0, ...over,
});

const geoRule: TRule = {
  id: 'r1', priority: 0, when: [{ dim: 'geo', in: ['eu'] }],
  then: { kind: 'redirect', target: 'https://eu.example.com', status: 302 },
};

describe('what may be answered at the edge', () => {
  test('a plain published link qualifies', () => {
    assert.equal(isHotEligible(profile(), link('a')), true);
  });

  test('anything the origin would evaluate does not', () => {
    // Each of these is a destination that depends on who is asking or when, and
    // the edge has no way to know that — it would serve one answer to everyone
    // and cache it.
    const cases: Array<[string, Block]> = [
      ['a rule', link('a', { rules: [geoRule] })],
      ['an activity window opening', link('a', { activeFrom: 1 })],
      ['an activity window closing', link('a', { activeUntil: 1 })],
      ['hidden', link('a', { hidden: true })],
      ['not a link', link('a', { kind: 'feed' })],
      ['no target', link('a', { target: undefined })],
      ['a non-http target', link('a', { target: 'mailto:x@example.com' })],
    ];
    for (const [why, b] of cases) {
      assert.equal(isHotEligible(profile(), b), false, `${why} should disqualify a block`);
    }
  });

  test('a draft page has no edge routing at all', () => {
    // `/r/` 404s for an unpublished profile. A hot link would answer where the
    // origin refuses, publishing a page its owner never published.
    const draft = profile({ publishedVersion: null });
    assert.equal(isHotEligible(draft, link('a')), false);
    assert.equal(routingEntries(draft, [link('a')]).size, 0);
  });
});

describe('the entries a publish writes', () => {
  test('a maskless page with plain links writes only hot links', () => {
    const entries = routingEntries(profile(), [link('a'), link('b')]);
    assert.deepEqual([...entries.keys()].sort(), ['hot:erin/a', 'hot:erin/b']);
    assert.equal(entries.get('hot:erin/a'), '302|https://example.com/a');
  });

  test('the mask carries the profile version, so the origin can spot a stale key', () => {
    const entries = routingEntries(profile({ version: 9 }), [link('a', { rules: [geoRule] })]);
    assert.equal(entries.get(maskKey('erin')), 'v9|g');
  });

  test('a ruled block is excluded from hot links but still drives the mask', () => {
    const entries = routingEntries(profile(), [link('a', { rules: [geoRule] }), link('b')]);
    assert.deepEqual([...entries.keys()].sort(), ['hot:erin/b', 'mask:erin']);
  });

  test('hot links are capped, and the cap keeps the top of the list', () => {
    // Rank order is roughly click order, so the overflow is the right end to
    // drop: the store is a 5 MB budget shared by every profile in the account.
    const blocks = Array.from({ length: MAX_HOT_LINKS + 5 }, (_, i) =>
      link(`b${String(i).padStart(2, '0')}`));
    const entries = routingEntries(profile(), blocks);
    assert.equal(entries.size, MAX_HOT_LINKS);
    assert.ok(entries.has('hot:erin/b00'));
    assert.ok(!entries.has(`hot:erin/b${MAX_HOT_LINKS + 4}`));
  });

  test('handles are lowercased into keys, matching what the edge looks up', () => {
    assert.equal(hotKey('ERIN', 'x'), 'hot:erin/x');
    assert.equal(maskKey('ERIN'), 'mask:erin');
  });

  test('the value puts the fixed field first so a piped URL survives', () => {
    assert.equal(hotValue('https://x.test/?a=1|2'), '302|https://x.test/?a=1|2');
  });
});

describe('what a publish has to delete', () => {
  const live = (p: Profile, b: Block[]) => routingEntries(p, b);

  test('a block that gained a rule has its hot link removed', () => {
    const blocks = [link('a', { rules: [geoRule] }), link('b')];
    const stale = staleKeys(profile(), blocks, live(profile(), blocks));
    assert.ok(stale.includes('hot:erin/a'));
    assert.ok(!stale.includes('hot:erin/b'));
  });

  test('a deleted block is named by the caller, since it is gone from the list', () => {
    const blocks = [link('b')];
    const stale = staleKeys(profile(), blocks, live(profile(), blocks), { removedBlockIds: ['a'] });
    assert.ok(stale.includes('hot:erin/a'));
  });

  test('removing the last rule removes the mask key', () => {
    const blocks = [link('a')];
    assert.ok(staleKeys(profile(), blocks, live(profile(), blocks)).includes('mask:erin'));
  });

  test('a rename takes the whole of the old handle with it', () => {
    // Left behind, `mask:old` would be inherited by the next creator to claim
    // that handle — a cache-key mask derived from someone else's rules — and
    // every hot link would keep redirecting under a name that has moved on.
    const blocks = [link('a'), link('b')];
    const renamed = profile({ handle: 'erin2' });
    const stale = staleKeys(renamed, blocks, live(renamed, blocks), { previousHandle: 'erin' });
    assert.ok(stale.includes('mask:erin'));
    assert.ok(stale.includes('hot:erin/a'));
    assert.ok(stale.includes('hot:erin/b'));
    assert.ok(!stale.includes('hot:erin2/a'), 'the new handle must keep its own entries');
  });

  test('a rename to the same handle deletes nothing extra', () => {
    const blocks = [link('a')];
    const stale = staleKeys(profile(), blocks, live(profile(), blocks), { previousHandle: 'ERIN' });
    assert.deepEqual(stale, ['mask:erin']);
  });

  test('unpublishing retracts every link', () => {
    const draft = profile({ publishedVersion: null });
    const blocks = [link('a'), link('b')];
    const stale = staleKeys(draft, blocks, live(draft, blocks));
    assert.deepEqual(stale.sort(), ['hot:erin/a', 'hot:erin/b', 'mask:erin']);
  });

  test('nothing is both written and deleted in the same publish', () => {
    // Puts and deletes travel in one UpdateKeys call, so an overlap would be an
    // entry whose fate depends on the order the service applies them.
    const blocks = [link('a'), link('b', { rules: [geoRule] }), link('c', { hidden: true })];
    const entries = live(profile(), blocks);
    const stale = staleKeys(profile(), blocks, entries, { removedBlockIds: ['d'] });
    for (const key of stale) assert.ok(!entries.has(key), `${key} is in both sets`);
  });
});
