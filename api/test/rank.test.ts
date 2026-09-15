import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Fractional indexing, on its own.
 *
 * `rank.ts` imports nothing, so this file needs no configuration — but it is
 * the module a mis-sorted key would come from, and a mis-sorted key is a block
 * list that silently reorders itself for every viewer. The four cases the API
 * suite used to carry live here now, alongside the seams the rewrite of
 * `rankBetween` exists to fix.
 */
const { rankBetween, initialRanks, RankExhausted } = await import('../src/rank.ts');

const A = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * Every call in this file goes through here.
 *
 * The bound invariant is the whole contract — a key that is not strictly
 * between its neighbours sorts somewhere nobody asked for — so it is asserted
 * on every single result rather than on the handful a test remembers to check.
 */
function between(a: string | null, b: string | null): string {
  const out = rankBetween(a, b);
  assert.ok(typeof out === 'string' && out.length > 0, `empty rank for (${a}, ${b})`);
  assert.ok([...out].every((ch) => A.includes(ch)), `rank ${out} has a char outside the alphabet`);
  if (a !== null) assert.ok(out > a, `${out} must sort after ${a}`);
  if (b !== null) assert.ok(out < b, `${out} must sort before ${b}`);
  return out;
}

// ---------------------------------------------------------------- basics

describe('fractional ranking', () => {
  test('midpoint lands strictly between neighbours', () => {
    const a = between(null, null);
    const b = between(a, null);
    const mid = between(a, b);
    assert.ok(a < mid && mid < b, `${a} < ${mid} < ${b}`);
  });

  test('initial ranks are ascending', () => {
    const r = initialRanks(10);
    assert.deepEqual(r, [...r].sort());
  });

  test('rejects inverted bounds', () => {
    assert.throws(() => rankBetween('b', 'a'), RangeError);
  });

  test('rejects equal bounds', () => {
    assert.throws(() => rankBetween('a', 'a'), RangeError);
  });

  test('rejects a character outside the alphabet', () => {
    assert.throws(() => rankBetween('a!', 'b'), RangeError);
    assert.throws(() => rankBetween(null, 'b/c'), RangeError);
  });

  test('initialRanks(0) is empty and never negative', () => {
    assert.deepEqual(initialRanks(0), []);
    assert.deepEqual(initialRanks(-3), []);
  });
});

// ---------------------------------------------------------------- the seam that used to throw

describe('adjacent single-digit seams', () => {
  /**
   * The case the rewrite exists for.
   *
   * The old `midpoint` descended past a digit that merely *equalled* the upper
   * bound's while setting `hi = ''`, which discards the bound — so this
   * produced `'0n'`, sailed past `'0b'`, and then tripped its own assertion.
   * That is the ordinary shape of a rank once a list has been reordered twice,
   * which made inserting between two adjacent blocks a 500.
   */
  test("rankBetween('0a','0b') returns a key in the gap", () => {
    const out = between('0a', '0b');
    assert.ok(out.startsWith('0a'), `expected a key under 0a, got ${out}`);
  });

  test('every adjacent pair of one-digit keys is splittable', () => {
    for (let i = 0; i < A.length - 1; i++) {
      between(A[i]!, A[i + 1]!);
    }
  });

  test('every adjacent pair of two-digit keys sharing a prefix is splittable', () => {
    for (let i = 0; i < A.length - 1; i++) {
      between(`z${A[i]}`, `z${A[i + 1]}`);
    }
  });

  test('a seam between keys of different lengths is splittable', () => {
    between('0a', '0aa');
    between('a', 'aa');
    between('0z', '1');
    between('Az', 'B');
  });
});

// ---------------------------------------------------------------- repeated subdivision

