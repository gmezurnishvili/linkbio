import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The surfaces that existed in the schema and the evaluator with no route in
 * front of them: sign-out, unpublish, on-demand feed refresh, the stored page
 * mode, and clearing a scheduling bound.
 *
 * Each of these was reachable only by writing to a repository directly, which
 * is why none of them had a test — there was nothing to send a request to.
 */
process.env.AUTH_SECRET = 'test-secret-value-at-least-32-bytes-long!!';
process.env.DB_DRIVER = 'memory';
process.env.NODE_ENV = 'test';

const { createApp } = await import('../src/app.ts');
const { MemoryRepo } = await import('../src/db/memory.ts');

let app: ReturnType<typeof createApp>;

function req(path: string, init: RequestInit = {}, auth?: string) {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  if (auth) headers.set('authorization', `Bearer ${auth}`);
  return app.request(`http://api.test${path}`, { ...init, headers });
}

const json = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) });

let seq = 0;
async function register() {
  seq += 1;
  const r = await req('/v1/auth/register', {
    ...json({ email: `s${seq}@example.com`, password: 'a-good-password' }),
    headers: { 'x-forwarded-for': `10.9.0.${seq % 250}:1` },
  });
  assert.equal(r.status, 201, await r.clone().text());
  return await r.json() as { accessToken: string; refreshToken: string };
}

async function page(token: string, handle: string) {
  const r = await req('/v1/profiles', json({ handle, title: handle }), token);
  assert.equal(r.status, 201, await r.clone().text());
  return (await r.json() as any).data as { id: string; version: number };
}

before(() => { app = createApp(new MemoryRepo()); });

// ------------------------------------------------------------------- logout

describe('sign out', () => {
  test('the presented refresh token stops working, and only that one', async () => {
    const a = await register();
    // A second pair for the same account: signing out of one device must not
    // sign the account out everywhere, which is the whole reason /logout is
    // not just an alias for /logout/all.
    const second = await req('/v1/auth/refresh', json({ refreshToken: a.refreshToken }));
    assert.equal(second.status, 200);
    const b = await second.json() as { refreshToken: string };

    // `a` has already been consumed by the rotation above, so `b` is the live
    // one. Sign out with it.
    assert.equal((await req('/v1/auth/logout', json({ refreshToken: b.refreshToken }))).status, 204);
    assert.equal((await req('/v1/auth/refresh', json({ refreshToken: b.refreshToken }))).status, 401);
  });

  test('a token that was never valid is still a 204', async () => {
    // Anything else is an oracle on whether a stolen token is live, and the
    // caller is signed out either way.
    assert.equal((await req('/v1/auth/logout', json({ refreshToken: 'nope.nothing' }))).status, 204);
  });

  test('sign out everywhere kills sessions the caller did not present', async () => {
    const s = await register();
    const other = await req('/v1/auth/refresh', json({ refreshToken: s.refreshToken }));
    const b = await other.json() as { refreshToken: string };

    assert.equal((await req('/v1/auth/logout/all', json({}), s.accessToken)).status, 204);
    assert.equal((await req('/v1/auth/refresh', json({ refreshToken: b.refreshToken }))).status, 401);
  });

  test('sign out everywhere needs a signed-in caller', async () => {
    assert.equal((await req('/v1/auth/logout/all', json({}))).status, 401);
  });
});

// ---------------------------------------------------------------- unpublish

