import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wallToInstant, wallAt } from '../src/rules/tz.ts';
import { evaluate, cacheControl, _internal, type Block } from '../src/rules/rules.ts';

function check(name: string, actual: unknown, expected: unknown) {
  test(name, () => assert.deepEqual(actual, expected));
}
const iso = (t: number) => new Date(t).toISOString();
const local = (t: number, tz: string) => {
  const w = wallAt(t, tz);
  return `${w.year}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')} ` +
    `${String(w.hour).padStart(2, '0')}:${String(w.minute).padStart(2, '0')}`;
};

// --- wall-time inversion ---
const NY = 'America/New_York';

// Spring forward: 2026-03-08, 02:00 -> 03:00 EDT. 02:30 does not exist.
const gap = wallToInstant(2026, 3, 8, 2, 30, NY);
check('02:30 on spring-forward day is a gap', gap.kind, 'gap');
if (gap.kind === 'gap') {
  check('gap resolves to 03:00 local', local(gap.after, NY), '2026-03-08 03:00');
  check('gap instant is 07:00Z', iso(gap.after), '2026-03-08T07:00:00.000Z');
}

// Fall back: 2026-11-01, 02:00 -> 01:00 EST. 01:30 happens twice.
const amb = wallToInstant(2026, 11, 1, 1, 30, NY);
check('01:30 on fall-back day is ambiguous', amb.kind, 'ambiguous');
if (amb.kind === 'ambiguous') {
  check('earlier occurrence is 05:30Z', iso(amb.instants[0]), '2026-11-01T05:30:00.000Z');
  check('later occurrence is 06:30Z', iso(amb.instants[1]), '2026-11-01T06:30:00.000Z');
}

// Lord Howe Island: 30-minute DST shift, 2026-10-04 02:00 -> 02:30.
const LH = 'Australia/Lord_Howe';
const lh = wallToInstant(2026, 10, 4, 2, 15, LH);
check('Lord Howe 02:15 is a 30-min gap', lh.kind, 'gap');

// Ordinary time, half-hour zone.
const ist = wallToInstant(2026, 6, 1, 9, 0, 'Asia/Kolkata');
check('Kolkata 09:00 is unique', ist.kind, 'unique');
if (ist.kind === 'unique') check('Kolkata 09:00 = 03:30Z', iso(ist.instants[0]), '2026-06-01T03:30:00.000Z');

// --- window resolution across DST ---

const springBlock: Block = {
  id: 'b1', defaultTarget: 'https://default.example',
  rules: [{
    id: 'r1', priority: 10,
    when: [{ dim: 'time', tz: NY, from: '02:30', to: '10:00' }],
    then: { kind: 'redirect', target: 'https://live.example', status: 302 },
  }],
};
const springWin = _internal.windows(springBlock.rules[0].when[0] as any, Date.UTC(2026, 2, 8, 12));
const sw = springWin.find((w) => local(w[0], NY).startsWith('2026-03-08'))!;
check('spring-forward window starts at 03:00 local', local(sw[0], NY), '2026-03-08 03:00');
check('spring-forward window is 7h, not 7.5h', (sw[1] - sw[0]) / 3600000, 7);

const fallBlock: Block = {
  id: 'b2', defaultTarget: 'https://default.example',
  rules: [{
    id: 'r1', priority: 10,
    when: [{ dim: 'time', tz: NY, from: '01:30', to: '03:00' }],
    then: { kind: 'redirect', target: 'https://live.example', status: 302 },
  }],
};
const fallWin = _internal.windows(fallBlock.rules[0].when[0] as any, Date.UTC(2026, 10, 1, 12));
const fw = fallWin.find((w) => local(w[0], NY).startsWith('2026-11-01'))!;
check('fall-back window starts at first 01:30 (05:30Z)', iso(fw[0]), '2026-11-01T05:30:00.000Z');
check('fall-back window spans 2.5h of real time', (fw[1] - fw[0]) / 3600000, 2.5);

