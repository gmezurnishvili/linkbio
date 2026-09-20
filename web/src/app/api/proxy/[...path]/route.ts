import { currentAccessToken, clearTokens } from "@/lib/auth/session";
import { isAllowedProxyPath } from "@/lib/proxy/allowlist";
import { isSameOrigin } from "@/lib/auth/same-origin";
import { originFetch } from "@/lib/api/origin-fetch";

/**
 * /api/proxy/* → the backend, with the access token attached server-side.
 *
 * The browser never holds a token. Everything else passes through unchanged,
 * including If-Match, so the version-conflict handling in the editor keeps
 * working exactly as it would against the backend directly.
 *
 * "Everything else" is bounded, though. Because the token is attached here and
 * the session cookie rides along automatically, this route is as powerful as
 * the signed-in user; three limits keep it from being more useful to an
 * attacker than to the dashboard: only the paths the dashboard actually calls,
 * only same-origin callers on anything that writes, and a bounded body.
 */

export const dynamic = "force-dynamic";

/** Only headers a client has a legitimate reason to set. */
const FORWARD_REQUEST = ["content-type", "accept", "if-match", "if-none-match"];
const FORWARD_RESPONSE = ["content-type", "etag", "x-request-id", "retry-after"];

/** Methods that change something, and so must prove they came from our own pages. */
const WRITE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/**
 * Nothing the dashboard sends is anywhere near this. The cap exists because
 * the body is buffered in memory before it is forwarded, so without one a
 * single request decides how much memory the function uses.
 */
const MAX_BODY_BYTES = 1024 * 1024;

async function handler(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const origin = process.env.API_ORIGIN;
  if (!origin) return Response.json({ message: "API_ORIGIN is not set" }, { status: 500 });

  const { path } = await ctx.params;
  // A path this app never calls is not a path this app should forward. 404
  // rather than 403: the answer is the same whether or not it exists upstream.
  if (!isAllowedProxyPath(request.method, path)) {
    return Response.json({ message: "Not found" }, { status: 404 });
  }

  // The session cookie is SameSite=Lax, which still rides along on a top-level
  // cross-site POST. Origin is the header an attacker's page cannot forge.
  if (WRITE_METHODS.has(request.method) && !isSameOrigin(request)) {
    return Response.json({ message: "Cross-origin request refused." }, { status: 403 });
  }

  const token = await currentAccessToken();
  if (!token) {
    return Response.json({ message: "Your session has expired. Sign in again." }, { status: 401 });
  }

  const url = new URL(request.url);
  const target = `${origin}/${path.map(encodeURIComponent).join("/")}${url.search}`;

  const headers = new Headers({ authorization: `Bearer ${token}` });
  for (const name of FORWARD_REQUEST) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  let body: string | undefined;
  if (request.method !== "GET") {
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return tooLarge();
    body = await request.text();
    // Content-Length can be absent or a lie, so the buffered value is measured
    // too. Byte length, not character count: one emoji is four bytes.
    if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) return tooLarge();
  }

  let upstream: Response;
  try {
    upstream = await originFetch(target, { method: request.method, headers, body, cache: "no-store" });
  } catch {
    return Response.json({ message: "Couldn't reach the API. Retry." }, { status: 502 });
  }

  // The token was live but the backend rejected it — revoked, or signed by a
  // key that has rotated. Drop it so the next navigation lands on sign-in.
  if (upstream.status === 401) await clearTokens();

  const out = new Headers({ "cache-control": "private, no-store" });
  for (const name of FORWARD_RESPONSE) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }

  return new Response(upstream.body, { status: upstream.status, headers: out });
}

function tooLarge() {
  return Response.json({ message: "That request body is too large." }, { status: 413 });
}

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const PUT = handler;
export const DELETE = handler;