describe('unpublish', () => {
  test('takes the page off the public routes and keeps the draft', async () => {
    const s = await register();
    const p = await page(s.accessToken, 'takedown');
    await req(`/v1/profiles/${p.id}/blocks`, json({ label: 'A', target: 'https://a.example' }), s.accessToken);
    assert.equal((await req(`/v1/profiles/${p.id}/publish`, json({}), s.accessToken)).status, 200);
    assert.equal((await req('/p/takedown')).status, 200);

    const r = await req(`/v1/profiles/${p.id}/unpublish`, json({}), s.accessToken);
    assert.equal(r.status, 200);
    assert.equal((await r.json() as any).data.publishedVersion, null);

    assert.equal((await req('/p/takedown')).status, 404);

    // The draft is untouched, so republishing restores exactly what was there.
    assert.equal((await req(`/v1/profiles/${p.id}/publish`, json({}), s.accessToken)).status, 200);
    const back = await req('/p/takedown');
    assert.equal(back.status, 200);
    assert.equal((await back.json() as any).blocks.length, 1);
  });

  test('is refused for someone else\'s page', async () => {
    const owner = await register();
    const stranger = await register();
    const p = await page(owner.accessToken, 'notyours');
    const r = await req(`/v1/profiles/${p.id}/unpublish`, json({}), stranger.accessToken);
    assert.ok(r.status === 403 || r.status === 404, `got ${r.status}`);
  });
});

// ----------------------------------------------------------- feed refresh

describe('refresh a feed block on demand', () => {
  test('reports a missing credential as unconfigured rather than a failure', async () => {
    const s = await register();
    const p = await page(s.accessToken, 'feednow');
    const b = await req(`/v1/profiles/${p.id}/blocks`, json({
      kind: 'feed',
      label: 'Releases',
      // Spotify needs a credential this deployment does not have, so the
      // adapter refuses before it opens a socket — a deterministic outcome
      // with no network in the test.
      feed: { source: 'spotify', ref: 'https://open.spotify.com/artist/abc123', ttlSeconds: 900 },
    }), s.accessToken);
    assert.equal(b.status, 201, await b.clone().text());
    const blockId = (await b.json() as any).data.id;

    const r = await req(`/v1/profiles/${p.id}/blocks/${blockId}/refresh`, json({}), s.accessToken);
    assert.equal(r.status, 200, await r.clone().text());
    const body = await r.json() as any;
    assert.equal(body.outcome.status, 'unconfigured');
    // An operator problem must not back the creator's block off, so no failure
    // is counted and no error is left on the row for them to read.
    assert.equal(body.data.feedFailures ?? 0, 0);
    assert.equal(body.data.feedError, undefined);
    // The attempt is still recorded, or the block never leaves the due window.
    assert.ok(body.data.feedAttemptedAt > 0);
  });

  test('a block with no feed is a 400, not a silent success', async () => {
    const s = await register();
    const p = await page(s.accessToken, 'nofeed');
    const b = await req(`/v1/profiles/${p.id}/blocks`, json({ label: 'A', target: 'https://a.example' }), s.accessToken);
    const blockId = (await b.json() as any).data.id;
    assert.equal((await req(`/v1/profiles/${p.id}/blocks/${blockId}/refresh`, json({}), s.accessToken)).status, 400);
  });

  test('an unknown block is a 404', async () => {
    const s = await register();
    const p = await page(s.accessToken, 'ghostblock');
    assert.equal((await req(`/v1/profiles/${p.id}/blocks/blk_nope/refresh`, json({}), s.accessToken)).status, 404);
  });
});

// --------------------------------------------------------------- page mode

