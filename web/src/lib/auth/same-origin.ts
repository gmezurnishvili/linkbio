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
  const sent = request.headers.get("origin");
  if (!sent) return false;

  const ours = new Set([new URL(request.url).origin]);
  const configured = process.env.NEXT_PUBLIC_SITE_ORIGIN;
  if (configured) {
    try {
      ours.add(new URL(configured).origin);
    } catch {
      // A malformed NEXT_PUBLIC_SITE_ORIGIN should not widen anything.
    }
  }
  return ours.has(sent);
}
