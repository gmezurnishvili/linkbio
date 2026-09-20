/**
 * Lambda entrypoint for the Next server.
 *
 * Next's standalone output is an ordinary Node HTTP server, and Lambda speaks
 * Function URL events, so something has to translate between the two. The usual
 * answer is the AWS Lambda Web Adapter layer, which does exactly this in Rust
 * from inside a layer. This does it in sixty lines of JavaScript instead, for
 * three reasons that all come down to being able to check the result:
 *
 *   - the layer is a versioned ARN in an AWS-owned account, pinned per region
 *     and per architecture, and a wrong one fails at deploy time rather than at
 *     synth time;
 *   - it needs an executable `run.sh` in the bundle, and the exec bit does not
 *     survive a checkout on Windows, which is where this repo is built;
 *   - this file can be exercised locally against a real build, and is (see
 *     `test/lambda-handler.test.mjs`).
 *
 * The trade is response streaming: this buffers, so a response is capped at
 * Lambda's 6 MB payload limit. Nothing this app serves is within an order of
 * magnitude of that — the largest route is 29 kB of JS — and `/_next/static`
 * is cached at the edge after the first request.
 */

import net from 'node:net';

const PORT = Number(process.env.NEXT_SERVER_PORT ?? 3000);
const HOST = '127.0.0.1';

/**
 * Hop-by-hop headers, plus the two the Function URL owns. Forwarding
 * `content-length` from a response we are about to base64-encode is the one
 * that actually breaks things: the value describes the decoded bytes and the
 * client counts the encoded ones.
 */
const DROP_RESPONSE = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'content-length', 'content-encoding', 'set-cookie',
]);

/** Started once per execution environment, then reused by every invocation. */
let booting = null;

function boot() {
  if (booting) return booting;
  booting = (async () => {
    process.env.PORT = String(PORT);
    process.env.HOSTNAME = HOST;
    // Resolved against this file rather than the cwd: Lambda does not promise
    // what the working directory is, and `server.js` sits beside us.
    await import('./server.js');
    await waitForPort(PORT, 10_000);
  })();
  // A failed boot must not be cached as a permanently broken promise — the next
  // invocation in this container should be allowed to try again.
  booting.catch(() => { booting = null; });
  return booting;
}

/** Resolves once something is accepting connections, or throws after `timeoutMs`. */
async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await new Promise((resolve, reject) => {
        const socket = net.connect(port, HOST);
        socket.once('connect', () => { socket.end(); resolve(); });
        socket.once('error', reject);
      });
      return;
    } catch (err) {
      if (Date.now() >= deadline) {
        throw new Error(`Next did not start listening on ${HOST}:${port} within ${timeoutMs}ms`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

/**
 * The function URL is `authType: NONE`, because Origin Access Control cannot
 * front a URL that browsers POST to — a signed request to a function URL must
 * carry its own body hash in `x-amz-content-sha256`, and Lambda refuses
 * `UNSIGNED-PAYLOAD`. So the URL answers anyone who learns it, and this is what
 * makes learning it useless: CloudFront adds the secret as a custom origin
 * header, which overwrites anything a viewer sent under that name.
 *
 * Refused here rather than inside Next, before the server is even booted: a
 * request that did not come through CloudFront did not pass the WAF, and should
 * not get to cost a cold start.
 */
const ORIGIN_SECRET = process.env.ORIGIN_SECRET;

function forbidden() {
  return {
    statusCode: 403,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    body: 'Forbidden',
  };
}

export async function handler(event) {
  if (ORIGIN_SECRET && event.headers?.['x-origin-secret'] !== ORIGIN_SECRET) return forbidden();

  await boot();

  const http = event.requestContext?.http ?? {};
  const method = http.method ?? 'GET';
  const path = event.rawPath || '/';
  const query = event.rawQueryString ? `?${event.rawQueryString}` : '';

  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers ?? {})) {
    if (value !== undefined) headers.set(name, value);
  }
  // Function URLs hand cookies over as a separate array and leave the header
  // out; Next reads the header.
  if (event.cookies?.length) headers.set('cookie', event.cookies.join('; '));
  // The loopback server is what is being addressed now, so that is the Host it
  // gets. This deliberately does not become the viewer's host: Next's own
  // Server Action CSRF check reads `x-forwarded-host` in preference to `host`,
  // and `publicOrigin` on the app side does the same, so the viewer's domain
  // travels in the header that both of them already look at. Putting it in
  // `host` as well would only add a second, quieter source of truth.
  headers.set('host', `${HOST}:${PORT}`);

  const body = event.body === undefined || event.body === null
    ? undefined
    : event.isBase64Encoded
      ? Buffer.from(event.body, 'base64')
      : event.body;

  const upstream = await fetch(`http://${HOST}:${PORT}${path}${query}`, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : body,
    // Next's own redirects are the answer, not something to follow here.
    redirect: 'manual',
  });

  const out = {};
  for (const [name, value] of upstream.headers) {
    if (!DROP_RESPONSE.has(name)) out[name] = value;
  }

  const payload = Buffer.from(await upstream.arrayBuffer());

  return {
    statusCode: upstream.status,
    headers: out,
    // Every Set-Cookie separately: collapsing them into one comma-joined header
    // is how a session cookie and its rotation partner become one malformed
    // cookie that the browser stores under a name containing a comma.
    cookies: upstream.headers.getSetCookie(),
    // Always base64. Deciding by content-type means guessing, and guessing
    // wrong on a font or an image corrupts it silently.
    body: payload.toString('base64'),
    isBase64Encoded: true,
  };
}
