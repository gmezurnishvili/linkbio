import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The surface that did not exist when `api.test.ts` was written: registration
 * and token rotation, `/v1/me`, handle availability, publish gating, the
 * preview trace, the two kinds of 409, the events endpoint's new refusals, and
 * the validation that a PATCH used to slip past.
 *
 * It lives in its own file because it needs its own configuration, and
 * `src/env.ts` is parsed exactly once per process: `MAX_BLOCKS` is small so the
 * block-limit conflict costs six requests instead of two hundred, and
 * `EVENTS_PER_MINUTE` is small so the beacon throttle can be reached at all.
 * Each test that cares about a per-address counter sends its own
 * `x-forwarded-for`, so one test cannot spend another's budget.
 */
process.env.AUTH_SECRET = 'test-secret-value-at-least-32-bytes-long!!';
process.env.DB_DRIVER = 'memory';
process.env.NODE_ENV = 'test';
process.env.MAX_BLOCKS = '5';
process.env.EVENTS_PER_MINUTE = '4';

const { createApp } = await import('../src/app.ts');
const { MemoryRepo } = await import('../src/db/memory.ts');
const { env } = await import('../src/env.ts');

let app: ReturnType<typeof createApp>;

function req(path: string, init: RequestInit = {}, auth?: string) {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  if (auth) headers.set('authorization', `Bearer ${auth}`);
  return app.request(`http://api.test${path}`, { ...init, headers });
}

const json = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) });

/** A real registration, so `/v1/me` and the refresh flow have a user to find. */
let seq = 0;
async function register(email?: string) {
  seq += 1;
  const addr = `10.0.0.${seq % 250}:1234`;
  const r = await req('/v1/auth/register', {
    ...json({ email: email ?? `person${seq}@example.com`, password: 'a-good-password' }),
    // The credential endpoints throttle per client address; a fresh one per
    // registration keeps these tests from throttling each other.
    headers: { 'x-forwarded-for': addr },
  });
  assert.equal(r.status, 201, `register failed: ${await r.clone().text()}`);
  return { ...(await r.json() as any), addr } as
    { accessToken: string; refreshToken: string; expiresIn: number; addr: string };
}

async function makeProfile(token: string, handle: string, title = handle) {
  const r = await req('/v1/profiles', json({ handle, title }), token);
  assert.equal(r.status, 201, `profile create failed: ${await r.clone().text()}`);
  return (await r.json() as any).data as { id: string; handle: string; version: number };
}

async function makeBlock(token: string, pid: string, body: Record<string, unknown>) {
  const r = await req(`/v1/profiles/${pid}/blocks`, json(body), token);
  assert.equal(r.status, 201, `block create failed: ${await r.clone().text()}`);
  return (await r.json() as any).data as { id: string };
}

before(() => { app = createApp(new MemoryRepo()); });

// ---------------------------------------------------------------- auth flow

