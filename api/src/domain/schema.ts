import { z } from 'zod';
import { env } from '../env.ts';

// ---------- primitives ----------

export const Handle = z
  .string()
  .min(2)
  .max(30)
  .regex(/^[a-z0-9][a-z0-9_-]*[a-z0-9]$/, 'lowercase letters, digits, - and _ only')
  .refine((h) => !RESERVED.has(h), 'handle is reserved');

const RESERVED = new Set([
  'api', 'admin', 'www', 'app', 'login', 'logout', 'signup', 'settings', 'support',
  'help', 'about', 'terms', 'privacy', 'static', 'assets', 'r', 'p', 'v1', 'health',
]);

/**
 * Decides whether a hostname points somewhere public.
 *
 * The first version matched dotted-quad private ranges as strings, which meant
 * `http://2130706433/`, `http://0177.0.0.1/`, `http://[::1]/` and
 * `http://[::ffff:127.0.0.1]/` all read as public. Nothing server-side fetches
 * these targets today, but `dueForRefresh` exists to add exactly that, and
 * `avatarUrl` and `feed.ref` are already creator-supplied.
 */
export function isPrivateHost(raw: string): boolean {
  const h = raw.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;

  // IPv6, including the v4-mapped forms.
  if (h.startsWith('[') && h.endsWith(']')) {
    const v6 = h.slice(1, -1);
    if (v6 === '::1' || v6 === '::') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(v6)) return true;   // unique local
    if (/^fe[89ab][0-9a-f]:/.test(v6)) return true;   // link local
    // WHATWG URL parsing rewrites the dotted tail to hex before we ever see it
    // (`http://[::ffff:127.0.0.1]/`.hostname is `[::ffff:7f00:1]`), so matching
    // only the dotted spelling made this branch dead and let loopback through.
    const dotted = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) return isPrivateV4(dotted[1]!);
    const hex = v6.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) return isPrivateV4Number(parseInt(hex[1]!, 16) * 0x10000 + parseInt(hex[2]!, 16));
    return false;
  }

  // Decimal, octal and hex integer forms all resolve to an address.
  const asInt = parseIntegerHost(h);
  if (asInt !== null) return isPrivateV4Number(asInt);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return isPrivateV4(h);
  return false;
}

function parseIntegerHost(h: string): number | null {
  let n: number | null = null;
  if (/^\d+$/.test(h)) n = Number(h);
  else if (/^0[0-7]+$/.test(h)) n = parseInt(h, 8);
  else if (/^0x[0-9a-f]+$/.test(h)) n = parseInt(h, 16);
  return n !== null && Number.isFinite(n) && n >= 0 && n <= 0xffffffff ? n : null;
}

function isPrivateV4(dotted: string): boolean {
  const parts = dotted.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  return isPrivateV4Number(((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!);
}

function isPrivateV4Number(n: number): boolean {
  const inRange = (net: string, bits: number) => {
    const [a, b, c, d] = net.split('.').map(Number) as [number, number, number, number];
    const base = ((a << 24) >>> 0) + (b << 16) + (c << 8) + d;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (n & mask) >>> 0 === (base & mask) >>> 0;
  };
  return (
    inRange('0.0.0.0', 8) || inRange('10.0.0.0', 8) || inRange('127.0.0.0', 8) ||
    inRange('169.254.0.0', 16) || inRange('172.16.0.0', 12) || inRange('192.168.0.0', 16) ||
    inRange('100.64.0.0', 10) || inRange('192.0.0.0', 24) || inRange('198.18.0.0', 15) ||
    inRange('224.0.0.0', 4) || inRange('240.0.0.0', 4)
  );
}

/** Blocks http(s) only, and rejects hosts that could be used to pivot inside a VPC. */
export const SafeUrl = z.string().url().max(2048).superRefine((v, ctx) => {
  let u: URL;
  try { u = new URL(v); } catch { return ctx.addIssue({ code: 'custom', message: 'invalid url' }); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    ctx.addIssue({ code: 'custom', message: 'only http(s) targets allowed' });
  }
  if (isPrivateHost(u.hostname)) {
    ctx.addIssue({ code: 'custom', message: 'private or link-local hosts not allowed' });
  }
});

/**
 * The same gate as `SafeUrl`, as a predicate, for code that holds a URL rather
 * than a schema — the feed fetcher, which follows redirects and has to re-check
 * every hop. A redirect to `http://169.254.169.254/` is the whole reason the
 * fetcher cannot simply hand the URL to `fetch` and let it follow.
 */
export function isPublicHttpUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  return !isPrivateHost(u.hostname);
}

const Hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:mm');
const Tz = z.string().refine((t) => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: t }); return true; } catch { return false; }
}, 'unknown IANA timezone');

