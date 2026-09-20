/**
 * The origin this app is actually being served on.
 *
 * Behind CloudFront the app runs on a Lambda function URL, so `request.url` is
 * `https://<random>.lambda-url.us-east-1.on.aws/...` — not the domain the
 * visitor typed. Anything derived from `request.url` is therefore wrong in the
 * two places it matters most:
 *
 *   - the canonical URL and JSON-LD `@id` on a public page, which would name a
 *     hostname no one can reach;
 *   - the same-origin check on every write, which compares the browser's
 *     `Origin` against ours. Left as `request.url`, every save in the dashboard
 *     is a 403.
 *
 * CloudFront sends a function URL origin its own hostname, because that is the
 * host the origin expects. The viewer's host arrives in `x-forwarded-host`,
 * which `api/edge/page.js` writes.
 *
 * That header is trustworthy *here*, which is not a general claim about
 * `x-forwarded-*`. Two things make it so: the edge function deletes any copy
 * the viewer sent before writing its own, and the function URL is only
 * reachable through CloudFront, because the stack gives both origins a secret
 * header that a viewer cannot set. Take either away and this becomes
 * attacker-controlled, so they are not details to drop.
 */

/** Hostname, optionally with a port. Anything else is ignored rather than trusted. */
const HOST = /^[a-z0-9.-]+(:\d{1,5})?$/i;

export function publicOrigin(headers: Headers, requestUrl: string): string {
  const configured = process.env.NEXT_PUBLIC_SITE_ORIGIN;
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // A malformed value should not widen anything, and should not throw on a
      // page request either. Fall through to the headers.
    }
  }

  const forwarded = headers.get("x-forwarded-host");
  if (forwarded && HOST.test(forwarded)) {
    // Function URLs are HTTPS-only and set this themselves; the default matters
    // only for a direct http call in development.
    const proto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "https";
    if (proto === "http" || proto === "https") return `${proto}://${forwarded}`;
  }

  return new URL(requestUrl).origin;
}