describe('register, token and refresh', () => {
  test('register issues a usable access token', async () => {
    const s = await register('newcomer@example.com');
    assert.ok(s.accessToken && s.refreshToken);
    assert.equal(s.expiresIn, env.accessTtlSeconds);
    assert.equal((await req('/v1/profiles', {}, s.accessToken)).status, 200);
  });

  test('registering the same email twice conflicts', async () => {
    const r = await req('/v1/auth/register', {
      ...json({ email: 'newcomer@example.com', password: 'a-good-password' }),
      headers: { 'x-forwarded-for': '10.1.0.1:1' },
    });
    assert.equal(r.status, 409);
    assert.equal((await r.json() as any).title, 'conflict');
  });

  test('a short password is refused', async () => {
    const r = await req('/v1/auth/register', {
      ...json({ email: 'short@example.com', password: 'tiny' }),
      headers: { 'x-forwarded-for': '10.1.0.2:1' },
    });
    assert.equal(r.status, 400);
  });

  test('the right password gets a token, the wrong one does not', async () => {
    const ok = await req('/v1/auth/token', {
      ...json({ email: 'newcomer@example.com', password: 'a-good-password' }),
      headers: { 'x-forwarded-for': '10.1.0.3:1' },
    });
    assert.equal(ok.status, 200);
    assert.ok((await ok.json() as any).accessToken);

    const bad = await req('/v1/auth/token', {
      ...json({ email: 'newcomer@example.com', password: 'not-the-password' }),
      headers: { 'x-forwarded-for': '10.1.0.3:1' },
    });
    assert.equal(bad.status, 401);
  });

  test('an unknown account fails the same way as a wrong password', async () => {
    const r = await req('/v1/auth/token', {
      ...json({ email: 'ghost@example.com', password: 'a-good-password' }),
      headers: { 'x-forwarded-for': '10.1.0.4:1' },
    });
    assert.equal(r.status, 401);
    // The message must not say whether the email is registered.
    assert.equal((await r.json() as any).detail, 'email or password is wrong');
  });

  test('refresh rotates: the new token works, the old one does not', async () => {
    const s = await register();
    const r = await req('/v1/auth/refresh', json({ refreshToken: s.refreshToken }));
    assert.equal(r.status, 200);
    const next = await r.json() as any;
    assert.notEqual(next.refreshToken, s.refreshToken, 'refresh must rotate');
    assert.equal((await req('/v1/profiles', {}, next.accessToken)).status, 200);

    const again = await req('/v1/auth/refresh', json({ refreshToken: next.refreshToken }));
    assert.equal(again.status, 200, 'the rotated token is usable once');
  });

  /**
   * A second use of a token that was already rotated away is the signal that
   * one leaked, so every session for that user goes with it.
   */
  test('reusing a spent refresh token revokes every session for that user', async () => {
    const s = await register();
    const rotated = await (await req('/v1/auth/refresh', json({ refreshToken: s.refreshToken }))).json() as any;

    // Replay the spent one.
    const replay = await req('/v1/auth/refresh', json({ refreshToken: s.refreshToken }));
    assert.equal(replay.status, 401);

    // The live token minted a moment ago is gone too.
    const after = await req('/v1/auth/refresh', json({ refreshToken: rotated.refreshToken }));
    assert.equal(after.status, 401, 'the reuse should have revoked every outstanding token');
  });

  test('a malformed refresh token is refused', async () => {
    const r = await req('/v1/auth/refresh', json({ refreshToken: 'not-a-real-token-at-all' }));
    assert.equal(r.status, 401);
  });
});

// ---------------------------------------------------------------- /v1/me

describe('/v1/me', () => {
  test('returns the signed-in user and their profiles in one call', async () => {
    const s = await register('mine@example.com');
    const p = await makeProfile(s.accessToken, 'mine');

    const r = await req('/v1/me', {}, s.accessToken);
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.email, 'mine@example.com');
    assert.ok(body.userId);
    assert.deepEqual(body.profiles.map((x: { id: string }) => x.id), [p.id]);
    assert.deepEqual(body.profiles[0].cacheDimensions, []);
    assert.equal('passwordHash' in body, false, 'the password hash must never leave the server');
  });

  test('requires a token', async () => {
    assert.equal((await req('/v1/me')).status, 401);
  });
});

// ---------------------------------------------------------------- handle availability

describe('GET /v1/handles/:handle', () => {
  let token: string;
  let pid: string;

  before(async () => {
    const s = await register('handles@example.com');
    token = s.accessToken;
    pid = (await makeProfile(token, 'taken-one')).id;
  });

  test('a free handle is available', async () => {
    assert.deepEqual(await (await req('/v1/handles/wide-open')).json(), { available: true });
  });

  test('a taken handle is not', async () => {
    assert.deepEqual(await (await req('/v1/handles/taken-one')).json(), {
      available: false, reason: 'taken',
    });
  });

  test('a reserved handle says so, rather than pretending it is taken', async () => {
    assert.deepEqual(await (await req('/v1/handles/admin')).json(), {
      available: false, reason: 'reserved',
    });
    assert.deepEqual(await (await req('/v1/handles/health')).json(), {
      available: false, reason: 'reserved',
    });
  });

  test('a malformed handle is invalid', async () => {
    for (const h of ['a', 'has.a.dot', '-leading', 'trailing-']) {
      assert.deepEqual(await (await req(`/v1/handles/${h}`)).json(), {
        available: false, reason: 'invalid',
      }, `expected ${h} to be invalid`);
    }
  });

  test('a renamed-away handle reads as tombstoned', async () => {
    const r = await req(`/v1/profiles/${pid}/handle`, json({ handle: 'taken-two' }), token);
    assert.equal(r.status, 200);
    assert.deepEqual(await (await req('/v1/handles/taken-one')).json(), {
      available: false, reason: 'tombstoned',
    });
    assert.deepEqual(await (await req('/v1/handles/taken-two')).json(), {
      available: false, reason: 'taken',
    });
  });

  // It is a property of the namespace, not of a profile — checking one during
  // signup has to work before any profile exists.
  test('needs no authentication', async () => {
    assert.equal((await req('/v1/handles/wide-open')).status, 200);
  });
});

