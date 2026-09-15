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
const FIRST = A[0]!;
const LAST = A[BASE - 1]!;

/** Thrown when no key can exist between two neighbours and the list must be rebalanced. */
export class RankExhausted extends Error {}

function valueAt(key: string, index: number, fallback: string): number {
  const ch = key[index];
  return A.indexOf(ch === undefined ? fallback : ch);
}

/** A rank strictly between `a` and `b`. Null means "open end". */
export function rankBetween(a: string | null, b: string | null): string {
  const lo = a ?? '';
  const hi = b;

  if (a !== null && b !== null && a >= b) {
    throw new RangeError(`rankBetween requires a < b (got ${a}, ${b})`);
  }
  for (const key of [a, b]) {
    if (key !== null && [...key].some((ch) => A.indexOf(ch) === -1)) {
      throw new RangeError(`invalid rank char in ${key}`);
    }
  }

  const out = midpoint(lo, hi);
  // A silently mis-sorted key is the one failure this module exists to prevent,
  // and the check costs two string compares.
  if (a !== null && !(out > a)) throw new Error(`rank ${out} not after ${a}`);
  if (b !== null && !(out < b)) throw new Error(`rank ${out} not before ${b}`);
  return out;
}

/**
 * A key strictly between `lo` and `hi`, both already known to be in order.
 *
 * The digits the bounds agree on are copied verbatim before splitting the first
 * one they differ at. The previous version descended past a digit that merely
 * *equalled* the upper bound's while setting `hi = ''`, which discards the
 * bound entirely — so `rankBetween('0a', '0b')` produced `'0n'` and then threw
 * its own assertion. That is the ordinary case once keys grow past one digit,
 * which made every insert between two adjacent blocks a 500.
 */
function midpoint(lo: string, hi: string | null): string {
  if (hi !== null) {
    let shared = 0;
    while (shared < hi.length && valueAt(lo, shared, FIRST) === valueAt(hi, shared, LAST)) {
      shared += 1;
    }
    if (shared >= hi.length) {
      // `lo` reads as `hi` padded with the lowest digit, so nothing sorts
      // between them. Only a key ending in '0' can get here, and `midpoint`
      // never mints one — but a rank written by an older build might be.
      throw new RankExhausted(`no rank fits between ${lo || '(start)'} and ${hi}`);
    }
    if (shared > 0) return hi.slice(0, shared) + midpoint(lo.slice(shared), hi.slice(shared));
  }

  const low = valueAt(lo, 0, FIRST);
  const high = hi === null ? BASE : valueAt(hi, 0, LAST);

  if (high - low > 1) return A[Math.floor((low + high) / 2)]!;

  // The two digits are neighbours. If `hi` has more digits we can sit on its
  // first one alone; otherwise keep `lo`'s digit and find room one place down,
  // where the upper bound no longer applies.
  if (hi !== null && hi.length > 1) return hi.slice(0, 1);
  return A[low]! + midpoint(lo.slice(1), null);
}

/** Evenly spaced ranks for seeding a brand-new list. */
export function initialRanks(n: number): string[] {
  if (n <= 0) return [];

  // One digit runs out around 30 rows. Widen until every gap is at least two
  // values across, so the keys stay distinct and there is somewhere to insert.
  let width = 1;
  while (BASE ** width < 2 * (n + 1)) width += 1;
  const span = BASE ** width;

  return Array.from({ length: n }, (_, i) => {
    const value = Math.floor((span * (i + 1)) / (n + 1));
    // A key ending in the lowest digit has nothing below it. Step off it; the
    // gaps are wide enough that this cannot collide with the next key.
    return encode(value % BASE === 0 ? value + 1 : value, width);
  });
}

function encode(value: number, width: number): string {
  let out = '';
  let rest = value;
  for (let i = 0; i < width; i += 1) {
    out = A[rest % BASE]! + out;
    rest = Math.floor(rest / BASE);
  }
  return out;
}
