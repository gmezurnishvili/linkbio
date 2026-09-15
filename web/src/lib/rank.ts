/**
 * Base-62 fractional index, optimistic use only.
 *
 * The server mints the real key on /move. This exists so a dragged row has a
 * plausible rank in the query cache during the round trip, and so sorting stays
 * stable if two drags overlap. Never persist a key produced here, and never
 * treat the result as authoritative once the server responds.
 */

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const FIRST = DIGITS[0]!;
const LAST = DIGITS[DIGITS.length - 1]!;

function digit(at: number): number {
  const i = DIGITS.indexOf(at === -1 ? FIRST : DIGITS[at] ?? FIRST);
  return i;
}

function valueAt(key: string | null, index: number, fallback: string): number {
  if (key === null) return DIGITS.indexOf(fallback);
  const ch = key[index];
  return ch === undefined ? DIGITS.indexOf(fallback) : DIGITS.indexOf(ch);
}

/** A key strictly between `after` and `before`. Either bound may be null. */
export function rankBetween(after: string | null, before: string | null): string {
  if (after !== null && before !== null && after >= before) {
    throw new Error(`rankBetween: ${after} is not below ${before}`);
  }

  const out = midpoint(after ?? "", before);
  // Cheap enough to always check, and a silently mis-sorted key is the one
  // failure mode this module exists to prevent.
  if (after !== null && out <= after) throw new Error(`rankBetween: ${out} is not above ${after}`);
  if (before !== null && out >= before) {
    throw new Error(`rankBetween: ${out} is not below ${before}`);
  }
  return out;
}

/**
 * A key strictly between `lo` and `hi`, both already known to be in order.
 *
 * The digits the two bounds agree on are copied verbatim before splitting the
 * first one they differ at. Descending past a digit that equals `hi`'s while
 * treating the rest as unbounded is what let the old version overshoot: only a
 * digit strictly under `hi`'s releases the upper bound.
 */
function midpoint(lo: string, hi: string | null): string {
  if (hi !== null) {
    let shared = 0;
    while (valueAt(lo, shared, FIRST) === valueAt(hi, shared, LAST) && shared < hi.length) {
      shared += 1;
    }
    if (shared >= hi.length) {
      // `lo` already reads as `hi` padded with zeroes, so nothing sorts between
      // them. Only a key ending in the lowest digit can get here.
      throw new Error(`rankBetween: no key fits between ${lo || "(start)"} and ${hi}`);
    }
    if (shared > 0) return hi.slice(0, shared) + midpoint(lo.slice(shared), hi.slice(shared));
  }

  const low = valueAt(lo, 0, FIRST);
  const high = hi === null ? DIGITS.length : valueAt(hi, 0, LAST);

  if (high - low > 1) return DIGITS[Math.floor((low + high) / 2)]!;

  // The two digits are neighbours. If `hi` has more to it we can sit on its
  // first digit alone; otherwise keep `lo`'s digit and find room one place down,
  // where the upper bound no longer applies.
  if (hi !== null && hi.length > 1) return hi.slice(0, 1);
  return DIGITS[low]! + midpoint(lo.slice(1), null);
}

/** Ranks for a fresh list, spaced so the common case never needs a rebalance. */
export function initialRanks(count: number): string[] {
  if (count <= 0) return [];

  // One digit runs out around 30 rows. Widen until every gap is at least two
  // values wide, which keeps the keys distinct and leaves somewhere to insert.
  let width = 1;
  while (DIGITS.length ** width < 2 * (count + 1)) width += 1;
  const span = DIGITS.length ** width;

  return Array.from({ length: count }, (_, i) => {
    const value = Math.floor((span * (i + 1)) / (count + 1));
    // A key ending in the lowest digit has nothing below it, so step off it.
    // The gaps are wide enough that this cannot collide with the next key.
    return encode(value % DIGITS.length === 0 ? value + 1 : value, width);
  });
}

function encode(value: number, width: number): string {
  let out = "";
  let rest = value;
  for (let i = 0; i < width; i += 1) {
    out = DIGITS[rest % DIGITS.length]! + out;
    rest = Math.floor(rest / DIGITS.length);
  }
  return out;
}

export function byRank<T extends { rank: string }>(a: T, b: T): number {
  return a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0;
}

export { digit as _digit };