// ---------------------------------------------------------------- publish gating

describe('publish gates the public routes', () => {
  let token: string;
  let pid: string;
  let blockId: string;

  before(async () => {
    const s = await register('publisher@example.com');
    token = s.accessToken;
    pid = (await makeProfile(token, 'draft')).id;
    blockId = (await makeBlock(token, pid, { label: 'go', target: 'https://go.example' })).id;
  });

  test('an unpublished page 404s everywhere public', async () => {
    for (const path of [`/p/draft`, `/r/draft/${blockId}`]) {
      const r = await req(path);
      assert.equal(r.status, 404, `${path} should 404 while unpublished`);
      assert.equal(r.headers.get('content-type'), 'application/problem+json');
    }
    const resolve = await req('/v1/public/draft/resolve', json({ device: 'mobile' }));
    assert.equal(resolve.status, 404);
  });

  test('the owner can still see the draft', async () => {
    const r = await req(`/v1/profiles/${pid}`, {}, token);
    assert.equal(r.status, 200);
    assert.equal((await r.json() as any).publishedVersion, null);
  });

  test('publishing records the version and opens the public routes', async () => {
    const current = (await (await req(`/v1/profiles/${pid}`, {}, token)).json() as any).version;
    const pub = await req(`/v1/profiles/${pid}/publish`, { method: 'POST' }, token);
    assert.equal(pub.status, 200);
    const body = await pub.json() as any;
    // Publishing bumps the version as part of the same write, so the version
    // recorded as published is the one the publish produced. Recording the
    // version we read left publishedVersion permanently one behind, and the
    // editor permanently claiming there were unpublished changes.
    assert.equal(body.data.publishedVersion, current + 1);
    assert.equal(body.data.version, body.data.publishedVersion);

    assert.equal((await req('/p/draft')).status, 200);
    assert.equal((await req(`/r/draft/${blockId}`)).status, 302);
    assert.equal((await req('/v1/public/draft/resolve', json({ device: 'mobile' }))).status, 200);
  });

  test('a later draft edit does not unpublish the page', async () => {
    await req(`/v1/profiles/${pid}`, {
      method: 'PATCH', body: JSON.stringify({ title: 'Renamed' }),
    }, token);
    const r = await req('/p/draft');
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.published, true);
    assert.equal(body.title, 'Renamed');
  });

  test('the resolve endpoint only counts the dimensions the caller supplied', async () => {
    await req(`/v1/profiles/${pid}/blocks/${blockId}/rules`, {
      method: 'PUT',
      body: JSON.stringify([{
        id: 'eu', priority: 10,
        when: [{ dim: 'geo', in: ['eu'] }],
        then: { kind: 'redirect', target: 'https://go.example/eu', status: 302 },
      }]),
    }, token);

    const withGeo = await (await req('/v1/public/draft/resolve', json({ geo: 'eu' }))).json() as any;
    assert.equal(withGeo.cacheable, true);
    assert.equal(withGeo.blocks[0].target, 'https://go.example/eu');

    // The caller stated a context that says nothing about geo, so the block's
    // geo rule is not covered and the answer cannot be cached.
    const withoutGeo = await (await req('/v1/public/draft/resolve', json({ device: 'mobile' }))).json() as any;
    assert.equal(withoutGeo.cacheable, false);
    assert.ok(withoutGeo.warnings.some((w: string) => w.includes('geo')));
  });

  test('the caller owns the caching decision on resolve', async () => {
    const r = await req('/v1/public/draft/resolve', json({ geo: 'eu' }));
    assert.equal(r.headers.get('cache-control'), 'no-store');
  });
});

// ---------------------------------------------------------------- preview

