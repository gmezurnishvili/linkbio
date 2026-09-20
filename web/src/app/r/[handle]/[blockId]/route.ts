import { isReserved, isValidHandle } from "@/lib/handles";

/**
 * GET /r/:handle/:blockId — the click redirector.
 *
 * `resolveProfile` gives every link an href of `/r/<handle>/<blockId>`, so this
 * path has to exist on whatever origin serves the public page or every link on
 * every published page 404s.
 *
 * In production the intent is that CloudFront routes `/r/*` straight to the API
 * origin and this handler is never reached — the whole point of the hot-link
 * short-circuit in the edge function is to answer a click without waking an
 * origin at all, and putting the Next Lambda in the click path defeats it. That
 * routing lives in `api/infra/stack.ts`; until the distribution has the web app
 * as an origin, this is also the only thing that makes a click work anywhere.
 *
 * So: a thin proxy. It forwards the viewer signals the evaluator keys on,
 * refuses to follow the redirect itself, and hands the visitor the same status
 * and Location the API chose. It deliberately does not parse or rewrite the
 * target — the API owns the decision, this owns the hop.
 */

export const dynamic = "force-dynamic";

/**
 * What the backend's `viewerCtx` reads when no `x-ctx` is present. Forwarding
 * exactly this set keeps a local click on the same evaluation path as a cached
 * one; forwarding everything would let a visitor-supplied header reach the
 * origin unfiltered.
 */
const FORWARDED = [
  "user-agent",
  "accept-language",
  "referer",
  "cloudfront-viewer-country",
  "cloudfront-is-mobile-viewer",
  "cloudfront-is-tablet-viewer",
  "x-ctx",
] as const;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ handle: string; blockId: string }> },
) {
  const { handle: raw, blockId } = await params;
  const handle = raw.toLowerCase();

  if (isReserved(handle) || !isValidHandle(handle)) return gone();

  const origin = process.env.API_ORIGIN;
  if (!origin) throw new Error("API_ORIGIN is not set");

  const forwarded = new Headers();
  for (const name of FORWARDED) {
    const value = request.headers.get(name);
    if (value) forwarded.set(name, value);
  }

  let upstream: Response;
  try {
    upstream = await fetch(
      `${origin}/r/${encodeURIComponent(handle)}/${encodeURIComponent(blockId)}`,
      { headers: forwarded, redirect: "manual", cache: "no-store" },
    );
  } catch {
    // The origin is down. A click is a one-shot intent — there is nothing
    // useful to show and nothing to cache, so say so plainly and let the
    // visitor retry.
    return new Response("Temporarily unavailable", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "5" },
    });
  }

  const location = upstream.headers.get("location");
  if (!location) return gone();

  const headers = new Headers({ location });
  // The TTL the evaluator computed is the whole reason this endpoint is
  // cacheable at all; dropping it would make every click a miss.
  for (const name of ["cache-control", "vary", "x-rule-id"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }

  // 302 or 307, never 301 — see the API handler. Whatever it chose is passed
  // through unchanged rather than re-derived here.
  return new Response(null, { status: upstream.status, headers });
}

/**
 * A link that is hidden by a rule, expired, or simply not there. All three are
 * "not available to you, now" rather than "never existed", and the visitor
 * cannot tell the difference anyway.
 */
function gone() {
  return new Response(GONE_HTML, {
    status: 404,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

const GONE_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Link unavailable</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;
background:#f4f5f7;color:#141a22;font:16px/1.5 -apple-system,BlinkMacSystemFont,sans-serif}
div{text-align:center;padding:2rem}p{color:#6b7480;margin:.5rem 0 0;font-size:.9375rem}</style>
</head><body><div><strong>This link isn't available right now.</strong>
<p>It may have been scheduled for another time, or taken down.</p></div></body></html>`;
