import { cookies } from "next/headers";

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

const SHARED = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
};

export async function readTokens() {
  const jar = await cookies();
  return {
    access: jar.get(ACCESS)?.value ?? null,
    refresh: jar.get(REFRESH)?.value ?? null,
  };
}

export async function writeTokens(tokens: {
  access: string;
  refresh?: string;
  expiresIn: number;
}) {
  const jar = await cookies();
  jar.set(ACCESS, tokens.access, { ...SHARED, maxAge: tokens.expiresIn });
  if (tokens.refresh) {
    jar.set(REFRESH, tokens.refresh, { ...SHARED, maxAge: 60 * 60 * 24 * 30 });
  }
}

export async function clearTokens() {
  const jar = await cookies();
  jar.delete(ACCESS);
  jar.delete(REFRESH);
}

export interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
}

export async function exchange(
  path: "/v1/auth/token" | "/v1/auth/refresh",
  body: unknown,
): Promise<TokenResponse | null> {
  const origin = process.env.API_ORIGIN;
  if (!origin) throw new Error("API_ORIGIN is not set");

  const res = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) return null;
  return (await res.json()) as TokenResponse;
}

/** Access token if we have a live one, refreshing once if it has expired. */
export async function currentAccessToken(): Promise<string | null> {
  const { access, refresh } = await readTokens();
  if (access) return access;
  if (!refresh) return null;

  const next = await exchange("/v1/auth/refresh", { refreshToken: refresh });
  if (!next) {
    await clearTokens();
    return null;
  }
  await writeTokens({
    access: next.accessToken,
    refresh: next.refreshToken,
    expiresIn: next.expiresIn,
  });
  return next.accessToken;
}
