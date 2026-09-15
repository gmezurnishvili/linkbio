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

  let out = "";
  let i = 0;

  for (;;) {
    const lo = valueAt(after, i, FIRST);
    const hi = valueAt(before, i, LAST);

    if (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      return out + DIGITS[mid]!;
    }

    // No room at this position. Keep the lower bound's digit and descend.
    if (after !== null && i < after.length) {
      out += after[i]!;
    } else {
      // We are below `before` at this position; take one step under it and
      // append a midpoint on the next, which keeps the result shorter.
      out += DIGITS[lo]!;
    }
    i += 1;

    if (i > 64) throw new Error("rankBetween: key grew past the sane limit");
  }
}

/** Ranks for a fresh list, spaced so the common case never needs a rebalance. */
export function initialRanks(count: number): string[] {
  const step = Math.max(1, Math.floor(DIGITS.length / (count + 1)));
  return Array.from({ length: count }, (_, i) => DIGITS[Math.min(DIGITS.length - 1, (i + 1) * step)]!);
}

export function byRank<T extends { rank: string }>(a: T, b: T): number {
  return a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0;
}

export { digit as _digit };