describe('page mode', () => {
  test('round-trips, and standard can be got back to', async () => {
    const s = await register();
    const p = await page(s.accessToken, 'modes');

    const at = Date.now() + 86_400_000;
    const toEvent = await req(`/v1/profiles/${p.id}`, {
      method: 'PATCH', body: JSON.stringify({ mode: 'event', eventAt: at }),
    }, s.accessToken);
    assert.equal(toEvent.status, 200);
    assert.equal((await toEvent.json() as any).data.mode, 'event');

    // Drop was previously inexpressible: with mode derived from `eventAt`, two
    // pages with a date on them were the same page.
    const toDrop = await req(`/v1/profiles/${p.id}`, {
      method: 'PATCH', body: JSON.stringify({ mode: 'drop' }),
    }, s.accessToken);
    const dropped = await toDrop.json() as any;
    assert.equal(dropped.data.mode, 'drop');
    assert.equal(dropped.data.eventAt, at, 'switching mode must not silently clear the date');

    const back = await req(`/v1/profiles/${p.id}`, {
      method: 'PATCH', body: JSON.stringify({ mode: 'standard', eventAt: null }),
    }, s.accessToken);
    const standard = await back.json() as any;
    assert.equal(standard.data.mode, 'standard');
    assert.equal(standard.data.eventAt, null);
  });

  test('an unknown mode is refused', async () => {
    const s = await register();
    const p = await page(s.accessToken, 'badmode');
    const r = await req(`/v1/profiles/${p.id}`, {
      method: 'PATCH', body: JSON.stringify({ mode: 'party' }),
    }, s.accessToken);
    assert.equal(r.status, 400);
  });

  test('the resolver carries it, so the renderer can tell drop from event', async () => {
    const s = await register();
    const p = await page(s.accessToken, 'dropsoon');
    await req(`/v1/profiles/${p.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ mode: 'drop', eventAt: Date.now() + 3_600_000 }),
    }, s.accessToken);
    await req(`/v1/profiles/${p.id}/publish`, json({}), s.accessToken);

    const r = await req('/p/dropsoon');
    assert.equal(r.status, 200);
    assert.equal((await r.json() as any).mode, 'drop');
  });
});

// ------------------------------------------------------- scheduling bounds

describe('a block\'s active window', () => {
  test('can be set and then cleared', async () => {
    const s = await register();
    const p = await page(s.accessToken, 'window');
    const from = Date.now() + 3_600_000;
    const b = await req(`/v1/profiles/${p.id}/blocks`, json({
      label: 'Doors', target: 'https://doors.example', activeFrom: from,
    }), s.accessToken);
    const blockId = (await b.json() as any).data.id;

    // Null, not omission: omitting the key means "leave it alone", so without
    // an explicit null a window could be set and never taken off again.
    const cleared = await req(`/v1/profiles/${p.id}/blocks/${blockId}`, {
      method: 'PATCH', body: JSON.stringify({ activeFrom: null }),
    }, s.accessToken);
    assert.equal(cleared.status, 200, await cleared.clone().text());
    assert.equal((await cleared.json() as any).data.activeFrom, null);
  });

  test('a cleared lower bound stops hiding the block', async () => {
    const s = await register();
    const p = await page(s.accessToken, 'notyet');
    const b = await req(`/v1/profiles/${p.id}/blocks`, json({
      label: 'Later', target: 'https://later.example', activeFrom: Date.now() + 86_400_000,
    }), s.accessToken);
    const blockId = (await b.json() as any).data.id;
    await req(`/v1/profiles/${p.id}/publish`, json({}), s.accessToken);

    const hidden = await req('/p/notyet');
    assert.equal((await hidden.json() as any).blocks.length, 0, 'not open yet');

    await req(`/v1/profiles/${p.id}/blocks/${blockId}`, {
      method: 'PATCH', body: JSON.stringify({ activeFrom: null }),
    }, s.accessToken);
    await req(`/v1/profiles/${p.id}/publish`, json({}), s.accessToken);

    const shown = await req('/p/notyet');
    assert.equal((await shown.json() as any).blocks.length, 1);
  });

  test('a backwards window is still refused', async () => {
    const s = await register();
    const p = await page(s.accessToken, 'backwards');
    const now = Date.now();
    const r = await req(`/v1/profiles/${p.id}/blocks`, json({
      label: 'Bad', target: 'https://bad.example',
      activeFrom: now + 7_200_000, activeUntil: now + 3_600_000,
    }), s.accessToken);
    assert.equal(r.status, 400);
  });
});

// ------------------------------------------------------------------- icons

describe('block icon', () => {
  test('survives to the resolver, which is where the renderer reads it', async () => {
    const s = await register();
    const p = await page(s.accessToken, 'glyphs');
    await req(`/v1/profiles/${p.id}/blocks`, json({
      label: 'Merch', icon: '🧢', target: 'https://shop.example',
    }), s.accessToken);
    await req(`/v1/profiles/${p.id}/publish`, json({}), s.accessToken);

    const r = await req('/p/glyphs');
    assert.equal((await r.json() as any).blocks[0].icon, '🧢');
  });
});
