import { publicOrigin } from "@/lib/site/public-origin";

/**
 * The request's Origin against ours.
 *
 * The session cookies are SameSite=Lax, which still rides along on a top-level
 * cross-site POST, so every route handler that acts on the session has to check
 * this for itself. Origin is the header an attacker's page cannot forge.
 *
 * The deployed origin is configured, but a preview deployment has no configured
 * name, so the request's own origin counts too. A write with no Origin header
 * at all is refused: every browser that can reach these routes sends one on a
 * cross-site request.
 */
export function isSameOrigin(request: Request): boolean {
  /**
   * `Sec-Fetch-Site` first, when the browser sends it.
   *
   * It is a forbidden header name, so no script can set it, and the browser
   * computes it from the actual relationship between the page and the request:
   * a cross-site page's `fetch` gets `cross-site` no matter what it puts in
   * `Origin`. That makes it both stricter than comparing origins and — the
   * reason it is here — independent of this app knowing what its own origin is,
   * which behind a Lambda function URL is a question with a surprising answer.
   *
   * Absent on older Safari and if anything upstream strips it, so it decides
   * only when present.
   */
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite) return fetchSite === "same-origin";

  const sent = request.headers.get("origin");
  if (!sent) return false;

  // Both spellings. `request.url`'s origin is the Lambda function URL once this
  // is deployed, which no browser will ever send — without the forwarded host
  // resolved by `publicOrigin`, every write in the dashboard would be refused.
  // The raw one stays because locally it is the only one there is.
  const ours = new Set([new URL(request.url).origin, publicOrigin(request.headers, request.url)]);
  return ours.has(sent);
}
