import { clearTokens, readTokens } from "@/lib/auth/session";
import { isSameOrigin } from "@/lib/auth/same-origin";

/**
 * POST /logout — end the session.
 *
 * A route handler rather than a Server Action because it has to clear cookies
 * and then navigate, and because the refresh token it needs to revoke is
 * httpOnly: no script on this origin can read it, so the revocation cannot be
 * a client-side call through /api/proxy. This is the only place that holds both
 * halves at once.
 *
 * Two things happen and the order matters. The backend is told first, so the
 * refresh token is dead even if the browser ignores the Set-Cookie; then the
 * cookies go, so the next navigation lands on sign-in. If the backend is
 * unreachable the cookies still go — a sign-out that fails because a server is
 * down is a sign-out that did not happen, and the person walking away from a
 * shared machine is the one who pays for it.
 *
 * `?all=1` revokes every session on the account instead of this one.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return Response.json({ message: "Cross-origin request refused." }, { status: 403 });
  }

  const everywhere = new URL(request.url).searchParams.get("all") === "1";
  const { access, refresh } = await readTokens();
  const origin = process.env.API_ORIGIN;

  if (origin) {
    try {
      if (everywhere && access) {
        await fetch(`${origin}/v1/auth/logout/all`, {
          method: "POST",
          headers: { authorization: `Bearer ${access}` },
          cache: "no-store",
        });
      } else if (refresh) {
        await fetch(`${origin}/v1/auth/logout`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refreshToken: refresh }),
          cache: "no-store",
        });
      }
    } catch {
      // Deliberately swallowed — see above. The local half still runs.
    }
  }

  await clearTokens();

  // 303, not Next's `redirect()` — that answers 307, which preserves the
  // method, so the browser would POST to /login and get a 405.
  return new Response(null, {
    status: 303,
    headers: { location: "/login?signedout=1", "cache-control": "no-store" },
  });
}
