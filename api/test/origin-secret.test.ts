import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The gate in front of the function URL.
 *
 * The URL is `authType: NONE` — Origin Access Control cannot front a URL that
 * browsers POST to, because a signed request to a function URL must carry its
 * own body hash in `x-amz-content-sha256` and Lambda refuses
 * `UNSIGNED-PAYLOAD`. So the URL answers anyone who learns it, and the only
 * thing that makes learning it useless is a header CloudFront adds and a viewer
 * cannot. That makes this check the whole of the WAF's enforceability, which is
 * a reason to test it rather than assume it.
 *
 * Its own file because `src/env.ts` parses the environment once at import, so
 * the secret has to be set before the app is loaded — and every other suite
 * needs it unset.
 */
process.env.AUTH_SECRET = 'test-secret-value-at-least-32-bytes-long!!';
process.env.DB_DRIVER = 'memory';
process.env.NODE_ENV = 'test';
process.env.ORIGIN_SECRET = 'a-shared-secret-cloudfront-would-send';

const { createApp } = await import('../src/app.ts');
const { MemoryRepo } = await import('../src/db/memory.ts');

let app: ReturnType<typeof createApp>;

before(() => {
  app = createApp(new MemoryRepo());
});

const SECRET = 'a-shared-secret-cloudfront-would-send';

function req(path: string, init: RequestInit = {}) {
  return app.request(`http://api.test${path}`, init);
}

describe('the origin secret', () => {
  test('lets a request carrying it through', async () => {
    const r = await req('/health', { headers: { 'x-origin-secret': SECRET } });
    assert.equal(r.status, 200);
    assert.equal((await r.json() as { ok: boolean }).ok, true);
  });

  test('refuses a request without it', async () => {
    const r = await req('/health');
    assert.equal(r.status, 403);
  });

  test('refuses a wrong one, including a prefix of the real one', async () => {
    assert.equal((await req('/health', { headers: { 'x-origin-secret': 'nope' } })).status, 403);
    assert.equal(
      (await req('/health', { headers: { 'x-origin-secret': SECRET.slice(0, -1) } })).status,
      403,
    );
  });

  test('covers the public routes, not only the control plane', async () => {
    // `/r/` and `/p/` are the paths worth hammering — they are the ones that
    // would otherwise be a free, uncached, unrated path to the origin.
    for (const path of ['/p/anyone', '/r/anyone/blk', '/v1/auth/token', '/v1/events']) {
      assert.equal((await req(path)).status, 403, `${path} was reachable without the secret`);
    }
  });

  test('is checked before the body is read, so a large body cannot be used to do work', async () => {
    const r = await req('/v1/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: Array.from({ length: 50 }, () => ({ handle: 'x', ts: 1 })) }),
    });
    assert.equal(r.status, 403);
  });
});