describe('repeated subdivision', () => {
  test('survives repeated subdivision at the same spot', () => {
    let lo = between(null, null);
    const hi = between(lo, null);
    for (let i = 0; i < 200; i++) {
      lo = between(lo, hi);
    }
  });

  // The other direction: walking the upper bound down onto a fixed lower one.
  // It grows keys the same way but through a different branch of `midpoint`.
  test('survives subdivision descending onto a fixed lower bound', () => {
    const lo = between(null, null);
    let hi = between(lo, null);
    for (let i = 0; i < 200; i++) {
      hi = between(lo, hi);
    }
  });

  test('splitting a tight seam 500 times keeps every key ordered', () => {
    let lo = '0a';
    const hi = '0b';
    const produced: string[] = [];
    for (let i = 0; i < 500; i++) {
      lo = between(lo, hi);
      produced.push(lo);
    }
    assert.deepEqual(produced, [...produced].sort(), 'produced keys are not in sorted order');
    assert.equal(new Set(produced).size, produced.length, 'a key was minted twice');
  });

  test('chained prepends stay strictly decreasing', () => {
    let head = between(null, null);
    const produced = [head];
    for (let i = 0; i < 300; i++) {
      head = between(null, head);
      produced.push(head);
    }
    assert.deepEqual([...produced].reverse(), [...produced].sort(), 'prepends are not descending');
    assert.equal(new Set(produced).size, produced.length);
  });

  test('chained appends stay strictly increasing', () => {
    let tail = between(null, null);
    const produced = [tail];
    for (let i = 0; i < 300; i++) {
      tail = between(tail, null);
      produced.push(tail);
    }
    assert.deepEqual(produced, [...produced].sort(), 'appends are not ascending');
  });
});

// ---------------------------------------------------------------- exhaustion

describe('exhausted seams', () => {
  /**
   * There genuinely is no key between these, and the only honest answer is to
   * say so — a bad key here is a silently mis-sorted list. The block routes
   * catch `RankExhausted` and rebalance; nothing catches a bad key.
   */
  const unfillable: Array<[string | null, string]> = [
    [null, '0'],
    [null, '00'],
    [null, '000'],
    ['0', '00'],
    ['00', '000'],
    ['a', 'a0'],
    ['zz', 'zz0'],
  ];

  for (const [a, b] of unfillable) {
    test(`throws RankExhausted between ${a ?? '(start)'} and ${b}`, () => {
      assert.throws(() => rankBetween(a, b), RankExhausted);
    });
  }

  test('RankExhausted is distinguishable from a caller error', () => {
    // The routes rebalance on RankExhausted and rethrow everything else, so the
    // two must not be the same class.
    assert.ok(new RankExhausted('x') instanceof Error);
    assert.ok(!(new RankExhausted('x') instanceof RangeError));
    assert.throws(() => rankBetween('b', 'a'), (e: unknown) => e instanceof RangeError && !(e instanceof RankExhausted));
  });

  // A rank ending in the lowest digit is the only kind with nothing below it,
  // and `initialRanks` steps off those deliberately so a fresh list never
  // contains one.
  test('initialRanks never mints a key ending in the lowest digit', () => {
    for (const n of [1, 2, 3, 10, 29, 30, 31, 61, 62, 80, 200, 1000, 4000]) {
      for (const r of initialRanks(n)) {
        assert.notEqual(r[r.length - 1], A[0], `initialRanks(${n}) produced ${r}`);
      }
    }
  });
});

// ---------------------------------------------------------------- seeding

describe('initialRanks', () => {
  const counts = [1, 2, 3, 5, 10, 29, 30, 31, 61, 62, 63, 80, 199, 200, 1000, 4000];

  for (const n of counts) {
    test(`${n} seeded ranks are unique, monotonic and insertable`, () => {
      const r = initialRanks(n);
      assert.equal(r.length, n);
      assert.equal(new Set(r).size, n, 'duplicate rank');
      for (let i = 1; i < n; i++) {
        assert.ok(r[i - 1]! < r[i]!, `${r[i - 1]} must sort before ${r[i]}`);
      }
      // Every seam a drag could land in has to have room, including the two
      // open ends. A list you cannot insert into is a list you cannot reorder.
      between(null, r[0]!);
      for (let i = 0; i < n - 1; i++) between(r[i]!, r[i + 1]!);
      between(r[n - 1]!, null);
    });
  }

  test('all ranks at one count share a width, so plain string compare sorts them', () => {
    for (const n of counts) {
      const widths = new Set(initialRanks(n).map((r) => r.length));
      assert.equal(widths.size, 1, `initialRanks(${n}) mixed widths: ${[...widths]}`);
    }
  });

  test('a rebalance of a scrambled list restores order under the new ranks', () => {
    // What `repo.rebalanceBlocks` does: take the list in its current order and
    // re-seed it. The i-th item must still be i-th afterwards.
    const labels = Array.from({ length: 80 }, (_, i) => `b${i}`);
    const ranks = initialRanks(labels.length);
    const rows = labels.map((label, i) => ({ label, rank: ranks[i]! }));
    const sorted = [...rows].sort((a, b) => (a.rank < b.rank ? -1 : 1));
    assert.deepEqual(sorted.map((r) => r.label), labels);
  });
});