// --- wrapping window ---
const wrapCond = { dim: 'time' as const, tz: NY, days: [5], from: '22:00', to: '02:00' };
// Friday 2026-06-05 23:00 local = 2026-06-06 03:00Z
check('active Fri 23:00', _internal.timeActiveAt(wrapCond, Date.UTC(2026, 5, 6, 3)), true);
// Saturday 2026-06-06 01:00 local = 05:00Z — still inside the Friday window
check('active Sat 01:00 (wrapped)', _internal.timeActiveAt(wrapCond, Date.UTC(2026, 5, 6, 5)), true);
// Saturday 03:00 local = 07:00Z — closed
check('inactive Sat 03:00', _internal.timeActiveAt(wrapCond, Date.UTC(2026, 5, 6, 7)), false);
// Saturday 23:00 local — Saturday is not a listed start day
check('inactive Sat 23:00', _internal.timeActiveAt(wrapCond, Date.UTC(2026, 5, 7, 3)), false);

// --- max-age to next boundary ---
const all = new Set(['geo', 'device', 'referrer', 'lang', 'webview']);

// 17:00 NY on a normal day, window opens 18:00 -> 3600s
const now1 = Date.UTC(2026, 5, 10, 21); // 17:00 EDT
const b3: Block = {
  id: 'b3', defaultTarget: 'https://shop.example',
  rules: [{
    id: 'r1', priority: 10,
    when: [{ dim: 'time', tz: NY, from: '18:00', to: '23:00' }],
    then: { kind: 'redirect', target: 'https://drop.example', status: 302 },
  }],
};
const d1 = evaluate(b3, {}, all, now1);
check('serves default before the window', (d1.action as any).target, 'https://shop.example');
check('ttl expires exactly at 18:00', d1.sMaxAge, 3600);
check('cache-control header', cacheControl(d1), 'max-age=0, s-maxage=3600');

// 30s before the window closes
const now2 = Date.UTC(2026, 5, 11, 2, 59, 30); // 22:59:30 EDT
const d2 = evaluate(b3, {}, all, now2);
check('serves drop inside the window', (d2.action as any).target, 'https://drop.example');
check('ttl clamps to the close boundary', d2.sMaxAge, 30);

// Boundary produced by a rule that does NOT currently match.
const b4: Block = {
  id: 'b4', defaultTarget: 'https://default.example',
  rules: [
    { id: 'hi', priority: 1,
      when: [{ dim: 'time', tz: NY, from: '18:00', to: '19:00' }, { dim: 'geo', in: ['na'] }],
      then: { kind: 'redirect', target: 'https://na-live.example', status: 302 } },
    { id: 'lo', priority: 50, when: [{ dim: 'geo', in: ['na'] }],
      then: { kind: 'redirect', target: 'https://na.example', status: 302 } },
  ],
};
const d3 = evaluate(b4, { geo: 'na' }, all, now1);
check('lower-priority rule wins now', (d3.action as any).target, 'https://na.example');
check('ttl respects the not-yet-matching rule', d3.sMaxAge, 3600);

// Same block, a viewer the time rule can never apply to: no boundary at all.
const d4 = evaluate(b4, { geo: 'eu' }, all, now1);
check('eu viewer gets the full ceiling', d4.sMaxAge, 3600);
check('eu viewer falls through to default', (d4.action as any).target, 'https://default.example');

// --- mask coverage ---
const d5 = evaluate(b4, { geo: 'na' }, new Set(['device']), now1);
check('mask gap forces no-store', cacheControl(d5), 'no-store');
check('answer is still correct', (d5.action as any).target, 'https://na.example');

// --- scheduled activation ---
const b5: Block = {
  id: 'b5', defaultTarget: 'https://x.example', rules: [],
  activeFrom: now1 + 600_000,
};
const d6 = evaluate(b5, {}, all, now1);
check('hidden before activeFrom', d6.action.kind, 'hide');
check('ttl runs to activeFrom', d6.sMaxAge, 600);

