import { cookies, headers } from "next/headers";
import { originFetch } from "@/lib/api/origin-fetch";

/**
 * Tokens live in httpOnly cookies and are attached to API calls by the proxy
 * route, so no script on this origin can read them.
 *
 * The usual advice is "access token in memory, refresh in an httpOnly cookie",
 * and that is fine when the app owns its whole origin. This one does not: the
 * same apex domain serves creator-authored pages, which means an XSS anywhere
 * in that surface would be able to read an in-memory token from the dashboard
 * tab. Keeping both tokens out of JS entirely costs one extra hop through the
 * Next Lambda, and the dashboard is uncached anyway.
 */

const ACCESS = "lc_at";
const REFRESH = "lc_rt";

/**
 * Over HTTPS the tokens carry the __Host- prefix, which is the only way to say
 * "this cookie is mine" on an apex domain: a browser refuses to accept a
 * __Host- cookie unless it is Secure, path-wide and domain-less, so nothing on
 * a sibling subdomain — including anything a creator ever gets to control —
 * can overwrite the session with one of its own.
 *
 * The unprefixed names exist for `next dev` over plain http, where a Secure
 * cookie would simply never be stored. Reads accept both, so a session that
 * survives a scheme change is not silently dropped.
 */
const HOST_PREFIX = "__Host-";

/**
 * Whether this request arrived over TLS. The proxy in front of the app sets
 * x-forwarded-proto; a request without one is only treated as http when it
 * came from a loopback host, so a misconfigured proxy downgrades nothing.
 */
async function overHttps(): Promise<boolean> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-proto");
  if (forwarded) return forwarded.split(",")[0]!.trim().toLowerCase() === "https";
  const host = h.get("host") ?? "";
  return !/^(localhost|127\.0\.0\.1|\[::1\])(:|$)/i.test(host);
}

export async function readTokens() {
  const jar = await cookies();
  const read = (name: string) =>
    jar.get(`${HOST_PREFIX}${name}`)?.value ?? jar.get(name)?.value ?? null;
  return {
    access: read(ACCESS),
    refresh: read(REFRESH),
  };
}

/**
 * Next allows a cookie write from a Route Handler or a Server Action and
 * nowhere else; a Server Component render that reaches `cookies().set()` throws
 * `ReadonlyRequestCookiesError`. Next neither exports that class nor gives it a
 * `name`, so its message is the only handle on it.
 *
 * Matching narrowly is the point. A blanket catch here would swallow a real
 * cookie failure and hand back a session that silently never persists, which is
 * the same class of bug as the one this exists to fix.
 */
function isReadOnlyJar(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.message.includes("can only be modified in a Server Action or Route Handler")
  );
}

/**
 * Writes the pair, and says whether they actually landed.
 *
 * `false` means the caller was rendering a Server Component, where the jar is
 * read-only. Three pages call `currentAccessToken()` during render
 * (app/app/page.tsx, app/app/new/page.tsx, app/app/[profile]/layout.tsx), so
 * the refresh path has to be able to run there — it only ever appeared to work
 * because the proxy route usually refreshed first and left a live access cookie
 * behind. The token is still returned to that render and still valid; what is
 * lost is the persistence, which `currentAccessToken` compensates for.
 */
export async function writeTokens(tokens: {
  access: string;
  refresh?: string;
  expiresIn: number;
}): Promise<boolean> {
  const jar = await cookies();
  const secure = await overHttps();
  const name = (base: string) => (secure ? `${HOST_PREFIX}${base}` : base);
  const shared = {
    httpOnly: true,
    sameSite: "lax" as const,
    // __Host- is a promise to the browser about all three of these; break one
    // and the cookie is rejected outright rather than stored unprefixed.
    secure,
    path: "/",
  };

  try {
    jar.set(name(ACCESS), tokens.access, { ...shared, maxAge: tokens.expiresIn });
    if (tokens.refresh) {
      jar.set(name(REFRESH), tokens.refresh, { ...shared, maxAge: 60 * 60 * 24 * 30 });
    }
  } catch (err) {
    if (isReadOnlyJar(err)) return false;
    throw err;
  }
  return true;
}

