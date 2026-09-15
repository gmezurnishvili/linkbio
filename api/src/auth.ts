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

/** The issuer and audience this API stamps on the tokens it mints itself. */
export const SELF_ISSUER = 'linkbio';
export const SELF_AUDIENCE = 'linkbio-api';

/**
 * Verifies a bearer token.
 *
 * With JWKS_URL set an external issuer (Cognito, Auth0, Clerk) owns identity
 * and this only validates. Otherwise the API issues its own tokens, signed with
 * AUTH_SECRET — see `routes/auth.ts`.
 *
 * Every verification pins the algorithm, requires `exp`, and caps token age.
 * `jose` will happily accept an unexpiring token if you do not ask it not to,
 * and an algorithm left open is how `alg: none` and HS-for-RS confusion get in.
 */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  // `x-authorization` first: Origin Access Control overwrites `Authorization`
  // with its own SigV4 signature, so behind CloudFront the viewer's bearer
  // token arrives under the copy `edge/auth-header.js` makes. Direct origin
  // calls — local development, the test suite — still use the real header.
  const header = c.req.header('x-authorization') ?? c.req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) throw unauthorized();

  let payload: JWTPayload;
  try {
    if (env.jwksUrl) {
      ({ payload } = await jwtVerify(token, keySet(), {
        algorithms: ['RS256', 'ES256'],
        issuer: env.jwtIssuer || undefined,
        audience: env.jwtAudience || undefined,
        requiredClaims: ['exp', 'sub'],
      }));
    } else if (env.authSecret) {
      ({ payload } = await jwtVerify(token, new TextEncoder().encode(env.authSecret), {
        algorithms: ['HS256'],
        issuer: SELF_ISSUER,
        audience: SELF_AUDIENCE,
        requiredClaims: ['exp', 'sub'],
      }));
    } else {
      throw unauthorized('auth is not configured');
    }
  } catch {
    throw unauthorized('token rejected');
  }

  // A refresh token is not an access token. They are signed with the same key,
  // so without this check one could be replayed as the other and would carry
  // the refresh token's much longer lifetime into the control plane.
  if (payload.typ !== undefined && payload.typ !== 'access') throw unauthorized('token rejected');

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

/**
 * `x-ctx: v87|na.m.ig.en.0` — version, then five fixed slots in `gdrlw` order.
 *
 * A slot the profile's mask does not cover is the literal `-`. The slots are
 * fixed precisely so this decoder cannot misread one: the earlier format
 * emitted only the masked dimensions, so a device-only mask put the device
 * token where geo was expected and every device rule silently failed while the
 * wrong answer was still marked cacheable. `edge/normalize.js` is the only
 * writer; the two must agree slot for slot.
 */
const ABSENT = '-';

export function decodeCtx(raw: string): ViewerCtx {
  const [, body = ''] = raw.includes('|') ? raw.split('|', 2) : ['', raw];
  const [geo, device, referrer, lang, webview] = body.split('.');
  const dev: Record<string, string> = { m: 'mobile', t: 'tablet', d: 'desktop' };
  const slot = (v: string | undefined) => (v === undefined || v === '' || v === ABSENT ? undefined : v);

  return {
    geo: slot(geo),
    device: dev[slot(device) ?? ''] ?? undefined,
    referrer: slot(referrer),
    lang: slot(lang),
    webview: slot(webview) === undefined ? undefined : webview === '1',
  };
}

/**
 * The dimensions the edge actually folded into the cache key for this request.
 *
 * The coverage check in `evaluate` compares what a block's rules need against
 * this. Deriving it from the current database rules instead — which is what the
 * first version did — makes it complete by construction and therefore useless:
 * it can only ever pass. This is the value that can disagree.
 */
export function ctxDims(raw: string | undefined): Set<string> | null {
  if (!raw) return null;
  const [, body = ''] = raw.includes('|') ? raw.split('|', 2) : ['', raw];
  const slots = body.split('.');
  const names = ['geo', 'device', 'referrer', 'lang', 'webview'];
  const out = new Set<string>();
  names.forEach((n, i) => {
    const v = slots[i];
    if (v !== undefined && v !== '' && v !== ABSENT) out.add(n);
  });
  return out;
}

/** Every context dimension, for callers reached without going through the edge. */
export const ALL_CTX_DIMS = new Set<string>(['geo', 'device', 'referrer', 'lang', 'webview']);

export function ctxVersion(raw?: string): number {
  if (!raw || !raw.includes('|')) return 0;
  return Number(raw.split('|', 1)[0].replace(/^v/, '')) || 0;
}