describe('preview', () => {
  let token: string;
  let pid: string;
  let blockId: string;

  before(async () => {
    const s = await register('previewer@example.com');
    token = s.accessToken;
    pid = (await makeProfile(token, 'previewme')).id;
    blockId = (await makeBlock(token, pid, { label: 'shop', target: 'https://shop.example' })).id;
    await req(`/v1/profiles/${pid}/blocks/${blockId}/rules`, {
      method: 'PUT',
      body: JSON.stringify([{
        id: 'eu', priority: 10,
        when: [{ dim: 'geo', in: ['eu'] }],
        then: { kind: 'redirect', target: 'https://shop.example/eu', status: 302 },
      }]),
    }, token);
  });

  test('returns a trace saying why each block resolved as it did', async () => {
    const r = await req(`/v1/profiles/${pid}/preview`, json({ geo: 'eu' }), token);
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.ok(Array.isArray(body.trace), 'preview must carry a trace');
    const entry = body.trace.find((t: { blockId: string }) => t.blockId === blockId);
    assert.equal(entry.ruleId, 'eu');
    assert.equal(entry.action, 'redirect');
    assert.match(entry.reason, /eu/);
    assert.equal(body.blocks[0].target, 'https://shop.example/eu');
  });

  test('a viewer no rule matches falls through to the default, with a reason', async () => {
    const body = await (await req(`/v1/profiles/${pid}/preview`, json({ geo: 'na' }), token)).json() as any;
    const entry = body.trace.find((t: { blockId: string }) => t.blockId === blockId);
    assert.equal(entry.ruleId, null);
    assert.match(entry.reason, /no rule matched/);
  });

  // Preview reads unpublished state — that is the whole point of it.
  test('works on a page that has never been published', async () => {
    assert.equal((await req('/p/previewme')).status, 404);
    assert.equal((await req(`/v1/profiles/${pid}/preview`, json({}), token)).status, 200);
  });

  test('time travel moves the clock for scheduled blocks', async () => {
    const soon = Date.now() + 3_600_000;
    const later = await makeBlock(token, pid, {
      label: 'drop', target: 'https://drop.example', activeFrom: soon,
    });

    const now = await (await req(`/v1/profiles/${pid}/preview`, json({}), token)).json() as any;
    assert.ok(!now.blocks.some((b: { id: string }) => b.id === later.id), 'hidden before activation');

    const future = await (await req(`/v1/profiles/${pid}/preview`,
      json({ at: soon + 60_000 }), token)).json() as any;
    assert.ok(future.blocks.some((b: { id: string }) => b.id === later.id), 'visible after activation');
  });

  test('is owner-only', async () => {
    const other = await register('nosy@example.com');
    const r = await req(`/v1/profiles/${pid}/preview`, json({}), other.accessToken);
    assert.equal(r.status, 403);
  });
});

// ---------------------------------------------------------------- the two 409s

describe('conflicts are distinguishable', () => {
  let token: string;
  let pid: string;

  before(async () => {
    const s = await register('conflicted@example.com');
    token = s.accessToken;
    pid = (await makeProfile(token, 'conflicted')).id;
  });

  /**
   * Both are 409, and they used to be indistinguishable — so the editor raised
   * "this page changed somewhere else" when a creator simply hit the block
   * limit. The client reacts differently to each, so the `title` has to differ.
   */
  test('a stale If-Match is a version_conflict carrying the current version', async () => {
    const version = (await (await req(`/v1/profiles/${pid}`, {}, token)).json() as any).version;
    const r = await req(`/v1/profiles/${pid}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: 'Nope' }),
      headers: { 'if-match': String(version - 1) },
    }, token);

    assert.equal(r.status, 409);
    assert.equal(r.headers.get('content-type'), 'application/problem+json');
    const body = await r.json() as any;
    assert.equal(body.title, 'version_conflict');
    assert.equal(body.current, version);
    // And nothing was written.
    assert.notEqual((await (await req(`/v1/profiles/${pid}`, {}, token)).json() as any).title, 'Nope');
  });

  test('a matching If-Match goes through', async () => {
    const version = (await (await req(`/v1/profiles/${pid}`, {}, token)).json() as any).version;
    const r = await req(`/v1/profiles/${pid}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: 'Yes' }),
      headers: { 'if-match': String(version) },
    }, token);
    assert.equal(r.status, 200);
    assert.equal((await r.json() as any).data.title, 'Yes');
  });

  test('a malformed If-Match is a client bug, not a silently ignored header', async () => {
    const r = await req(`/v1/profiles/${pid}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: 'Hmm' }),
      headers: { 'if-match': 'W/"not-a-number"' },
    }, token);
    assert.equal(r.status, 400);
  });

  test('a stale If-Match on a block write is also a version_conflict', async () => {
    const r = await req(`/v1/profiles/${pid}/blocks`, {
      ...json({ label: 'x', target: 'https://x.example' }),
      headers: { 'if-match': '1' },
    }, token);
    assert.equal(r.status, 409);
    const body = await r.json() as any;
    assert.equal(body.title, 'version_conflict');
    assert.ok(Number.isInteger(body.current));
  });

  test('the block limit is a plain conflict, with no current version', async () => {
    const limited = await makeProfile(token, 'limited');
    for (let i = 0; i < env.maxBlocks; i++) {
      await makeBlock(token, limited.id, { label: `b${i}`, target: `https://e.example/${i}` });
    }
    const over = await req(`/v1/profiles/${limited.id}/blocks`,
      json({ label: 'one too many', target: 'https://e.example/x' }), token);

    assert.equal(over.status, 409);
    const body = await over.json() as any;
    assert.equal(body.title, 'conflict');
    assert.equal('current' in body, false, 'a block-limit conflict is not a reload-and-retry');
    assert.match(body.detail, /block limit/);
  });

  test('a duplicate handle claim is a plain conflict too', async () => {
    const other = await register('rival@example.com');
    const r = await req('/v1/profiles', json({ handle: 'conflicted', title: 'Rival' }), other.accessToken);
    assert.equal(r.status, 409);
    assert.equal((await r.json() as any).title, 'conflict');
  });
});