// ---------- rules ----------

export const GEO_BUCKETS = ['na', 'eu', 'apac', 'latam', 'mea', 'xx'] as const;
export const DEVICES = ['mobile', 'tablet', 'desktop'] as const;
export const REFERRERS = ['ig', 'tt', 'li', 'yt', 'x', 'fb', 'dir', 'oth'] as const;

export const Condition = z.discriminatedUnion('dim', [
  z.object({ dim: z.literal('geo'), in: z.array(z.enum(GEO_BUCKETS)).min(1) }),
  z.object({ dim: z.literal('device'), in: z.array(z.enum(DEVICES)).min(1) }),
  z.object({ dim: z.literal('referrer'), in: z.array(z.enum(REFERRERS)).min(1) }),
  z.object({ dim: z.literal('lang'), in: z.array(z.string().length(2)).min(1) }),
  z.object({ dim: z.literal('webview'), is: z.boolean() }),
  z.object({
    dim: z.literal('time'),
    tz: Tz,
    days: z.array(z.number().int().min(0).max(6)).min(1).optional(),
    from: Hm,
    to: Hm,
  }),
]);

export const Action = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('redirect'), target: SafeUrl, status: z.union([z.literal(302), z.literal(307)]) }),
  z.object({ kind: z.literal('hide') }),
]);

export const Rule = z.object({
  id: z.string().min(1).max(64),
  priority: z.number().int().min(0).max(9999),
  when: z.array(Condition).min(1).max(8),
  then: Action,
});

/**
 * One rule must not carry two conditions on the same dimension — they would AND
 * to nothing useful. The cap comes from `env.maxRules` rather than a literal,
 * which the route also enforced: a `MAX_RULES=50` deployment still rejected at
 * 21 because this array had its own hardcoded `.max(20)`.
 */
export const RuleSet = z.array(Rule).max(env.maxRules).superRefine((rules, ctx) => {
  const ids = new Set<string>();
  rules.forEach((r, i) => {
    if (ids.has(r.id)) ctx.addIssue({ code: 'custom', path: [i, 'id'], message: 'duplicate rule id' });
    ids.add(r.id);
    const dims = new Set<string>();
    r.when.forEach((cnd, j) => {
      if (cnd.dim !== 'time' && dims.has(cnd.dim)) {
        ctx.addIssue({ code: 'custom', path: [i, 'when', j], message: `duplicate ${cnd.dim} condition` });
      }
      dims.add(cnd.dim);
    });
  });
});

// ---------- blocks ----------

export const BLOCK_KINDS = ['link', 'header', 'embed', 'feed'] as const;

export const BlockCreate = z.object({
  kind: z.enum(BLOCK_KINDS).default('link'),
  label: z.string().min(1).max(120),
  target: SafeUrl.optional(),
  icon: z.string().max(64).optional(),
  hidden: z.boolean().default(false),
  activeFrom: z.number().int().positive().optional(),
  activeUntil: z.number().int().positive().optional(),
  rules: RuleSet.default([]),
  feed: z.object({
    source: z.enum(['youtube', 'rss', 'github', 'spotify', 'twitch']),
    ref: z.string().min(1).max(256),
    ttlSeconds: z.number().int().min(300).max(86400).default(3600),
  }).optional(),
  after: z.string().max(64).optional(), // id of the block to insert after
});

/**
 * Cross-field rules, applied to both create and patch.
 *
 * `BlockPatch` used to be `BlockCreate.innerType().partial()`, and
 * `.innerType()` unwraps the ZodEffects that carries these checks — so a PATCH
 * could set `activeUntil` before `activeFrom` (hiding the block forever with no
 * way for the UI to say why) or clear a link's target (after which `/r/` 404s).
 * `merged` is the shape after the patch is applied, so a partial update is
 * validated against what the block will actually become.
 */
