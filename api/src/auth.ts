import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { MiddlewareHandler } from 'hono';
import { env } from './env.ts';
import { unauthorized } from './errors.ts';

export type Auth = { userId: string; scopes: string[] };

declare module 'hono' {
  interface ContextVariableMap {
    auth: Auth;
  }
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function keySet() {
  if (!jwks) {
    if (!env.jwksUrl) throw unauthorized('auth is not configured');
    jwks = createRemoteJWKSet(new URL(env.jwksUrl));
  }
  return jwks;
}

/**
 * Verifies a bearer token against the configured JWKS (Cognito, Auth0, Clerk —
 * anything that publishes one). DEV_JWT_SECRET switches to a local HS256 secret
 * so the suite and `npm run dev` work without a hosted issuer; it is ignored
 * whenever JWKS_URL is set.
 */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  const header = c.req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) throw unauthorized();

  let payload: JWTPayload;
  try {
    if (env.jwksUrl) {
      ({ payload } = await jwtVerify(token, keySet(), {
        issuer: env.jwtIssuer || undefined,
        audience: env.jwtAudience || undefined,
      }));
    } else if (env.devSecret) {
      ({ payload } = await jwtVerify(token, new TextEncoder().encode(env.devSecret)));
    } else {
      throw unauthorized('auth is not configured');
    }
  } catch {
    throw unauthorized('token rejected');
  }

  const userId = (payload.sub ?? '') as string;
  if (!userId) throw unauthorized('token has no subject');

  const raw = payload.scope;
  c.set('auth', {
    userId,
    scopes: typeof raw === 'string' ? raw.split(' ') : Array.isArray(raw) ? (raw as string[]) : [],
  });
  await next();
};

// ---------- viewer context ----------

export type ViewerCtx = {
  geo?: string; device?: string; referrer?: string; lang?: string; webview?: boolean;
};

const GEO: Record<string, string> = {
  US: 'na', CA: 'na', MX: 'latam', BR: 'latam', AR: 'latam', CL: 'latam', CO: 'latam',
  GB: 'eu', IE: 'eu', DE: 'eu', FR: 'eu', ES: 'eu', IT: 'eu', NL: 'eu', PL: 'eu', SE: 'eu',
  JP: 'apac', KR: 'apac', CN: 'apac', IN: 'apac', AU: 'apac', NZ: 'apac', SG: 'apac', ID: 'apac',
  AE: 'mea', SA: 'mea', ZA: 'mea', NG: 'mea', EG: 'mea', IL: 'mea', TR: 'mea',
};

const WEBVIEW = /Instagram|FBAV|FBAN|FB_IAB|TikTok|Line\/|MicroMessenger|Snapchat|Pinterest/i;

/**
 * Rebuilds the same normalized context the CloudFront Function computes for the
 * cache key. It must stay byte-identical to the edge implementation, or a
 * response gets cached under a key that does not describe it.
 */
export function viewerCtx(h: (name: string) => string | undefined): ViewerCtx {
  const pre = h('x-ctx');
  if (pre) return decodeCtx(pre);

  const country = (h('cloudfront-viewer-country') ?? '').toUpperCase();
  const ua = h('user-agent') ?? '';
  const mobile = h('cloudfront-is-mobile-viewer') === 'true' || /Mobile|Android|iPhone/i.test(ua);
  const tablet = h('cloudfront-is-tablet-viewer') === 'true' || /iPad|Tablet/i.test(ua);

  return {
    geo: GEO[country] ?? 'xx',
    device: tablet ? 'tablet' : mobile ? 'mobile' : 'desktop',
    referrer: refClass(h('referer')),
    lang: (h('accept-language') ?? 'en').slice(0, 2).toLowerCase(),
    webview: WEBVIEW.test(ua),
  };
}

export function refClass(referer?: string): string {
  if (!referer) return 'dir';
  let host: string;
  try { host = new URL(referer).hostname.toLowerCase(); } catch { return 'oth'; }
  if (host.includes('instagram')) return 'ig';
  if (host.includes('tiktok')) return 'tt';
  if (host.includes('linkedin') || host === 'lnkd.in') return 'li';
  if (host.includes('youtube') || host === 'youtu.be') return 'yt';
  if (host.includes('twitter') || host === 't.co' || host.includes('x.com')) return 'x';
  if (host.includes('facebook') || host === 'fb.me') return 'fb';
  return 'oth';
}

/** `x-ctx: v87|na.m.ig.en.0` — version, then one token per masked dimension. */
export function decodeCtx(raw: string): ViewerCtx {
  const [, body = ''] = raw.includes('|') ? raw.split('|', 2) : ['', raw];
  const [geo, device, referrer, lang, webview] = body.split('.');
  const dev: Record<string, string> = { m: 'mobile', t: 'tablet', d: 'desktop' };
  return {
    geo: geo || undefined,
    device: dev[device ?? ''] ?? undefined,
    referrer: referrer || undefined,
    lang: lang || undefined,
    webview: webview === undefined ? undefined : webview === '1',
  };
}

export function ctxVersion(raw?: string): number {
  if (!raw || !raw.includes('|')) return 0;
  return Number(raw.split('|', 1)[0].replace(/^v/, '')) || 0;
}
