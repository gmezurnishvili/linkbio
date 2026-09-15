import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';

// `src/env.ts` parses process.env at module load and throws on a bad value, so
// the configuration has to be in place before anything under src/ is imported.
// A secret shorter than 32 bytes, or a missing one, stops the process.
process.env.AUTH_SECRET = 'test-secret-value-at-least-32-bytes-long!!';
process.env.DB_DRIVER = 'memory';
process.env.NODE_ENV = 'test';

const { createApp } = await import('../src/app.ts');
const { MemoryRepo } = await import('../src/db/memory.ts');
const { SELF_AUDIENCE, SELF_ISSUER } = await import('../src/auth.ts');
const { deriveMask } = await import('../src/publish.ts');

let app: ReturnType<typeof createApp>;
let token: string;
let otherToken: string;

const secret = () => new TextEncoder().encode(process.env.AUTH_SECRET!);

/**
 * A token shaped like the ones `routes/auth.ts` mints.
 *
 * `requireAuth` pins HS256, requires `exp` and `sub`, checks issuer and
 * audience, and refuses a token whose `typ` is present and not `'access'` — so
 * a refresh token cannot be replayed as an access token. Every one of those is
 * load-bearing, which is why this helper sets all of them.
 */
async function sign(sub: string, over: Record<string, unknown> = {}) {
  let jwt = new SignJWT({ typ: 'access', scope: 'profiles:write', ...over })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuer(SELF_ISSUER)
    .setAudience(SELF_AUDIENCE)
    .setIssuedAt();
  if (!('noExp' in over)) jwt = jwt.setExpirationTime('1h');
  return jwt.sign(secret());
}

function req(path: string, init: RequestInit = {}, auth?: string) {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  if (auth) headers.set('authorization', `Bearer ${auth}`);
  return app.request(`http://api.test${path}`, { ...init, headers });
}

const json = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) });

before(async () => {
  app = createApp(new MemoryRepo());
  token = await sign('user_alice');
  otherToken = await sign('user_bob');
});

// The fractional-indexing unit tests moved to test/rank.test.ts, which covers
// the same cases plus the seams the rewrite of `rankBetween` exists to fix.

// ---------------------------------------------------------------- auth

