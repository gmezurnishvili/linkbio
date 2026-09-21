/**
 * Exercises the deployable artifact.
 *
 * `lambda/handler.mjs` is the one piece of this deployment that has no
 * equivalent in development: nothing about `next dev` or `next start` goes
 * through a Function URL event. Left untested it is the obvious place for the
 * first deploy to fail, and the failure — a 502 with nothing useful in the log
 * — looks like an infrastructure problem rather than a translation bug.
 *
 * So this boots the real `web/dist` against a stub API and invokes it the way
 * Lambda will. Run it after `npm run build:lambda`:
 *
 *     node --test test/lambda-handler.test.mjs
 *
 * It is deliberately not part of `npm test`, which must stay runnable without a
 * build.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = join(web, 'dist', 'handler.mjs');

if (!existsSync(bundle)) {
  console.error('web/dist is not built. Run `npm run build:lambda` first.');
  process.exit(1);
}

/**
 * What this particular bundle was built with.
 *
 * `NEXT_PUBLIC_SITE_ORIGIN` is inlined at build time, so whether the app uses
 * the forwarded viewer host or a configured origin is a property of the
 * artifact, not of the request. The bundle records it (see
 * `scripts/package-lambda.mjs`), so the assertion can follow rather than assume
 * — a test that only passes for one build mode is a test that fails on a
 * correct deploy.
 */
const stampPath = join(web, 'dist', '.build-stamp');
const BAKED_SITE_ORIGIN = existsSync(stampPath)
  ? JSON.parse(readFileSync(stampPath, 'utf8')).siteOrigin
  : null;

/** A published page with one link block and a geo rule, as the API would answer. */
const RESOLUTION = {
  handle: 'giorgi',
  title: 'Giorgi',
  bio: 'Testing the deployable artifact',
  version: 4,
  published: true,
  blocks: [
    {
      id: 'blk_1',
      kind: 'link',
      label: 'Shop',
      href: '/r/giorgi/blk_1',
      target: 'https://shop.example.com/intl',
    },
  ],
  sMaxAge: 3600,
  cacheable: true,
  varyOn: ['geo'],
  warnings: [],
};

const SECRET = 'what-cloudfront-would-add';

let api;
let apiCalls = [];
let handler;

before(async () => {
  api = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      apiCalls.push({ url: req.url, method: req.method, body, headers: req.headers });
      // Only `giorgi` exists, so an unclaimed handle really does 404 upstream.
      if (req.url === '/v1/public/giorgi/resolve') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(RESOLUTION));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ title: 'not_found', detail: 'no such page' }));
    });
  });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));

  process.env.API_ORIGIN = `http://127.0.0.1:${api.address().port}`;
  // Unset: signing is for the deployed function URL, and the stub is plain HTTP.
  delete process.env.API_AUTH_MODE;
  process.env.NEXT_SERVER_PORT = '31987';
  // The deployed function URL is reachable by anyone who learns it, so this
  // header is the whole of what keeps a direct hit from bypassing the WAF.
  process.env.ORIGIN_SECRET = SECRET;

  ({ handler } = await import(pathToFileURL(bundle).href));
});

after(async () => {
  await new Promise((r) => api.close(r));
  // Next's server keeps the loop alive; the assertions are done.
  setTimeout(() => process.exit(0), 50).unref();
});

/** The shape Lambda delivers for a Function URL request. */
function event(path, over = {}) {
  const [rawPath, rawQueryString = ''] = path.split('?');
  return {
    version: '2.0',
    rawPath,
    rawQueryString,
    headers: {
      'user-agent': 'node-test',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'links.example.com',
      'x-origin-secret': SECRET,
      ...over.headers,
    },
    requestContext: { http: { method: over.method ?? 'GET', path: rawPath } },
    ...(over.body === undefined ? {} : { body: over.body, isBase64Encoded: false }),
    ...(over.cookies ? { cookies: over.cookies } : {}),
  };
}

const text = (res) => Buffer.from(res.body, 'base64').toString('utf8');