// ---------------------------------------------------------------- events refusals

describe('the events beacon refuses three new things', () => {
  let token: string;
  let pid: string;
  let blockId: string;

  before(async () => {
    const s = await register('beacon@example.com');
    token = s.accessToken;
    pid = (await makeProfile(token, 'beacon')).id;
    blockId = (await makeBlock(token, pid, { label: 'b', target: 'https://b.example' })).id;
  });

  const post = (body: unknown, addr: string) =>
    req('/v1/events', { ...json(body), headers: { 'x-forwarded-for': addr } });

  const stats = async () =>
    await (await req(`/v1/profiles/${pid}/analytics`, {}, token)).json() as any;

  // Each handle in a batch is a profile lookup, so 50 handles was 100
  // unauthenticated reads for one request.
  test('a batch spanning more than four handles is a 400', async () => {
    const five = ['beacon', 'h2', 'h3', 'h4', 'h5'].map((handle) => ({ handle, ts: Date.now() }));
    const r = await post({ events: five }, '10.9.0.1:1');
    assert.equal(r.status, 400);
    assert.match((await r.json() as any).detail, /too many handles/);

    const four = five.slice(0, 4);
    assert.equal((await post({ events: four }, '10.9.0.2:1')).status, 202);
  });

  test('an event for a block that is not on the profile is dropped, not counted', async () => {
    const before = await stats();
    const r = await post({
      events: [
        { handle: 'beacon', blockId, ts: Date.now() },
        { handle: 'beacon', blockId: 'blk_made_up', ts: Date.now() },
      ],
    }, '10.9.0.3:1');
    assert.equal(r.status, 202, 'a dropped event is not a client error');

    const after = await stats();
    assert.equal(after.totals.clicks, before.totals.clicks + 1, 'only the real block counted');
    assert.equal(after.byBlock.blk_made_up, undefined);
    assert.equal(after.byBlock[blockId], (before.byBlock[blockId] ?? 0) + 1);
  });

  test('too many requests from one address is a 429', async () => {
    const addr = '10.9.9.9:1';
    const body = { events: [{ handle: 'beacon', blockId, ts: Date.now() }] };
    for (let i = 0; i < env.eventsPerMinute; i++) {
      assert.equal((await post(body, addr)).status, 202, `request ${i + 1} should be under the limit`);
    }
    const over = await post(body, addr);
    assert.equal(over.status, 429);
    assert.equal(over.headers.get('content-type'), 'application/problem+json');
    assert.equal((await over.json() as any).title, 'rate_limited');

    // The limit is per address, so another viewer is unaffected.
    assert.equal((await post(body, '10.9.9.10:1')).status, 202);
  });

  test('events for an unknown handle are ignored without erroring', async () => {
    const r = await post({ events: [{ handle: 'nobody-here', ts: Date.now() }] }, '10.9.0.4:1');
    assert.equal(r.status, 202);
  });
});

