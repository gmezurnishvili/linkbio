import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';

process.env.DEV_JWT_SECRET = 'test-secret-value-at-least-32-bytes-long!!';
process.env.DB_DRIVER = 'memory';

const { createApp } = await import('../src/app.ts');
const { MemoryRepo } = await import('../src/db/memory.ts');
const { rankBetween, initialRanks } = await import('../src/rank.ts');
const { deriveMask } = await import('../src/publish.ts');

let app: ReturnType<typeof createApp>;
let token: string;
let otherToken: string;

async function sign(sub: string) {
  return new SignJWT({ scope: 'profiles:write' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.DEV_JWT_SECRET!));
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

// ---------------------------------------------------------------- rank

describe('fractional ranking', () => {
  test('midpoint lands strictly between neighbours', () => {
    const a = rankBetween(null, null);
    const b = rankBetween(a, null);
    const mid = rankBetween(a, b);
    assert.ok(a < mid && mid < b, `${a} < ${mid} < ${b}`);
  });

  test('survives repeated subdivision at the same spot', () => {
    let lo = rankBetween(null, null);
    const hi = rankBetween(lo, null);
    for (let i = 0; i < 200; i++) {
      const next = rankBetween(lo, hi);
      assert.ok(lo < next && next < hi, `iteration ${i}: ${lo} < ${next} < ${hi}`);
      lo = next;
    }
  });

  test('initial ranks are ascending', () => {
    const r = initialRanks(10);
    assert.deepEqual(r, [...r].sort());
  });

  test('rejects inverted bounds', () => {
    assert.throws(() => rankBetween('b', 'a'), RangeError);
  });
});

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
});

// ---------------------------------------------------------------- profiles

describe('profiles', () => {
  test('creates a profile and claims the handle', async () => {
    const r = await req('/v1/profiles', json({ handle: 'alice', title: 'Alice' }), token);
    assert.equal(r.status, 201);
    const p = await r.json() as any;
    assert.equal(p.handle, 'alice');
    assert.equal(p.version, 1);
  });

  test('a second claim on the same handle conflicts', async () => {
    const r = await req('/v1/profiles', json({ handle: 'alice', title: 'Impostor' }), otherToken);
    assert.equal(r.status, 409);
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

  test('renaming frees the old handle', async () => {
    const list = await (await req('/v1/profiles', {}, token)).json() as any;
    const id = list.profiles[0].id;
    const r = await req(`/v1/profiles/${id}/handle`, {
      method: 'PUT', body: JSON.stringify({ handle: 'alicia' }),
    }, token);
    assert.equal(r.status, 200);
    assert.equal((await r.json() as any).handle, 'alicia');

    const reclaim = await req('/v1/profiles', json({ handle: 'alice', title: 'Bob' }), otherToken);
    assert.equal(reclaim.status, 201);
  });
});

// ---------------------------------------------------------------- blocks

describe('blocks', () => {
  let pid: string;

  before(async () => {
    const r = await req('/v1/profiles', json({ handle: 'carol', title: 'Carol' }), token);
    pid = (await r.json() as any).id;
  });

  const mkBlock = (label: string, target: string) =>
    req(`/v1/profiles/${pid}/blocks`, json({ label, target }), token);

  test('creates blocks in append order', async () => {
    for (const n of ['one', 'two', 'three']) {
      const r = await mkBlock(n, `https://example.com/${n}`);
      assert.equal(r.status, 201);
    }
    const { blocks } = await (await req(`/v1/profiles/${pid}/blocks`, {}, token)).json() as any;
    assert.deepEqual(blocks.map((b: { label: string }) => b.label), ['one', 'two', 'three']);
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
    assert.deepEqual(after.blocks.map((b: { label: string }) => b.label), ['three', 'one', 'two']);

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
    pid = (await r.json() as any).id;
    const b = await req(`/v1/profiles/${pid}/blocks`,
      json({ label: 'store', target: 'https://store.example' }), token);
    blockId = (await b.json() as any).id;
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
    pid = (await r.json() as any).id;
    const b = await req(`/v1/profiles/${pid}/blocks`,
      json({ label: 'shop', target: 'https://shop.example' }), token);
    blockId = (await b.json() as any).id;
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

  test('a stale edge mask version forces no-store', async () => {
    const r = await req(`/r/erin/${blockId}`, { headers: { 'x-ctx': 'v1|eu.d.dir.en.0' } });
    assert.equal(r.headers.get('cache-control'), 'no-store');
  });

  test('scheduled block hides before activation and caps the TTL', async () => {
    const soon = Date.now() + 120_000;
    const b = await req(`/v1/profiles/${pid}/blocks`,
      json({ label: 'drop', target: 'https://drop.example', activeFrom: soon }), token);
    const id = (await b.json() as any).id;

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
  });
});

// ---------------------------------------------------------------- analytics

describe('analytics', () => {
  let pid: string;

  before(async () => {
    const r = await req('/v1/profiles', json({ handle: 'frank', title: 'Frank' }), token);
    pid = (await r.json() as any).id;
  });

  test('accepts a beacon batch without auth', async () => {
    const r = await req('/v1/events', json({
      events: [{ handle: 'frank', blockId: 'blk_1', ts: Date.now() }],
    }));
    assert.equal(r.status, 202);
  });

  test('clamps an out-of-range timestamp into today', async () => {
    await req('/v1/events', json({
      events: [{ handle: 'frank', blockId: 'blk_2', ts: 1 }],
    }));
    const r = await req(`/v1/profiles/${pid}/analytics`, {}, token);
    const body = await r.json() as any;
    const today = new Date().toISOString().slice(0, 10);
    assert.ok(body.daily.every((d: { date: string }) => d.date === today));
  });

  test('rejects an oversized batch', async () => {
    const r = await req('/v1/events', json({
      events: Array.from({ length: 51 }, () => ({ handle: 'frank', ts: Date.now() })),
    }));
    assert.equal(r.status, 400);
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
