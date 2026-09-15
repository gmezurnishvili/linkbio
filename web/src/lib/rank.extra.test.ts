import { describe, expect, it } from "vitest";
import { byRank, initialRanks, rankBetween } from "./rank";

describe("rankBetween bounds", () => {
  it("stays under an upper bound whose digits it has to walk through", () => {
    // The old version copied the bound's own digits and then split against the
    // top of the alphabet, landing above it: rankBetween(null, "1") gave "1U".
    for (const before of ["1", "01", "0a", "0z", "a", "zz"]) {
      const key = rankBetween(null, before);
      expect(key < before, `${key} should sort below ${before}`).toBe(true);
    }
  });

  it("refuses a bound nothing can sort below instead of returning one above it", () => {
    // Nothing precedes "0" in this alphabet. The old version answered "0U".
    expect(() => rankBetween(null, "0")).toThrow();
    expect(() => rankBetween(null, "00")).toThrow();
  });

  it("never mints a key that would create such a bound", () => {
    const seen = [
      rankBetween(null, null),
      rankBetween(null, "1"),
      rankBetween("1", "2"),
      rankBetween("z", null),
      ...initialRanks(200),
    ];
    for (const key of seen) expect(key.endsWith("0")).toBe(false);
  });

  it("splits between neighbours that share a prefix", () => {
    const key = rankBetween("0a", "0b");
    expect(key > "0a").toBe(true);
    expect(key < "0b").toBe(true);
  });

  it("never mints a key with nothing below it", () => {
    let key: string | null = null;
    for (let i = 0; i < 50; i += 1) {
      const next: string = rankBetween(null, key);
      if (key !== null) expect(next < key).toBe(true);
      key = next;
    }
  });

  it("keeps splitting the same seam without drifting out of bounds", () => {
    let lo = "0";
    const hi = "1";
    for (let i = 0; i < 60; i += 1) {
      const next = rankBetween(lo, hi);
      expect(next > lo).toBe(true);
      expect(next < hi).toBe(true);
      lo = next;
    }
  });

  it("holds the invariant across an exhaustive sweep of short bounds", () => {
    const keys = ["0", "1", "2", "z", "00", "0z", "10", "1z", "zz", "0a", "0b", "a", "y"];
    for (const after of [null, ...keys]) {
      for (const before of [null, ...keys]) {
        if (after !== null && before !== null && after >= before) continue;
        let key: string;
        try {
          key = rankBetween(after, before);
        } catch {
          // Refusing is fine; minting a key outside the bounds is not.
          continue;
        }
        expect(after === null || key > after, `${key} vs after ${after}`).toBe(true);
        expect(before === null || key < before, `${key} vs before ${before}`).toBe(true);
      }
    }
  });

  it("refuses the one gap that cannot be filled instead of guessing", () => {
    expect(() => rankBetween("1", "10")).toThrow();
  });
});

describe("initialRanks", () => {
  it("is strictly increasing at every size, well past one digit", () => {
    for (const count of [0, 1, 2, 5, 61, 62, 80, 500, 4000]) {
      const ranks = initialRanks(count);
      expect(ranks).toHaveLength(count);
      expect(new Set(ranks).size).toBe(count);
      expect([...ranks].sort(compare)).toEqual(ranks);
    }
  });

  it("leaves room to insert between and around the seeded keys", () => {
    const ranks = initialRanks(80);
    expect(rankBetween(null, ranks[0]!) < ranks[0]!).toBe(true);
    for (let i = 1; i < ranks.length; i += 1) {
      const key = rankBetween(ranks[i - 1]!, ranks[i]!);
      expect(key > ranks[i - 1]!).toBe(true);
      expect(key < ranks[i]!).toBe(true);
    }
    expect(rankBetween(ranks[ranks.length - 1]!, null) > ranks[ranks.length - 1]!).toBe(true);
  });
});

function compare(a: string, b: string): number {
  return byRank({ rank: a }, { rank: b });
}
