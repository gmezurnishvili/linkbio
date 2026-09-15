import { wallAt, wallToInstant } from './tz.ts';

// ---------- Schema ----------

export type Ctx = {
  geo?: string;      // 'na' | 'eu' | ...
  device?: string;   // 'mobile' | 'tablet' | 'desktop'
  referrer?: string; // 'ig' | 'tt' | ...
  lang?: string;
  webview?: boolean;
};

export type Condition =
  | { dim: 'geo'; in: string[] }
  | { dim: 'device'; in: string[] }
  | { dim: 'referrer'; in: string[] }
  | { dim: 'lang'; in: string[] }
  | { dim: 'webview'; is: boolean }
  | { dim: 'time'; tz: string; days?: number[]; from: string; to: string };

export type Action =
  | { kind: 'redirect'; target: string; status: 302 | 307 }
  | { kind: 'hide' };

export type Rule = { id: string; priority: number; when: Condition[]; then: Action };

export type Block = {
  id: string;
  defaultTarget: string;
  rules: Rule[];
  activeFrom?: number; // absolute epoch ms
  activeUntil?: number;
};

export type Decision = {
  action: Action;
  ruleId: string | null;
  sMaxAge: number;
  cacheable: boolean;
  reason?: string;
};

const CTX_DIMS = ['geo', 'device', 'referrer', 'lang', 'webview'] as const;
const MAX_S_MAXAGE = 3600;
const MIN_S_MAXAGE = 5;
const HORIZON_MS = 3 * 86400000;

// ---------- Time condition ----------

function parseHm(s: string): [number, number] {
  const [h, m] = s.split(':');
  return [+h, +m];
}

/**
 * Resolve a window edge to an absolute instant.
 * Ambiguous (fall-back) wall times: 'start' takes the earlier occurrence and
 * 'end' the later, so the window is never shorter than the creator intended.
 * Nonexistent (spring-forward) wall times collapse to the first instant the
 * clock exists again, for both roles.
 */
function resolveEdge(
  y: number, mo: number, d: number, hm: [number, number], tz: string, role: 'start' | 'end',
): number {
  const inv = wallToInstant(y, mo, d, hm[0], hm[1], tz);
  if (inv.kind === 'unique') return inv.instants[0];
  if (inv.kind === 'ambiguous') return role === 'start' ? inv.instants[0] : inv.instants[1];
  return inv.after;
}

// Window derivation is the only expensive thing here (Intl.formatToParts is
// ~microseconds and resolveEdge can call it six times). Results depend solely
// on the condition and the UTC day, so memoizing collapses the boundary scan
// from quadratic to linear. The cache is module-level, so it also survives
// across warm Lambda invocations.
const winCache = new Map<string, Array<[number, number]>>();
const WIN_CACHE_MAX = 5000;

function windows(cond: Extract<Condition, { dim: 'time' }>, around: number): Array<[number, number]> {
  const key = `${cond.tz}|${cond.from}|${cond.to}|${cond.days ?? ''}|${Math.floor(around / 86400000)}`;
  const hit = winCache.get(key);
  if (hit) return hit;
  const val = computeWindows(cond, around);
  if (winCache.size >= WIN_CACHE_MAX) winCache.clear();
  winCache.set(key, val);
  return val;
}

function computeWindows(cond: Extract<Condition, { dim: 'time' }>, around: number): Array<[number, number]> {
  const from = parseHm(cond.from);
  const to = parseHm(cond.to);
  const wraps = to[0] * 60 + to[1] <= from[0] * 60 + from[1];
  const out: Array<[number, number]> = [];

  for (let offset = -1; offset <= 4; offset++) {
    const probe = around + offset * 86400000;
    const w = wallAt(probe, cond.tz);
    if (cond.days && !cond.days.includes(w.weekday)) continue;

    const start = resolveEdge(w.year, w.month, w.day, from, cond.tz, 'start');
    const endDay = wraps ? new Date(Date.UTC(w.year, w.month - 1, w.day + 1)) : null;
    const end = endDay
      ? resolveEdge(
          endDay.getUTCFullYear(), endDay.getUTCMonth() + 1, endDay.getUTCDate(),
          to, cond.tz, 'end',
        )
      : resolveEdge(w.year, w.month, w.day, to, cond.tz, 'end');

    if (end > start) out.push([start, end]);
  }
  return out;
}

