import type { CacheDimension, Dimension, TimeWindow } from "@/lib/api/types";
import type { BlockRule, RuleAction, RuleCondition, RuleDimension, TimeCondition } from "./schema";

/**
 * How a rule reads in English.
 *
 * Conditions are worded the same way in the builder, on the block row and in
 * the decision trace. Anything a creator sees twice should be worded the same
 * both times, or they spend the difference working out whether it is the same
 * thing.
 */

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** The six geo buckets, as something other than a two-letter code. */
export const GEO_LABELS: Record<string, string> = {
  na: "North America",
  eu: "Europe",
  apac: "Asia-Pacific",
  latam: "Latin America",
  mea: "Middle East & Africa",
  xx: "everywhere else",
};

/** The eight referrer codes. `dir` is "no referrer at all", not "some other site". */
export const REFERRER_LABELS: Record<string, string> = {
  ig: "Instagram",
  tt: "TikTok",
  li: "LinkedIn",
  yt: "YouTube",
  x: "X",
  fb: "Facebook",
  dir: "typed or tapped directly",
  oth: "somewhere else",
};

export const RULE_DIMENSION_LABELS: Record<RuleDimension, string> = {
  geo: "Region",
  device: "Device",
  referrer: "Came from",
  lang: "Language",
  webview: "In-app browser",
  time: "Time",
};

/**
 * The backend's dimension names onto the product's colour vocabulary.
 *
 * `DIMENSION_TONE` in components/ui/primitives.tsx is keyed on the older names,
 * and it is the palette for the whole product — the chip in the builder, the
 * rail segment on a block row and the line in the trace are one colour per kind
 * of context. Mapping is cheaper than repainting.
 */
export const TONE_DIMENSION: Record<RuleDimension, Dimension> = {
  geo: "country",
  device: "device",
  referrer: "referrer",
  lang: "language",
  webview: "device",
  time: "time",
};

export function describeCondition(c: RuleCondition): string {
  switch (c.dim) {
    case "geo":
      return `in ${list(c.in.map((v) => GEO_LABELS[v] ?? v))}`;
    case "device":
      return `on ${list(c.in)}`;
    case "referrer":
      return `came from ${list(c.in.map((v) => REFERRER_LABELS[v] ?? v))}`;
    case "lang":
      return `speaks ${list(c.in.map((v) => v.toUpperCase()))}`;
    case "webview":
      return c.is ? "inside an in-app browser" : "not in an in-app browser";
    case "time":
      return describeTime(c);
  }
}

export function describeTime(c: TimeCondition): string {
  const days =
    !c.days || c.days.length === 0 || c.days.length === 7
      ? "every day"
      : [...c.days].sort((a, b) => a - b).map((d) => DAY_NAMES[d] ?? "?").join(", ");
  const crosses = crossesMidnight(c.from, c.to) ? " next day" : "";
  return `${days} ${c.from}–${c.to}${crosses} in ${shortZone(c.tz)}`;
}

export function crossesMidnight(from: string, to: string): boolean {
  return toMinutes(to) <= toMinutes(from);
}

function toMinutes(hhmm: string): number {
  const [h = "0", m = "0"] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

export function shortZone(tz: string): string {
  const last = tz.split("/").pop() ?? tz;
  return last.replace(/_/g, " ");
}

export function describeAction(a: RuleAction): string {
  return a.kind === "hide" ? "hide it" : `send them to ${hostOf(a.target)}`;
}

/**
 * A rule with no conditions cannot be saved, so the "always" branch only ever
 * shows on a draft that has not been submitted yet.
 */
export function describeRule(rule: BlockRule): string {
  if (rule.when.length === 0) return `Always ${describeAction(rule.then)}.`;
  return `When ${rule.when.map(describeCondition).join(" and ")}, ${describeAction(rule.then)}.`;
}

function list(values: string[]): string {
  if (values.length <= 1) return values[0] ?? "nothing";
  return `${values.slice(0, -1).join(", ")} or ${values[values.length - 1]}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url || "nowhere yet";
  }
}

/**
 * A time condition as `lib/rules/dst.ts` wants it.
 *
 * That module finds the DST gaps and repeats a window falls into, and it is
 * owned elsewhere and takes the older `TimeWindow`. The two carry the same four
 * facts under different names, so this is a rename rather than a conversion.
 */
export function toTimeWindow(c: TimeCondition): TimeWindow {
  return { timezone: c.tz, daysOfWeek: c.days ?? [], start: c.from, end: c.to };
}

/* ═════════════════════════════════════════════════════════ cache estimate ══ */

/**
 * Which cache-key dimensions a set of rules implies.
 *
 * The authoritative mask is derived server-side and comes back on every
 * mutation as `cacheDimensions`; treating this as the real value would
 * reintroduce exactly the correctness gap the backend closes. It exists only so
 * the builder can say "saving this adds `device` to your cache key" while the
 * creator is still editing, before a round trip.
 *
 * It speaks the backend's vocabulary, because there is only one vocabulary
 * left: the saved shape is `BlockRule` and the pre-backend `Rule` is gone.
 */
export function deriveCacheDimensions(rules: BlockRule[]): CacheDimension[] {
  const out = new Set<CacheDimension>();
  for (const rule of rules) {
    for (const c of rule.when) {
      // A time window does not fragment the key — the evaluator expresses it
      // through s-maxage — but it does bound the TTL, and the cost panel is
      // about both. The backend reports it the same way.
      out.add(c.dim);
    }
  }
  return [...out];
}

/** Cache-key cardinality, so "adds a dimension" has a number attached. */
export function estimateVariants(rules: BlockRule[]): number {
  let total = 1;
  const seen = new Map<string, Set<string>>();

  const note = (dimension: string, values: string[]) => {
    const set = seen.get(dimension) ?? new Set<string>();
    for (const v of values) set.add(v);
    seen.set(dimension, set);
  };

  for (const rule of rules) {
    for (const c of rule.when) {
      if (c.dim === "time") continue;
      // A boolean splits traffic in two by itself; there is no third bucket
      // to fall through to, which the +1 below would otherwise invent.
      note(c.dim, c.dim === "webview" ? ["yes"] : c.in);
    }
  }

  for (const values of seen.values()) {
    // Each dimension splits traffic into its named values plus "everything else".
    total *= values.size + 1;
  }
  return total;
}
