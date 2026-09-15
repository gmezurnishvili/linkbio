import type { RuleWarning, TimeWindow } from "@/lib/api/types";

/**
 * Advisory DST check, for warning while the creator is still typing.
 *
 * The backend evaluator is the authority: it probes wall time from both sides
 * of the day, because a single-sided probe silently misses fall-back
 * ambiguity, and its warnings are the ones stored on the rule. This is the
 * cheap version — find the transitions, ask whether the window overlaps one —
 * so that typing 02:30 produces a warning immediately instead of after a save.
 *
 * Intl only. No timezone database in the bundle.
 */

const MINUTE = 60_000;

/** Zone offset in minutes at an instant, from Intl's own data. */
export function offsetAt(timezone: string, instant: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "longOffset",
  }).formatToParts(new Date(instant));
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+00:00";
  const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3] ?? 0));
}

export interface Transition {
  /** Instant of the change, to the minute. */
  at: number;
  before: number;
  after: number;
  /** Positive when clocks go forward. */
  shift: number;
}

/** Offset changes in the next `months`, found by bisecting month boundaries. */
export function findTransitions(timezone: string, from = Date.now(), months = 13): Transition[] {
  const out: Transition[] = [];
  let cursor = from;
  let offset = offsetAt(timezone, cursor);

  for (let m = 0; m < months; m += 1) {
    const next = cursor + 30 * 24 * 60 * MINUTE;
    const nextOffset = offsetAt(timezone, next);

    if (nextOffset !== offset) {
      let lo = cursor;
      let hi = next;
      while (hi - lo > MINUTE) {
        const mid = lo + Math.floor((hi - lo) / 2 / MINUTE) * MINUTE;
        if (offsetAt(timezone, mid) === offset) lo = mid;
        else hi = mid;
      }
      out.push({ at: hi, before: offset, after: nextOffset, shift: nextOffset - offset });
      offset = nextOffset;
    }
    cursor = next;
  }
  return out;
}

/** Wall-clock minutes-since-midnight and local date at an instant. */
function localParts(timezone: string, instant: number) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(instant));
  const get = (t: string) => f.find((p) => p.type === t)?.value ?? "00";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(hour) * 60 + Number(get("minute")),
  };
}

function toMinutes(hhmm: string): number {
  const [h = "0", m = "0"] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

/** Does [start, end) cover any minute in [from, to)? Handles midnight crossing. */
function overlaps(window: TimeWindow, from: number, to: number): boolean {
  const start = toMinutes(window.start);
  const end = toMinutes(window.end);
  const spans = end > start ? [[start, end]] : [
    [start, 24 * 60],
    [0, end],
  ];
  return spans.some(([s, e]) => s! < to && from < e!);
}

export function windowWarnings(window: TimeWindow): RuleWarning[] {
  if (!window.timezone || window.timezone === "viewer") return [];

  let transitions: Transition[];
  try {
    transitions = findTransitions(window.timezone);
  } catch {
    return [];
  }

  const out: RuleWarning[] = [];
  for (const t of transitions) {
    // The local minute the clock reads immediately before and after the change.
    const before = localParts(window.timezone, t.at - MINUTE);
    const after = localParts(window.timezone, t.at);

    if (t.shift > 0) {
      // Spring forward: the local minutes between the two readings never occur.
      const from = before.minutes + 1;
      const to = after.minutes;
      if (to > from && overlaps(window, from, to)) {
        out.push({
          code: "dst-gap",
          onDate: after.date,
          message: `On ${after.date} the clocks skip ${fmt(from)}–${fmt(to)} in ${window.timezone}. Part of this window doesn't exist that day.`,
        });
      }
    } else if (t.shift < 0) {
      // Fall back: the local minutes after the change repeat an earlier hour.
      const from = after.minutes;
      const to = after.minutes - t.shift;
      if (overlaps(window, from, to)) {
        out.push({
          code: "dst-ambiguous",
          onDate: after.date,
          message: `On ${after.date}, ${fmt(from)}–${fmt(to)} happens twice in ${window.timezone}. This window opens on the first pass.`,
        });
      }
    }
  }
  return out;
}

function fmt(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