type BlockShape = {
  kind?: string; target?: string; feed?: unknown;
  activeFrom?: number; activeUntil?: number;
};

export function checkBlockShape(b: BlockShape, ctx: z.RefinementCtx) {
  if (b.kind === 'link' && !b.target) {
    ctx.addIssue({ code: 'custom', path: ['target'], message: 'link blocks need a target' });
  }
  if (b.kind === 'feed' && !b.feed) {
    ctx.addIssue({ code: 'custom', path: ['feed'], message: 'feed blocks need a feed config' });
  }
  if (b.activeFrom && b.activeUntil && b.activeUntil <= b.activeFrom) {
    ctx.addIssue({ code: 'custom', path: ['activeUntil'], message: 'activeUntil must follow activeFrom' });
  }
}

export const BlockCreateChecked = BlockCreate.superRefine(checkBlockShape);

export const BlockPatch = BlockCreate.partial().omit({ after: true });

export const MoveBlock = z.object({
  beforeId: z.string().optional(),
  afterId: z.string().optional(),
}).refine((m) => m.beforeId || m.afterId, 'provide beforeId or afterId');

// ---------- profiles ----------

/**
 * The theme is echoed verbatim to every visitor of the public page, so it is
 * bounded on both axes. An unbounded `z.record(string, string)` let a creator
 * put an arbitrary blob on the profile item and have it served to the world.
 */
const Theme = z
  .record(z.string().max(40), z.string().max(200))
  .refine((t) => Object.keys(t).length <= 40, 'at most 40 theme keys');

export const ProfileCreate = z.object({
  handle: Handle,
  // `displayName` is what the dashboard sends; both spellings land on `title`.
  title: z.string().min(1).max(80),
  bio: z.string().max(400).optional(),
  avatarUrl: SafeUrl.optional(),
  // Nullable, not merely optional: omitting a key means "leave it alone", so
  // without an explicit null there is no way to switch a page from event back
  // to standard. The settings form offers that control.
  eventAt: z.number().int().positive().nullable().optional(),
  theme: Theme.optional(),
});

export const ProfilePatch = ProfileCreate.partial().omit({ handle: true });

export const ClaimHandle = z.object({ handle: Handle });

// ---------- auth ----------

export const Credentials = z.object({
  email: z.string().email().max(254),
  // Long enough to matter, and capped so a megabyte of password cannot be used
  // to burn scrypt time on the server.
  password: z.string().min(8).max(200),
});

export const RefreshInput = z.object({ refreshToken: z.string().min(16).max(512) });

// ---------- resolution ----------

/** A viewer context supplied by the caller, for `resolve` and `preview`. */
export const VisitorContext = z.object({
  geo: z.enum(GEO_BUCKETS).optional(),
  device: z.enum(DEVICES).optional(),
  referrer: z.enum(REFERRERS).optional(),
  lang: z.string().length(2).optional(),
  webview: z.boolean().optional(),
  /** Injected instant, for the simulator's time travel. Ignored on the public path. */
  at: z.number().int().positive().optional(),
});

// ---------- analytics ----------

export const ClickEvent = z.object({
  handle: z.string().max(30),
  blockId: z.string().max(64).optional(),
  ruleId: z.string().max(64).nullable().optional(),
  ts: z.number().int().positive(),
  geo: z.enum(GEO_BUCKETS).optional(),
  device: z.enum(DEVICES).optional(),
  referrer: z.enum(REFERRERS).optional(),
  sid: z.string().max(64).optional(),
});

export const EventBatch = z.object({ events: z.array(ClickEvent).min(1).max(50) });

export type TBlockCreate = z.infer<typeof BlockCreate>;
export type TBlockPatch = z.infer<typeof BlockPatch>;
export type TProfileCreate = z.infer<typeof ProfileCreate>;
export type TRule = z.infer<typeof Rule>;
export type TClickEvent = z.infer<typeof ClickEvent>;
export type TVisitorContext = z.infer<typeof VisitorContext>;
