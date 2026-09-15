import { z } from 'zod';

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

/** Blocks http(s) only, and rejects hosts that could be used to pivot inside a VPC. */
export const SafeUrl = z.string().url().max(2048).superRefine((v, ctx) => {
  let u: URL;
  try { u = new URL(v); } catch { return ctx.addIssue({ code: 'custom', message: 'invalid url' }); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    ctx.addIssue({ code: 'custom', message: 'only http(s) targets allowed' });
  }
  const h = u.hostname.toLowerCase();
  if (
    h === 'localhost' || h.endsWith('.localhost') || h === '169.254.169.254' ||
    /^(10|127)\./.test(h) || /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.endsWith('.internal')
  ) {
    ctx.addIssue({ code: 'custom', message: 'private or link-local hosts not allowed' });
  }
});

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

/** One rule must not carry two conditions on the same dimension — they would AND to nothing useful. */
export const RuleSet = z.array(Rule).max(20).superRefine((rules, ctx) => {
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
  after: z.string().max(64).optional(), // rank of the block to insert after
}).superRefine((b, ctx) => {
  if (b.kind === 'link' && !b.target) {
    ctx.addIssue({ code: 'custom', path: ['target'], message: 'link blocks need a target' });
  }
  if (b.kind === 'feed' && !b.feed) {
    ctx.addIssue({ code: 'custom', path: ['feed'], message: 'feed blocks need a feed config' });
  }
  if (b.activeFrom && b.activeUntil && b.activeUntil <= b.activeFrom) {
    ctx.addIssue({ code: 'custom', path: ['activeUntil'], message: 'activeUntil must follow activeFrom' });
  }
});

export const BlockPatch = BlockCreate.innerType().partial().omit({ after: true });

export const MoveBlock = z.object({
  beforeId: z.string().optional(),
  afterId: z.string().optional(),
}).refine((m) => m.beforeId || m.afterId, 'provide beforeId or afterId');

// ---------- profiles ----------

export const ProfileCreate = z.object({
  handle: Handle,
  title: z.string().min(1).max(80),
  bio: z.string().max(400).optional(),
  avatarUrl: SafeUrl.optional(),
  theme: z.record(z.string(), z.string()).optional(),
});

export const ProfilePatch = ProfileCreate.partial().omit({ handle: true });

export const ClaimHandle = z.object({ handle: Handle });

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
