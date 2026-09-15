import type {
  CacheDimension,
  Condition,
  Dimension,
  Rule,
  RuleEffect,
  TimeWindow,
} from "@/lib/api/types";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const DIMENSION_NOUNS: Record<Dimension, string> = {
  country: "country",
  region: "region",
  device: "device",
  os: "operating system",
  referrer: "came from",
  language: "language",
  time: "time",
};

/**
 * Conditions are rendered in the same vocabulary the decision trace uses, so
 * "device in [ios]" in the builder and in the trace read identically. Anything
 * a creator sees twice should be worded the same both times.
 */
export function describeCondition(c: Condition): string {
  if (c.dimension === "time") {
    return c.window ? describeWindow(c.window) : "time (not set)";
  }
  const values = (c.values ?? []).join(", ");
  const noun = DIMENSION_NOUNS[c.dimension];
  if (c.dimension === "referrer") {
    return c.op === "not-in" ? `did not come from ${values}` : `came from ${values}`;
  }
  if (c.op === "not-in") return `${noun} is not ${values}`;
  if (c.op === "matches") return `${noun} matches ${values}`;
  return `${noun} is ${values}`;
}

export function describeWindow(w: TimeWindow): string {
  const days =
    w.daysOfWeek.length === 0 || w.daysOfWeek.length === 7
      ? "every day"
      : w.daysOfWeek
          .slice()
          .sort((a, b) => a - b)
          .map((d) => DAY_NAMES[d] ?? "?")
          .join(", ");
  const crosses = crossesMidnight(w) ? " next day" : "";
  return `${days} ${w.start}–${w.end}${crosses} in ${shortZone(w.timezone)}`;
}

export function crossesMidnight(w: TimeWindow): boolean {
  return toMinutes(w.end) <= toMinutes(w.start);
}

function toMinutes(hhmm: string): number {
  const [h = "0", m = "0"] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

export function shortZone(tz: string): string {
  const last = tz.split("/").pop() ?? tz;
  return last.replace(/_/g, " ");
}

export function describeEffect(e: RuleEffect): string {
  switch (e.type) {
    case "show":
      return "show it";
    case "hide":
      return "hide it";
    case "rewrite":
      return `send them to ${hostOf(e.url)}`;
    case "promote":
      return e.toIndex === 0 ? "move it to the top" : `move it to position ${e.toIndex + 1}`;
  }
}

export function describeRule(rule: Rule): string {
  const when = rule.conditions.map(describeCondition).join(" and ");
  return `When ${when}, ${describeEffect(rule.effect)}.`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Which cache-key dimensions a set of rules implies.
 *
 * The authoritative mask is derived server-side and published to the
 * KeyValueStore; treating it as a client-side optimisation would reintroduce
 * exactly the correctness gap the backend closes. This exists only so the
 * builder can warn "saving this adds `device` to your cache key" while the
 * creator is still editing, before a round trip. Always display
 * `profile.cacheDimensions` as the real value.
 */
export function deriveCacheDimensions(rules: Rule[]): CacheDimension[] {
  const out = new Set<CacheDimension>();
  for (const rule of rules) {
    if (!rule.enabled) continue;
    for (const c of rule.conditions) {
      if (c.dimension === "time") {
        // Time does not fragment by itself; the evaluator expresses it through
        // s-maxage. It only enters the key when a window's zone differs from
        // the page's own, which is bucketed rather than per-zone.
        if (c.window && needsZoneBucket(c.window)) out.add("tz-bucket");
        continue;
      }
      out.add(c.dimension as CacheDimension);
    }
  }
  return [...out];
}

function needsZoneBucket(w: TimeWindow): boolean {
  // A fixed-zone window is the same decision for every visitor, so it never
  // fragments. "viewer" is the sentinel the backend uses for visitor-local
  // windows, and those do.
  return w.timezone === "viewer";
}

/** Cache-key cardinality, so "adds a dimension" has a number attached. */
export function estimateVariants(rules: Rule[]): number {
  let total = 1;
  const seen = new Map<string, Set<string>>();
  for (const rule of rules) {
    if (!rule.enabled) continue;
    for (const c of rule.conditions) {
      if (c.dimension === "time" || !c.values) continue;
      const set = seen.get(c.dimension) ?? new Set<string>();
      for (const v of c.values) set.add(v);
      seen.set(c.dimension, set);
    }
  }
  for (const values of seen.values()) {
    // Each dimension splits traffic into its named values plus "everything else".
    total *= values.size + 1;
  }
  return total;
}