// ---------------------------------------------------------------- BlockPatch cross-field

describe('a PATCH is validated against the block it produces', () => {
  let token: string;
  let n = 0;

  before(async () => {
    token = (await register('patcher@example.com')).accessToken;
  });

  // A profile per case, because `MAX_BLOCKS` is deliberately tiny in this file
  // and these cases would otherwise spend each other's budget.
  const fresh = async () => {
    n += 1;
    return (await makeProfile(token, `patcher-${n}`)).id;
  };

  /**
   * `BlockPatch` used to be built with `.innerType()`, which unwraps the
   * ZodEffects carrying these checks — so a partial update was validated
   * against the patch alone and every cross-field rule was simply absent.
   */
  test('an activeUntil that lands before the stored activeFrom is a 400', async () => {
    const pid = await fresh();
    const from = Date.now() + 3_600_000;
    const b = await makeBlock(token, pid, {
      label: 'window', target: 'https://w.example', activeFrom: from, activeUntil: from + 3_600_000,
    });

    // The patch alone says nothing about activeFrom. Only the merged block is
    // contradictory, and only the merged block is checked.
    const r = await req(`/v1/profiles/${pid}/blocks/${b.id}`, {
      method: 'PATCH', body: JSON.stringify({ activeUntil: from - 1000 }),
    }, token);
    assert.equal(r.status, 400);
    assert.equal(r.headers.get('content-type'), 'application/problem+json');

    // ...and the block is untouched, so the window still exists.
    const { blocks } = await (await req(`/v1/profiles/${pid}/blocks`, {}, token)).json() as any;
    const stored = blocks.find((x: { id: string }) => x.id === b.id);
    assert.equal(stored.activeUntil, from + 3_600_000);
  });

  test('an inverted window sent in one patch is a 400 too', async () => {
    const pid = await fresh();
    const b = await makeBlock(token, pid, { label: 'plain', target: 'https://p.example' });
    const now = Date.now();
    const r = await req(`/v1/profiles/${pid}/blocks/${b.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ activeFrom: now + 2000, activeUntil: now + 1000 }),
    }, token);
    assert.equal(r.status, 400);
  });

  test('turning a block into a link without a target is a 400', async () => {
    const pid = await fresh();
    const b = await makeBlock(token, pid, { kind: 'header', label: 'Section' });
    const r = await req(`/v1/profiles/${pid}/blocks/${b.id}`, {
      method: 'PATCH', body: JSON.stringify({ kind: 'link' }),
    }, token);
    assert.equal(r.status, 400);
    // `/r/` would 404 for a link with no destination.
    assert.match(JSON.stringify(await r.json()), /target/);
  });

  test('turning a block into a feed without a feed config is a 400', async () => {
    const pid = await fresh();
    const b = await makeBlock(token, pid, { label: 'link', target: 'https://f.example' });
    const r = await req(`/v1/profiles/${pid}/blocks/${b.id}`, {
      method: 'PATCH', body: JSON.stringify({ kind: 'feed' }),
    }, token);
    assert.equal(r.status, 400);
  });

  test('a link block cannot have its target blanked out', async () => {
    const pid = await fresh();
    const b = await makeBlock(token, pid, { label: 'keep', target: 'https://k.example' });
    for (const target of [null, '', 'not-a-url']) {
      const r = await req(`/v1/profiles/${pid}/blocks/${b.id}`, {
        method: 'PATCH', body: JSON.stringify({ target }),
      }, token);
      assert.equal(r.status, 400, `target=${JSON.stringify(target)} should be refused`);
    }
  });

  test('a valid patch still goes through', async () => {
    const pid = await fresh();
    const b = await makeBlock(token, pid, { label: 'fine', target: 'https://fine.example' });
    const r = await req(`/v1/profiles/${pid}/blocks/${b.id}`, {
      method: 'PATCH', body: JSON.stringify({ label: 'renamed', hidden: true }),
    }, token);
    assert.equal(r.status, 200);
    const body = await r.json() as any;
    assert.equal(body.data.label, 'renamed');
    assert.equal(body.data.hidden, true);
    assert.equal(body.data.target, 'https://fine.example');
  });

  test('the same cross-field rules still apply on create', async () => {
    const pid = await fresh();
    const now = Date.now();
    const r = await req(`/v1/profiles/${pid}/blocks`, json({
      label: 'bad window', target: 'https://b.example',
      activeFrom: now + 2000, activeUntil: now + 1000,
    }), token);
    assert.equal(r.status, 400);
  });
});

// ---------------------------------------------------------------- SafeUrl

describe('SafeUrl refuses the host forms that resolve inward', () => {
  let token: string;
  let pid: string;

  before(async () => {
    const s = await register('urls@example.com');
    token = s.accessToken;
    pid = (await makeProfile(token, 'urls')).id;
  });

  const target = (url: string) =>
    req(`/v1/profiles/${pid}/blocks`, json({ label: 't', target: url }), token);

  const blocked: Array<[string, string]> = [
    ['IPv6 loopback', 'http://[::1]/'],
    ['the IPv6 unspecified address', 'http://[::]/'],
    ['an IPv6 unique-local address', 'http://[fd00::1]/'],
    ['another IPv6 ULA', 'http://[fc00::abcd]/'],
    ['an IPv6 link-local address', 'http://[fe80::1]/'],
    ['a decimal integer host', 'http://2130706433/'],
    ['an octal integer host', 'http://017700000001/'],
    ['a hex integer host', 'http://0x7f000001/'],
    ['an octal dotted-quad', 'http://0177.0.0.1/'],
    ['a hex dotted-quad', 'http://0x7f.0.0.1/'],
    ['the "this network" block', 'http://0.0.0.0/'],
    ['a bare zero host', 'http://0/'],
    ['0.0.0.0/8 generally', 'http://0.1.2.3/'],
    ['link-local metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['the rest of 169.254.0.0/16', 'http://169.254.42.7/'],
    ['CGNAT space', 'http://100.64.0.1/'],
    ['the top of CGNAT space', 'http://100.127.255.254/'],
    ['RFC1918 /8', 'http://10.1.2.3/'],
    ['RFC1918 /12', 'http://172.16.9.9/'],
    ['RFC1918 /16', 'http://192.168.1.1/'],
    ['plain loopback', 'http://127.0.0.1/'],
    ['localhost', 'http://localhost/'],
    ['a .internal name', 'http://db.internal/'],
    ['a .local name', 'http://printer.local/'],
    ['a non-http scheme', 'javascript:alert(1)'],
    ['file urls', 'file:///etc/passwd'],
  ];

  for (const [what, url] of blocked) {
    test(`rejects ${what}`, async () => {
      assert.equal((await target(url)).status, 400, `${url} should be refused`);
    });
  }

  /**
   * SOURCE BUG — see the report accompanying this change. `isPrivateHost`
   * matches a v4-mapped address with `/^::ffff:(\d+\.\d+\.\d+\.\d+)$/`, but
   * WHATWG URL parsing normalises the dotted tail to hex before the check ever
   * runs: `new URL('http://[::ffff:127.0.0.1]/').hostname` is
   * `'[::ffff:7f00:1]'`. The branch is therefore unreachable and both spellings
   * are accepted as public.
   *
   * The assertion below is the behaviour `schema.ts` documents, kept verbatim.
   * It is skipped rather than softened because the fix belongs in `src/`, which
   * this change does not touch — unskip it with the fix.
   */
  for (const url of ['http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/']) {
    test(`rejects the v4-mapped IPv6 form ${url}`, async () => {
      assert.equal((await target(url)).status, 400);
    });
  }

  test('still accepts an ordinary public https target', async () => {
    assert.equal((await target('https://example.com/shop?x=1')).status, 201);
  });

  test('applies to the avatar url as well as block targets', async () => {
    const r = await req('/v1/profiles', json({
      handle: 'avatarssrf', title: 'x', avatarUrl: 'http://169.254.169.254/latest/',
    }), token);
    assert.equal(r.status, 400);
  });

  test('applies to a rule\'s redirect target', async () => {
    const b = await makeBlock(token, pid, { label: 'r', target: 'https://ok.example' });
    const r = await req(`/v1/profiles/${pid}/blocks/${b.id}/rules`, {
      method: 'PUT',
      body: JSON.stringify([{
        id: 'x', priority: 1,
        when: [{ dim: 'geo', in: ['na'] }],
        then: { kind: 'redirect', target: 'http://[::1]/', status: 302 },
      }]),
    }, token);
    assert.equal(r.status, 400);
  });
});