describe('auth', () => {
  test('rejects a missing token', async () => {
    const r = await req('/v1/profiles');
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('content-type'), 'application/problem+json');
  });

  test('rejects a forged token', async () => {
    const r = await req('/v1/profiles', {}, 'not.a.jwt');
    assert.equal(r.status, 401);
  });

  test('accepts a valid token', async () => {
    const r = await req('/v1/profiles', {}, token);
    assert.equal(r.status, 200);
  });

  test('rejects a token signed with another key', async () => {
    const forged = await new SignJWT({ typ: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user_alice')
      .setIssuer(SELF_ISSUER)
      .setAudience(SELF_AUDIENCE)
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('a-completely-different-secret-value-32!!'));
    assert.equal((await req('/v1/profiles', {}, forged)).status, 401);
  });

  // A refresh token is signed with the same key as an access token. Without the
  // `typ` check it could be replayed here and would carry the refresh token's
  // much longer lifetime into the control plane.
  test('rejects a token whose typ is not access', async () => {
    const refreshish = await sign('user_alice', { typ: 'refresh' });
    assert.equal((await req('/v1/profiles', {}, refreshish)).status, 401);
  });

  test('rejects a token with no expiry', async () => {
    const forever = await sign('user_alice', { noExp: true });
    assert.equal((await req('/v1/profiles', {}, forever)).status, 401);
  });

  test('rejects a token minted for another audience', async () => {
    const wrong = await new SignJWT({ typ: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user_alice')
      .setIssuer(SELF_ISSUER)
      .setAudience('some-other-app')
      .setExpirationTime('1h')
      .sign(secret());
    assert.equal((await req('/v1/profiles', {}, wrong)).status, 401);
  });

  test('an unmatched route is problem+json too', async () => {
    const r = await req('/v1/definitely-not-a-route');
    assert.equal(r.status, 404);
    assert.equal(r.headers.get('content-type'), 'application/problem+json');
    const body = await r.json() as any;
    assert.equal(body.title, 'not_found');
    assert.ok(body.requestId, 'error bodies carry the request id');
  });
});

// ---------------------------------------------------------------- profiles

describe('profiles', () => {
  test('creates a profile and claims the handle', async () => {
    const r = await req('/v1/profiles', json({ handle: 'alice', title: 'Alice' }), token);
    assert.equal(r.status, 201);
    // Mutations answer with an envelope, not the bare entity.
    const body = await r.json() as any;
    assert.equal(body.data.handle, 'alice');
    assert.equal(body.data.version, 1);
    assert.equal(body.version, 1);
    assert.deepEqual(body.cacheDimensions, []);
    // A page nobody has published yet is a draft, not an empty page.
    assert.equal(body.data.publishedVersion, null);
  });

  test('a second claim on the same handle conflicts', async () => {
    const r = await req('/v1/profiles', json({ handle: 'alice', title: 'Impostor' }), otherToken);
    assert.equal(r.status, 409);
    assert.equal((await r.json() as any).title, 'conflict');
  });

  test('rejects reserved handles', async () => {
    const r = await req('/v1/profiles', json({ handle: 'admin', title: 'x' }), token);
    assert.equal(r.status, 400);
  });

  test('rejects malformed handles', async () => {
    const r = await req('/v1/profiles', json({ handle: 'A_Bad_Handle!', title: 'x' }), token);
    assert.equal(r.status, 400);
    const body = await r.json() as any;
    assert.ok(body.errors.some((e: { path: string }) => e.path === 'handle'));
  });

  test('another user cannot read the profile', async () => {
    const list = await (await req('/v1/profiles', {}, token)).json() as any;
    const id = list.profiles[0].id;
    const r = await req(`/v1/profiles/${id}`, {}, otherToken);
    assert.equal(r.status, 403);
  });

  /**
   * A rename holds the old handle against everyone else for 90 days.
   *
   * This test used to assert that a *different* user could immediately reclaim
   * it, which was the opposite of what production did — MemoryRepo freed the
   * handle while DynamoRepo tombstoned it, and the suite certified the wrong
   * one. Both repos tombstone now; `test/conformance.test.ts` holds them to it.
   */
  test('renaming tombstones the old handle against everyone else', async () => {
    const list = await (await req('/v1/profiles', {}, token)).json() as any;
    const id = list.profiles[0].id;
    const r = await req(`/v1/profiles/${id}/handle`, {
      method: 'PUT', body: JSON.stringify({ handle: 'alicia' }),
    }, token);
    assert.equal(r.status, 200);
    assert.equal((await r.json() as any).data.handle, 'alicia');

    const avail = await req('/v1/handles/alice');
    assert.deepEqual(await avail.json(), { available: false, reason: 'tombstoned' });

    const steal = await req('/v1/profiles', json({ handle: 'alice', title: 'Bob' }), otherToken);
    assert.equal(steal.status, 409);
  });

  test('the profile that gave a handle up can take it back', async () => {
    const list = await (await req('/v1/profiles', {}, token)).json() as any;
    const id = list.profiles[0].id;
    const r = await req(`/v1/profiles/${id}/handle`, json({ handle: 'alice' }), token);
    assert.equal(r.status, 200);
    assert.equal((await r.json() as any).data.handle, 'alice');
  });
});

// ---------------------------------------------------------------- blocks

describe('blocks', () => {
  let pid: string;

  before(async () => {
    const r = await req('/v1/profiles', json({ handle: 'carol', title: 'Carol' }), token);
    pid = (await r.json() as any).data.id;
  });

  const mkBlock = (label: string, target: string) =>
    req(`/v1/profiles/${pid}/blocks`, json({ label, target }), token);

  test('creates blocks in append order', async () => {
    for (const n of ['one', 'two', 'three']) {
      const r = await mkBlock(n, `https://example.com/${n}`);
      assert.equal(r.status, 201);
      const body = await r.json() as any;
      assert.equal(body.data.label, n);
      assert.ok(Number.isInteger(body.version), 'the envelope carries the new profile version');
    }
    const { blocks } = await (await req(`/v1/profiles/${pid}/blocks`, {}, token)).json() as any;
    assert.deepEqual(blocks.map((b: { label: string }) => b.label), ['one', 'two', 'three']);
  });

  test('every block write bumps the profile version', async () => {
    const before = (await (await req(`/v1/profiles/${pid}`, {}, token)).json() as any).version;
    const r = await mkBlock('four', 'https://example.com/four');
    assert.equal((await r.json() as any).version, before + 1);
  });

  // The blocks router is mounted as a child of `profiles`, so the ownership
  // middleware has to reach it — if it did not, `c.get('profile')` would be
  // whatever the last request left behind.
  test('another user cannot read or write the blocks', async () => {
    assert.equal((await req(`/v1/profiles/${pid}/blocks`, {}, otherToken)).status, 403);
    const write = await req(`/v1/profiles/${pid}/blocks`,
      json({ label: 'theirs', target: 'https://theirs.example' }), otherToken);
    assert.equal(write.status, 403);
  });

  test('rejects a private-network target', async () => {
    const r = await mkBlock('ssrf', 'http://169.254.169.254/latest/meta-data/');
    assert.equal(r.status, 400);
  });

  test('rejects a non-http scheme', async () => {
    const r = await mkBlock('js', 'javascript:alert(1)');
    assert.equal(r.status, 400);
  });

  test('moving a block rewrites exactly one rank', async () => {
    const before = await (await req(`/v1/profiles/${pid}/blocks`, {}, token)).json() as any;
    const [one, two, three] = before.blocks;

    const r = await req(`/v1/profiles/${pid}/blocks/${three.id}/move`,
      json({ beforeId: one.id }), token);
    assert.equal(r.status, 200);

    const after = await (await req(`/v1/profiles/${pid}/blocks`, {}, token)).json() as any;
    assert.deepEqual(
      after.blocks.slice(0, 3).map((b: { label: string }) => b.label),
      ['three', 'one', 'two'],
    );

    // Only the moved row changed rank.
    const changed = after.blocks.filter((b: { id: string; rank: string }) =>
      b.rank !== before.blocks.find((x: { id: string }) => x.id === b.id)!.rank);
    assert.equal(changed.length, 1);
    assert.equal(changed[0].id, three.id);
    assert.ok(two.rank);
  });

  test('move with an unknown neighbour is rejected', async () => {
    const { blocks } = await (await req(`/v1/profiles/${pid}/blocks`, {}, token)).json() as any;
    const r = await req(`/v1/profiles/${pid}/blocks/${blocks[0].id}/move`,
      json({ afterId: 'blk_nope' }), token);
    assert.equal(r.status, 400);
  });

  test('deletes a block', async () => {
    const { blocks } = await (await req(`/v1/profiles/${pid}/blocks`, {}, token)).json() as any;
    const r = await req(`/v1/profiles/${pid}/blocks/${blocks[0].id}`, { method: 'DELETE' }, token);
    // DELETE stays a bare 204 — there is no entity left to wrap.
    assert.equal(r.status, 204);
    const after = await (await req(`/v1/profiles/${pid}/blocks`, {}, token)).json() as any;
    assert.equal(after.blocks.length, blocks.length - 1);
  });
});

// ---------------------------------------------------------------- rules and mask

describe('rules and edge mask', () => {
  let pid: string;
  let blockId: string;

  before(async () => {
    const r = await req('/v1/profiles', json({ handle: 'dave', title: 'Dave' }), token);
    pid = (await r.json() as any).data.id;
    const b = await req(`/v1/profiles/${pid}/blocks`,
      json({ label: 'store', target: 'https://store.example' }), token);
    blockId = (await b.json() as any).data.id;
  });

  test('mask is empty with no rules', () => {
    assert.equal(deriveMask([]), '');
  });

  test('accepts a valid rule set', async () => {
    const r = await req(`/v1/profiles/${pid}/blocks/${blockId}/rules`, {
      method: 'PUT',
      body: JSON.stringify([{
        id: 'eu', priority: 10,
        when: [{ dim: 'geo', in: ['eu'] }],
        then: { kind: 'redirect', target: 'https://store.example/eu', status: 302 },
      }]),
    }, token);
    assert.equal(r.status, 200);
    // The envelope reports the mask the edge will now key on.
    assert.deepEqual((await r.json() as any).cacheDimensions, ['geo']);
  });

  test('rejects duplicate conditions on one dimension', async () => {
    const r = await req(`/v1/profiles/${pid}/blocks/${blockId}/rules`, {
      method: 'PUT',
      body: JSON.stringify([{
        id: 'dup', priority: 1,
        when: [{ dim: 'geo', in: ['eu'] }, { dim: 'geo', in: ['na'] }],
        then: { kind: 'hide' },
      }]),
    }, token);
    assert.equal(r.status, 400);
  });

  test('rejects an unknown timezone', async () => {
    const r = await req(`/v1/profiles/${pid}/blocks/${blockId}/rules`, {
      method: 'PUT',
      body: JSON.stringify([{
        id: 't', priority: 1,
        when: [{ dim: 'time', tz: 'Mars/Olympus', from: '09:00', to: '17:00' }],
        then: { kind: 'hide' },
      }]),
    }, token);
    assert.equal(r.status, 400);
  });

  test('rejects 301 as a rule action', async () => {
    const r = await req(`/v1/profiles/${pid}/blocks/${blockId}/rules`, {
      method: 'PUT',
      body: JSON.stringify([{
        id: 'perm', priority: 1,
        when: [{ dim: 'geo', in: ['na'] }],
        then: { kind: 'redirect', target: 'https://x.example', status: 301 },
      }]),
    }, token);
    assert.equal(r.status, 400);
  });
});

// ---------------------------------------------------------------- public

describe('public resolve', () => {
  let pid: string;
  let blockId: string;

  before(async () => {
    const r = await req('/v1/profiles', json({ handle: 'erin', title: 'Erin' }), token);
    pid = (await r.json() as any).data.id;
    const b = await req(`/v1/profiles/${pid}/blocks`,
      json({ label: 'shop', target: 'https://shop.example' }), token);
    blockId = (await b.json() as any).data.id;
    // The public routes 404 until the page is published. `publishedVersion`
    // survives every later edit, so this only has to happen once.
    const pub = await req(`/v1/profiles/${pid}/publish`, { method: 'POST' }, token);
    assert.equal(pub.status, 200);
  });

  test('redirects to the default target', async () => {
    const r = await req(`/r/erin/${blockId}`);
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), 'https://shop.example');
    assert.equal(r.headers.get('x-rule-id'), 'default');
  });

  test('a rule-free link caches for the full ceiling', async () => {
    const r = await req(`/r/erin/${blockId}`);
    assert.equal(r.headers.get('cache-control'), 'max-age=0, s-maxage=3600');
  });

  test('geo rule routes an EU viewer elsewhere', async () => {
    await req(`/v1/profiles/${pid}/blocks/${blockId}/rules`, {
      method: 'PUT',
      body: JSON.stringify([{
        id: 'eu', priority: 10,
        when: [{ dim: 'geo', in: ['eu'] }],
        then: { kind: 'redirect', target: 'https://shop.example/eu', status: 302 },
      }]),
    }, token);

    const eu = await req(`/r/erin/${blockId}`, {
      headers: { 'cloudfront-viewer-country': 'DE' },
    });
    assert.equal(eu.headers.get('location'), 'https://shop.example/eu');
    assert.equal(eu.headers.get('x-rule-id'), 'eu');

    const us = await req(`/r/erin/${blockId}`, {
      headers: { 'cloudfront-viewer-country': 'US' },
    });
    assert.equal(us.headers.get('location'), 'https://shop.example');
  });

  /**
   * The geo slot is the first of the five, and the mask here covers geo — so an
   * `x-ctx` that carries a geo token is complete for this block. What makes the
   * answer uncacheable is only that the edge keyed it under an older version.
   */
  test('a stale edge mask version forces no-store', async () => {
    const r = await req(`/r/erin/${blockId}`, { headers: { 'x-ctx': 'v1|eu.d.dir.en.0' } });
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('location'), 'https://shop.example/eu');
  });

  // The edge only sends the dimensions the profile's mask covers. A mask that
  // does not cover geo cannot produce a cacheable answer for a geo rule, and
  // the coverage check has to notice from the `x-ctx` alone.
  test('an x-ctx missing the dimension a rule needs forces no-store', async () => {
    const version = (await (await req(`/v1/profiles/${pid}`, {}, token)).json() as any).version;
    const r = await req(`/r/erin/${blockId}`, { headers: { 'x-ctx': `v${version}|-.m.-.-.-` } });
    assert.equal(r.headers.get('cache-control'), 'no-store');
  });

  test('scheduled block hides before activation and caps the TTL', async () => {
    const soon = Date.now() + 120_000;
    const b = await req(`/v1/profiles/${pid}/blocks`,
      json({ label: 'drop', target: 'https://drop.example', activeFrom: soon }), token);
    const id = (await b.json() as any).data.id;

    const r = await req(`/r/erin/${id}`);
    assert.equal(r.status, 404);
    const ttl = Number(r.headers.get('cache-control')!.match(/s-maxage=(\d+)/)![1]);
    assert.ok(ttl > 100 && ttl <= 120, `ttl was ${ttl}`);
  });

  test('unknown handle is a 404', async () => {
    const r = await req('/r/nobody/blk_x');
    assert.equal(r.status, 404);
  });

  test('profile render omits hidden blocks', async () => {
    await req(`/v1/profiles/${pid}/blocks`,
      json({ label: 'secret', target: 'https://secret.example', hidden: true }), token);
    const r = await req('/p/erin');
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.ok(!body.blocks.some((b: { label: string }) => b.label === 'secret'));
    assert.equal(body.published, true);
  });
});

