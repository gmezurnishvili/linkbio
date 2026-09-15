import { describe, expect, it } from "vitest";
import { windowWarnings } from "./dst";
import type { TimeWindow } from "@/lib/api/types";

/**
 * Real zones, fixed dates, Intl's own data.
 *
 * The zones matter individually: New York moves its clocks mid-morning-ish and
 * has always worked, while Santiago and Havana move theirs at local midnight,
 * which is the case the advisory used to miss entirely.
 */

// 2026-01-01, far enough ahead of every transition below to be in the scan.
const FROM = Date.parse("2026-01-01T00:00:00Z");

const window = (over: Partial<TimeWindow>): TimeWindow => ({
  timezone: "America/New_York",
  daysOfWeek: [],
  start: "02:15",
  end: "02:45",
  ...over,
});

describe("transitions inside the day", () => {
  it("flags the New York spring-forward gap", () => {
    const warnings = warningsFrom(window({}));
    expect(warnings).toContainEqual(
      expect.objectContaining({ code: "dst-gap", onDate: "2026-03-08" }),
    );
    expect(warnings[0]?.message).toContain("02:00–03:00");
  });

  it("flags the New York fall-back repeat", () => {
    const warnings = warningsFrom(window({ start: "01:15", end: "01:45" }));
    expect(warnings).toContainEqual(
      expect.objectContaining({ code: "dst-ambiguous", onDate: "2026-11-01" }),
    );
  });
});

describe("transitions across local midnight", () => {
  it("flags Santiago's 2026-09-06 gap, which starts at 00:00", () => {
    // 2026-09-05 23:59 -> 2026-09-06 01:00: the reading before the change is on
    // the previous day, so a from/to pair read straight off both sides inverts.
    const warnings = warningsFrom(
      window({ timezone: "America/Santiago", start: "00:15", end: "00:45" }),
    );
    expect(warnings).toContainEqual(
      expect.objectContaining({ code: "dst-gap", onDate: "2026-09-06" }),
    );
    expect(warnings.find((w) => w.code === "dst-gap")?.message).toContain("00:00–01:00");
  });

  it("flags Havana's 2026-03-08 gap, likewise at 00:00", () => {
    const warnings = warningsFrom(
      window({ timezone: "America/Havana", start: "00:15", end: "00:45" }),
    );
    expect(warnings).toContainEqual(
      expect.objectContaining({ code: "dst-gap", onDate: "2026-03-08" }),
    );
  });

  it("flags Santiago's fall-back, which lands back on the previous evening", () => {
    // 2026-04-05 00:00 -> 2026-04-04 23:00, so the repeated hour runs up to
    // midnight rather than starting after it.
    const warnings = warningsFrom(
      window({ timezone: "America/Santiago", start: "23:10", end: "23:50" }),
    );
    expect(warnings).toContainEqual(
      expect.objectContaining({ code: "dst-ambiguous", onDate: "2026-04-04" }),
    );
  });

  it("stops the repeated hour at midnight rather than wrapping into the next day", () => {
    // Santiago's repeat runs 23:00–00:00, so a window opening at 00:00 is clear
    // of it — the wrap has to be exact at the day boundary in both directions.
    const warnings = warningsFrom(
      window({ timezone: "America/Santiago", start: "00:00", end: "00:30" }),
    );
    expect(warnings.some((w) => w.code === "dst-ambiguous")).toBe(false);
  });

  it("catches a window that crosses midnight into the gap", () => {
    const warnings = warningsFrom(
      window({ timezone: "America/Havana", start: "23:30", end: "00:30" }),
    );
    expect(warnings.some((w) => w.code === "dst-gap")).toBe(true);
  });

  it("stays quiet for a daytime window in the same zones", () => {
    for (const timezone of ["America/Santiago", "America/Havana", "America/New_York"]) {
      expect(warningsFrom(window({ timezone, start: "09:00", end: "17:00" }))).toEqual([]);
    }
  });

  it("stays quiet when a midnight window sits in a zone that never moves", () => {
    expect(warningsFrom(window({ timezone: "Asia/Tokyo", start: "00:15", end: "00:45" }))).toEqual(
      [],
    );
  });
});

/** windowWarnings scans forward from now; these tests need a fixed start. */
function warningsFrom(w: TimeWindow) {
  const original = Date.now;
  Date.now = () => FROM;
  try {
    return windowWarnings(w);
  } finally {
    Date.now = original;
  }
}