describe('the web Lambda', () => {
  it('renders a published page, and always answers base64', async () => {
    apiCalls = [];
    const res = await handler(event('/giorgi', { headers: { 'x-ctx': 'v4|na.-.-.-.-' } }));

    assert.equal(res.statusCode, 200);
    assert.equal(res.isBase64Encoded, true);
    assert.match(res.headers['content-type'], /text\/html/);

    const html = text(res);
    assert.match(html, /Giorgi/);
    assert.match(html, /shop\.example\.com|\/r\/giorgi\/blk_1/);
  });

  it('sends the edge context to the API rather than re-deriving it from headers', async () => {
    apiCalls = [];
    await handler(
      event('/giorgi', {
        headers: {
          'x-ctx': 'v4|eu.-.-.-.-',
          // Deliberately contradicts the edge's answer. The key was built from
          // x-ctx, so x-ctx is what the origin must resolve against.
          'cloudfront-viewer-country': 'US',
        },
      }),
    );

    const resolve = apiCalls.find((c) => c.url.endsWith('/resolve'));
    assert.ok(resolve, 'the page resolved through the API');
    const sent = JSON.parse(resolve.body);
    assert.equal(sent.geo, 'eu');
  });

  it('carries the evaluator s-maxage through to the response', async () => {
    const res = await handler(event('/giorgi', { headers: { 'x-ctx': 'v4|na.-.-.-.-' } }));
    assert.match(res.headers['cache-control'], /s-maxage=3600/);
  });

  it('refuses to be cached under a key the edge built from a stale mask', async () => {
    // The edge keyed this on the mask published for version 2; the profile is
    // at version 4, so the key may not cover a dimension the rules now read.
    const res = await handler(event('/giorgi', { headers: { 'x-ctx': 'v2|na.-.-.-.-' } }));
    assert.equal(res.headers['cache-control'], 'no-store');
  });

  it('never puts the function URL in a canonical URL', async () => {
    const res = await handler(event('/giorgi', { headers: { 'x-ctx': 'v4|-.-.-.-.-' } }));
    const html = text(res);

    if (BAKED_SITE_ORIGIN) {
      // Built for a known deployment: the configured origin wins, and the
      // forwarded host is not consulted.
      assert.ok(html.includes(BAKED_SITE_ORIGIN), `expected ${BAKED_SITE_ORIGIN} in the page`);
    } else {
      // Built without one: the viewer's host, as the edge function forwarded it.
      assert.match(html, /links\.example\.com/);
    }
    assert.doesNotMatch(html, /lambda-url\.[a-z0-9-]+\.on\.aws/);
  });

  it('serves the homepage at the root, without waking the API', async () => {
    // `/` used to be a 404: there was no route at all, so the first thing
    // anyone typing the domain saw was Next's not-found page. It is a route
    // handler now, and it resolves nothing server-side — a request for the
    // homepage that reached the API would mean the demo had quietly become a
    // real resolution.
    apiCalls = [];
    const res = await handler(event('/'));
    assert.equal(res.statusCode, 200);
    assert.equal(apiCalls.length, 0);
    assert.match(res.headers['content-type'], /text\/html/);

    const html = text(res);
    assert.match(html, /reads the room/);
    // The canonical URL comes from x-forwarded-host, not from the function URL
    // the request actually arrived on.
    assert.match(html, /<link rel="canonical" href="https:\/\/links\.example\.com">/);
    assert.doesNotMatch(html, /lambda-url\.[a-z0-9-]+\.on\.aws/);
  });

  it('hashes the homepage blocks it actually inlined', async () => {
    // The whole point of the renderer handing its two inline blocks back: a
    // hash taken from a second copy of the CSS stops matching the moment a
    // token changes, and the page then ships with its own styles blocked. A
    // 200 either way, which is why it is asserted against the built artifact
    // and not only against the module.
    const res = await handler(event('/'));
    const html = text(res);
    const csp = res.headers['content-security-policy'];
    const sha = (s) => `sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}`;

    const style = html.match(/<style>([\s\S]*?)<\/style>/)[1];
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    assert.ok(csp.includes(`style-src '${sha(style)}'`), 'style hash does not match');
    assert.ok(csp.includes(`script-src '${sha(script)}'`), 'script hash does not match');
  });

  it('lets the edge cache the homepage', async () => {
    const cc = (await handler(event('/'))).headers['cache-control'];
    assert.match(cc, /s-maxage=\d+/);
    assert.match(cc, /stale-while-revalidate=\d+/);
  });

  it('404s an unclaimed handle', async () => {
    const res = await handler(event('/nobody-here'));
    assert.equal(res.statusCode, 404);
    assert.match(text(res), /isn't taken/);
  });

  it('404s a reserved handle before it reaches the API', async () => {
    apiCalls = [];
    const res = await handler(event('/admin'));
    assert.equal(res.statusCode, 404);
    assert.equal(apiCalls.length, 0);
  });

  it('serves the dashboard sign-in page', async () => {
    const res = await handler(event('/login'));
    assert.equal(res.statusCode, 200);
    assert.match(text(res), /<form|sign in|Sign in/i);
  });

  it('serves a static chunk, which is what the /_next/static behaviour caches', async () => {
    const html = text(await handler(event('/login')));
    const chunk = html.match(/\/_next\/static\/[^"']+\.js/)?.[0];
    assert.ok(chunk, 'the page references a static chunk');

    const res = await handler(event(chunk));
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /javascript/);
    // Content-hashed, so the long edge TTL on this behaviour is safe.
    assert.match(res.headers['cache-control'] ?? '', /immutable|max-age/);
  });

  it('turns each Set-Cookie into its own entry rather than one joined header', async () => {
    // /logout clears both cookies; a Function URL response carries them in
    // `cookies`, and collapsing them into one header is how a session cookie
    // and its rotation partner become one malformed cookie.
    const res = await handler(event('/logout', { method: 'POST' }));
    assert.ok(Array.isArray(res.cookies));
    assert.equal(res.headers['set-cookie'], undefined);
    if (res.cookies.length) {
      for (const cookie of res.cookies) assert.doesNotMatch(cookie, /,\s*[A-Za-z_-]+=/);
    }
  });

  it('passes a POST body through to the app', async () => {
    const res = await handler(
      event('/api/proxy/v1/profiles', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://links.example.com' },
        body: JSON.stringify({ handle: 'x' }),
      }),
    );
    // No session cookie, so the proxy refuses — but it refused after parsing the
    // request, which is what this is checking.
    assert.ok([401, 403, 404].includes(res.statusCode), `got ${res.statusCode}`);
  });

  it('refuses a request that did not come through CloudFront', async () => {
    const bare = event('/giorgi');
    delete bare.headers['x-origin-secret'];
    assert.equal((await handler(bare)).statusCode, 403);

    const wrong = event('/giorgi', { headers: { 'x-origin-secret': 'guessed' } });
    assert.equal((await handler(wrong)).statusCode, 403);
  });

  it('does not leak the loopback host into the response', async () => {
    const res = await handler(event('/giorgi', { headers: { 'x-ctx': 'v4|-.-.-.-.-' } }));
    assert.doesNotMatch(text(res), /127\.0\.0\.1:31987/);
  });
});