function timeActiveAt(cond: Extract<Condition, { dim: 'time' }>, t: number): boolean {
  return windows(cond, t).some(([s, e]) => t >= s && t < e);
}

// ---------- Matching ----------

function matches(c: Condition, ctx: Ctx, t: number): boolean {
  switch (c.dim) {
    case 'time': return timeActiveAt(c, t);
    case 'webview': return ctx.webview === c.is;
    default: {
      const v = ctx[c.dim];
      return v !== undefined && c.in.includes(v);
    }
  }
}

/** Dimensions a block's rules depend on — must be a subset of the edge cache-key mask. */
export function requiredDims(block: Block): Set<string> {
  const s = new Set<string>();
  for (const r of block.rules) {
    for (const c of r.when) if (c.dim !== 'time') s.add(c.dim);
  }
  return s;
}

// ---------- Boundaries ----------

/** Candidate instants > now at which some time-dependent predicate could flip. */
function boundaryCandidates(block: Block, now: number): number[] {
  const out: number[] = [];
  const horizon = now + HORIZON_MS;

  if (block.activeFrom && block.activeFrom > now) out.push(block.activeFrom);
  if (block.activeUntil && block.activeUntil > now) out.push(block.activeUntil);

  for (const r of block.rules) {
    for (const c of r.when) {
      if (c.dim !== 'time') continue;
      for (const [s, e] of windows(c, now)) {
        if (s > now && s <= horizon) out.push(s);
        if (e > now && e <= horizon) out.push(e);
      }
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/**
 * Earliest instant at which the decision actually changes.
 * Every candidate is verified by re-evaluating on both sides, so a mistake in
 * the edge math produces a short TTL rather than a wrong destination.
 */
function nextBoundary(block: Block, ctx: Ctx, now: number): number | null {
  const current = pick(block, ctx, now);
  for (const c of boundaryCandidates(block, now)) {
    const after = pick(block, ctx, c);
    if (after.ruleId !== current.ruleId || JSON.stringify(after.action) !== JSON.stringify(current.action)) {
      return c;
    }
  }
  return null;
}

// ---------- Evaluation ----------

function pick(block: Block, ctx: Ctx, t: number): { action: Action; ruleId: string | null } {
  if (block.activeFrom && t < block.activeFrom) return { action: { kind: 'hide' }, ruleId: null };
  if (block.activeUntil && t >= block.activeUntil) return { action: { kind: 'hide' }, ruleId: null };

  const sorted = [...block.rules].sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : 1));
  for (const r of sorted) {
    if (r.when.every((c) => matches(c, ctx, t))) return { action: r.then, ruleId: r.id };
  }
  return { action: { kind: 'redirect', target: block.defaultTarget, status: 302 }, ruleId: null };
}

export function evaluate(block: Block, ctx: Ctx, maskDims: Set<string>, now: number): Decision {
  const needed = requiredDims(block);
  for (const d of needed) {
    if (!maskDims.has(d)) {
      const { action, ruleId } = pick(block, ctx, now);
      return { action, ruleId, sMaxAge: 0, cacheable: false, reason: `mask missing ${d}` };
    }
  }

  const { action, ruleId } = pick(block, ctx, now);
  const b = nextBoundary(block, ctx, now);
  if (b === null) {
    return { action, ruleId, sMaxAge: MAX_S_MAXAGE, cacheable: true };
  }
  const secs = Math.floor((b - now) / 1000);
  return {
    action,
    ruleId,
    sMaxAge: Math.max(MIN_S_MAXAGE, Math.min(MAX_S_MAXAGE, secs)),
    cacheable: true,
  };
}

export function cacheControl(d: Decision): string {
  return d.cacheable ? `max-age=0, s-maxage=${d.sMaxAge}` : 'no-store';
}

// Exported for tests.
export const _internal = { windows, timeActiveAt, boundaryCandidates, pick };
