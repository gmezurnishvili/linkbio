/**
 * Fractional indexing over a base-62 alphabet.
 *
 * Block order lives in the DynamoDB sort key (`BLOCK#<rank>#<id>`), so a drag
 * must produce a key that sorts strictly between its new neighbours without
 * touching any other row. Integer positions would rewrite every block below the
 * insertion point; this rewrites exactly one.
 */

const A = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = A.length;

/** A rank strictly between `a` and `b`. Null means "open end". */
export function rankBetween(a: string | null, b: string | null): string {
  let lo = a ?? '';
  let hi = b ?? '';

  if (lo && hi && lo >= hi) {
    throw new RangeError(`rankBetween requires a < b (got ${lo}, ${hi})`);
  }

  let prefix = '';
  let i = 0;

  for (;;) {
    const ca = i < lo.length ? A.indexOf(lo[i]) : -1;
    const cb = i < hi.length ? A.indexOf(hi[i]) : BASE;

    if (ca === -1 && i < lo.length) throw new RangeError(`invalid rank char in ${lo}`);
    if (cb === -1) throw new RangeError(`invalid rank char in ${hi}`);

    if (cb - ca > 1) {
      const out = prefix + A[Math.floor((ca + cb) / 2)];
      assertBetween(out, a, b);
      return out;
    }

    // Neighbours are adjacent at this digit. Adopt `a`'s digit and keep
    // descending, with the upper bound now unbounded.
    prefix += ca === -1 ? A[0] : A[ca];
    hi = '';
    i++;
  }
}

function assertBetween(out: string, a: string | null, b: string | null) {
  if (a !== null && !(out > a)) throw new Error(`rank ${out} not after ${a}`);
  if (b !== null && !(out < b)) throw new Error(`rank ${out} not before ${b}`);
}

/** Evenly spaced ranks for seeding a brand-new list. */
export function initialRanks(n: number): string[] {
  const out: string[] = [];
  let prev: string | null = null;
  for (let i = 0; i < n; i++) {
    prev = rankBetween(prev, null);
    out.push(prev);
  }
  return out;
}
