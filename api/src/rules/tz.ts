// Timezone primitives built on Intl only. No dependencies, Lambda-safe.

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export type Wall = {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday
};

/** Local wall-clock fields for an absolute instant, in tz. */
export function wallAt(instant: number, tz: string): Wall {
  const parts = formatter(tz).formatToParts(new Date(instant));
  const g: Record<string, string> = {};
  for (const p of parts) if (p.type !== 'literal') g[p.type] = p.value;
  return {
    year: +g.year,
    month: +g.month,
    day: +g.day,
    hour: +g.hour,
    minute: +g.minute,
    second: +g.second,
    weekday: WEEKDAY[g.weekday],
  };
}

/** UTC offset in ms at a given instant (positive east of Greenwich). */
export function offsetAt(instant: number, tz: string): number {
  const w = wallAt(instant, tz);
  const asUTC = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  // Round to the nearest second to absorb sub-second formatting drift.
  return Math.round((asUTC - Math.floor(instant / 1000) * 1000) / 1000) * 1000;
}

export type Inversion =
  | { kind: 'unique'; instants: [number] }
  | { kind: 'ambiguous'; instants: [number, number] } // fall-back: earlier, later
  | { kind: 'gap'; before: number; after: number }; // spring-forward: last instant before, first after

/**
 * Invert a local wall-clock time to absolute instant(s).
 *
 * Two-probe method: guess using the offset at the naive UTC interpretation,
 * then re-probe with the offset at that guess. Each candidate is verified by
 * formatting it back — an unverified candidate means the wall time is inside
 * a DST gap.
 */
export function wallToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): Inversion {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  // Probe from both sides of the day. On a fall-back date the two sides carry
  // different offsets, which is what surfaces the second (later) occurrence —
  // a single probe seeded from `naive` finds only one of them.
  const candidates = new Set<number>();
  for (const seed of [naive - 86400000, naive, naive + 86400000]) {
    const probe = naive - offsetAt(seed, tz);
    candidates.add(probe);
    candidates.add(naive - offsetAt(probe, tz));
  }

  const verified: number[] = [];
  for (const c of candidates) {
    const w = wallAt(c, tz);
    if (
      w.year === year && w.month === month && w.day === day &&
      w.hour === hour && w.minute === minute
    ) verified.push(c);
  }
  verified.sort((a, b) => a - b);

  if (verified.length === 1) return { kind: 'unique', instants: [verified[0]] };
  if (verified.length >= 2) {
    return { kind: 'ambiguous', instants: [verified[0], verified[verified.length - 1]] };
  }

  // Gap. Binary search the transition instant bracketing the requested wall time.
  const lo = naive - offsetAt(naive - 86400000, tz) - 86400000;
  const hi = naive - offsetAt(naive + 86400000, tz) + 86400000;
  const transition = findTransition(lo, hi, tz);
  return { kind: 'gap', before: transition - 1, after: transition };
}

/** Earliest instant in (lo, hi] where the UTC offset differs from offsetAt(lo). */
function findTransition(lo: number, hi: number, tz: string): number {
  const base = offsetAt(lo, tz);
  let a = lo;
  let b = hi;
  while (b - a > 1) {
    const mid = a + Math.floor((b - a) / 2);
    if (offsetAt(mid, tz) === base) a = mid;
    else b = mid;
  }
  return b;
}