/** Same read-only caveat as writeTokens; `false` means the jar refused. */
export async function clearTokens(): Promise<boolean> {
  const jar = await cookies();
  // Both spellings: a cookie set before a scheme change would otherwise linger
  // and keep answering readTokens.
  try {
    for (const base of [ACCESS, REFRESH]) {
      jar.delete(`${HOST_PREFIX}${base}`);
      jar.delete(base);
    }
  } catch (err) {
    if (isReadOnlyJar(err)) return false;
    throw err;
  }
  return true;
}

export class ExchangeFailure extends Error {
  constructor(readonly status: number) {
    super(`Auth exchange failed with ${status}`);
    this.name = "ExchangeFailure";
  }
}

export interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
}

export async function exchange(
  path: "/v1/auth/token" | "/v1/auth/refresh" | "/v1/auth/register",
  body: unknown,
): Promise<TokenResponse> {
  const origin = process.env.API_ORIGIN;
  if (!origin) throw new Error("API_ORIGIN is not set");

  const res = await originFetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    // Registration needs to tell "email already taken" apart from a generic
    // failure, so the status comes back rather than being flattened to null.
    throw new ExchangeFailure(res.status);
  }
  return (await res.json()) as TokenResponse;
}

/**
 * Refresh exchanges, keyed by the refresh token being spent.
 *
 * The backend rotates: `POST /v1/auth/refresh` consumes the token it is handed,
 * and a second use of a consumed one is read as a leak — it revokes *every*
 * session that user has (api/src/routes/auth.ts). `currentAccessToken()` runs
 * once per request, so the moment the access cookie expires two requests read
 * the same refresh token out of the same jar and both spend it. The second is
 * the reuse, and the creator is signed out everywhere, which is the failure
 * mode that looks least like a race and most like "it logged me out again".
 *
 * Module scope is per server instance, and that is the right scope here rather
 * than a compromise: duplicate reads of one cookie jar are exactly what a
 * single instance produces. Two instances can still collide and only the
 * backend can arbitrate that; this removes the collision we cause ourselves,
 * which is the one that happens on every expiry.
 *
 * An entry outlives its exchange when the result could not be written back —
 * see writeTokens. Holding it is what lets the next request arriving with the
 * same, now-spent cookie be handed the token that replaced it instead of
 * spending it a second time.
 */
const exchanges = new Map<string, Promise<TokenResponse>>();

/**
 * Enough to cover the requests one expiry can produce on one instance. Past it
 * the oldest unpersisted entry is dropped, and a visitor unlucky enough to be
 * that entry is back to the behaviour this map replaces — one reuse — rather
 * than the map growing without a bound.
 */
const MAX_EXCHANGES = 64;

function refreshOnce(refresh: string): Promise<TokenResponse> {
  const started = exchanges.get(refresh);
  if (started) return started;

  const next = exchange("/v1/auth/refresh", { refreshToken: refresh });
  // A failure is not worth remembering: the token is spent or revoked either
  // way and the caller is about to clear the cookies.
  next.catch(() => exchanges.delete(refresh));

  if (exchanges.size >= MAX_EXCHANGES) {
    const oldest = exchanges.keys().next();
    if (!oldest.done) exchanges.delete(oldest.value);
  }
  exchanges.set(refresh, next);
  return next;
}

/** Access token if we have a live one, refreshing once if it has expired. */
export async function currentAccessToken(): Promise<string | null> {
  const { access, refresh } = await readTokens();
  if (access) return access;
  if (!refresh) return null;

  let next: TokenResponse;
  try {
    next = await refreshOnce(refresh);
  } catch {
    // The refresh token is spent or revoked. Drop both so the next navigation
    // lands on sign-in rather than looping. In a read-only render there is
    // nothing to drop; the next request through the proxy clears them.
    await clearTokens();
    return null;
  }

  // `next.refreshToken` and not `refresh`: rotation means the one we just spent
  // is the one whose reuse revokes the account, so writing it back would arm
  // the very trap this function guards.
  const persisted = await writeTokens({
    access: next.accessToken,
    refresh: next.refreshToken,
    expiresIn: next.expiresIn,
  });
  // Once the browser holds the rotated pair nobody will present the old token
  // again, so there is nothing left to remember.
  if (persisted) exchanges.delete(refresh);
  return next.accessToken;
}
