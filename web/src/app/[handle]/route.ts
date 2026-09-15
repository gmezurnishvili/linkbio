import { createHash } from "node:crypto";
import { api } from "@/lib/api/client";
import { ApiError, type VisitorContext } from "@/lib/api/types";
import { isReserved, isValidHandle } from "@/lib/handles";
import { cacheControlFor, visitorContextFromHeaders } from "@/lib/context/visitor";
import { renderProfile, varyHeader } from "@/lib/site/render";

/**
 * GET /:handle — the public profile.
 *
 * A route handler rather than a page, because the response needs a
 * Cache-Control value that is computed per request: the rule evaluator returns
 * the earliest instant any decision on this page could change, and s-maxage is
 * set to exactly that. A page component has no way to reach the response
 * headers, so the TTL would have to be a static guess.
 */

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ handle: string }> },
) {
  const { handle } = await params;

  if (isReserved(handle)) return notFound();
  if (!isValidHandle(handle.toLowerCase())) return notFound();

  const context = visitorContextFromHeaders(request.headers);

  let resolution;
  try {
    resolution = await api.resolve(handle, context);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return notFound();
    // The origin is down or slow. Failing closed on a creator's page loses them
    // real traffic, so send a 503 with a short retry and let CloudFront serve a
    // stale copy if it has one.
    return new Response("Temporarily unavailable", {
      status: 503,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "public, max-age=0, s-maxage=5, stale-if-error=86400",
        "retry-after": "5",
      },
    });
  }

  const origin = process.env.NEXT_PUBLIC_SITE_ORIGIN ?? new URL(request.url).origin;
  const html = renderProfile({
    resolution,
    origin,
    beaconUrl: process.env.NEXT_PUBLIC_BEACON_URL ?? "/v1/beacon",
    variant: variantFingerprint(resolution.varyOn, context),
  });

  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": cacheControlFor(resolution.sMaxAge),
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    // The inline style and script blocks are ours, not creator input; the
    // hashes change per theme, so a nonce would defeat edge caching. Hashing
    // the two literal blocks is the version to move to once the CSS is stable.
    "content-security-policy": [
      "default-src 'none'",
      "img-src https: data:",
      "style-src 'unsafe-inline'",
      "script-src 'unsafe-inline'",
      "connect-src https:",
      "form-action 'none'",
      "frame-ancestors 'self'",
    ].join("; "),
    // Useful when debugging a variant by hand; strip it in production if you
    // would rather not publish how the key is built.
    "x-route-boundary": String(resolution.sMaxAge),
  });

  const vary = varyHeader(resolution.varyOn);
  if (vary) headers.set("vary", vary);

  return new Response(html, { status: 200, headers });
}

/**
 * A short, stable label for which cached variant a visitor was served. Beacons
 * echo it back, which is what makes "this variant converts better" answerable
 * without storing the visitor's actual country or device against the click.
 */
function variantFingerprint(varyOn: string[], context: VisitorContext): string {
  const values = context as unknown as Record<string, unknown>;
  if (varyOn.length === 0) return "base";
  const parts = varyOn
    .slice()
    .sort()
    .map((d) => `${d}=${String(values[d === "tz-bucket" ? "at" : d] ?? "-")}`);
  return createHash("sha256").update(parts.join("|")).digest("base64url").slice(0, 10);
}

function notFound() {
  return new Response(NOT_FOUND_HTML, {
    status: 404,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Cache misses for a while: bots hammer unclaimed handles, and a claimed
      // handle publishes a purge anyway.
      "cache-control": "public, max-age=0, s-maxage=60",
    },
  });
}

const NOT_FOUND_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Not here</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;
background:#f4f5f7;color:#141a22;font:16px/1.5 -apple-system,BlinkMacSystemFont,sans-serif}
div{text-align:center;padding:2rem}p{color:#6b7480;margin:.5rem 0 0;font-size:.9375rem}</style>
</head><body><div><strong>This handle isn't taken.</strong>
<p>If it's yours, claim it.</p></div></body></html>`;