// ---------------------------------------------------------------- analytics

describe('analytics', () => {
  let pid: string;
  let blockId: string;

  before(async () => {
    const r = await req('/v1/profiles', json({ handle: 'frank', title: 'Frank' }), token);
    pid = (await r.json() as any).data.id;
    const b = await req(`/v1/profiles/${pid}/blocks`,
      json({ label: 'link', target: 'https://frank.example' }), token);
    blockId = (await b.json() as any).data.id;
  });

  const stats = async () =>
    await (await req(`/v1/profiles/${pid}/analytics`, {}, token)).json() as any;

  test('accepts a beacon batch without auth', async () => {
    const r = await req('/v1/events', json({
      events: [{ handle: 'frank', blockId, ts: Date.now() }],
    }));
    assert.equal(r.status, 202);
    const body = await stats();
    assert.equal(body.totals.clicks, 1);
    assert.equal(body.byBlock[blockId], 1);
  });

  // An id the caller made up used to land in the owner's analytics, where on
  // DynamoDB it also accumulated toward the item size limit.
  test('silently drops events for a block that is not on the profile', async () => {
    const before = await stats();
    const r = await req('/v1/events', json({
      events: [{ handle: 'frank', blockId: 'blk_not_mine', ts: Date.now() }],
    }));
    assert.equal(r.status, 202);
    const after = await stats();
    assert.equal(after.totals.clicks, before.totals.clicks);
    assert.equal(after.byBlock.blk_not_mine, undefined);
  });

  test('an event with no blockId counts as a view', async () => {
    const before = await stats();
    await req('/v1/events', json({ events: [{ handle: 'frank', ts: Date.now() }] }));
    const after = await stats();
    assert.equal(after.totals.views, before.totals.views + 1);
    assert.equal(after.totals.clicks, before.totals.clicks);
  });

  test('clamps an out-of-range timestamp into today', async () => {
    await req('/v1/events', json({
      events: [{ handle: 'frank', blockId, ts: 1 }],
    }));
    const body = await stats();
    const today = new Date().toISOString().slice(0, 10);
    assert.ok(body.daily.length > 0);
    assert.ok(body.daily.every((d: { date: string }) => d.date === today));
  });

  test('rejects an oversized batch', async () => {
    const r = await req('/v1/events', json({
      events: Array.from({ length: 51 }, () => ({ handle: 'frank', ts: Date.now() })),
    }));
    assert.equal(r.status, 400);
  });

  // The daily rollup and the all-time totals are assembled from different rows;
  // they have to agree.
  test('daily byBlock sums to the all-time block totals', async () => {
    const body = await stats();
    const summed: Record<string, number> = {};
    for (const d of body.daily) {
      for (const [id, n] of Object.entries(d.byBlock as Record<string, number>)) {
        summed[id] = (summed[id] ?? 0) + n;
      }
    }
    assert.deepEqual(summed, body.byBlock);
  });

  test('reports totals to the owner only', async () => {
    const mine = await req(`/v1/profiles/${pid}/analytics`, {}, token);
    assert.equal(mine.status, 200);
    assert.ok((await mine.json() as any).totals.clicks >= 2);

    const theirs = await req(`/v1/profiles/${pid}/analytics`, {}, otherToken);
    assert.equal(theirs.status, 403);
  });

  test('rejects a malformed date range', async () => {
    const r = await req(`/v1/profiles/${pid}/analytics?from=yesterday`, {}, token);
    assert.equal(r.status, 400);
  });
});
