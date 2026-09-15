import { currentAccessToken, clearTokens } from "@/lib/auth/session";

/**
 * /api/proxy/* → the backend, with the access token attached server-side.
 *
 * The browser never holds a token. Everything else passes through unchanged,
 * including If-Match, so the version-conflict handling in the editor keeps
 * working exactly as it would against the backend directly.
 */

export const dynamic = "force-dynamic";

/** Only headers a client has a legitimate reason to set. */
const FORWARD_REQUEST = ["content-type", "accept", "if-match", "if-none-match"];
const FORWARD_RESPONSE = ["content-type", "etag", "x-request-id", "retry-after"];

async function handler(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const origin = process.env.API_ORIGIN;
  if (!origin) return Response.json({ message: "API_ORIGIN is not set" }, { status: 500 });

  const { path } = await ctx.params;
  const token = await currentAccessToken();
  if (!token) {
    return Response.json({ message: "Your session has expired. Sign in again." }, { status: 401 });
  }

  const url = new URL(request.url);
  const target = `${origin}/${path.join("/")}${url.search}`;

  const headers = new Headers({ authorization: `Bearer ${token}` });
  for (const name of FORWARD_REQUEST) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  const body =
    request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();

  let upstream: Response;
  try {
    upstream = await fetch(target, { method: request.method, headers, body, cache: "no-store" });
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

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const PUT = handler;
export const DELETE = handler;
