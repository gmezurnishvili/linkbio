import { z } from "zod";

/**
 * The rule vocabulary, mirrored from `api/src/domain/schema.ts`.
 *
 * That file is the single source of truth. It is the thing that validates the
 * bytes on the way in and the thing that evaluates them at the edge; this copy
 * exists only so the builder can refuse input before a round trip. Where the
 * two disagree, the backend is right and this file is a bug.
 *
 * The real fix is to extract `@linkctx/schemas` and have both sides import the
 * same Zod objects. Until that lands, every change here has to be made there
 * first — a copy that drifts is worse than no client validation at all, because
 * the form starts accepting input the server rejects.
 *
 * Gone in this revision, because the backend has no counterpart for any of
 * them and a control that cannot be saved is worse than a missing one:
 *
 *   country, region  →  folded into `geo`, six coarse buckets. The edge
 *                       function maps the viewer country (edge/normalize.js,
 *                       GEO) and nothing downstream ever sees the country.
 *   os               →  dropped outright. `device` is the only client axis the
 *                       cache key carries; `webview` covers the case os was
 *                       mostly being used for (in-app browsers).
 *   show             →  not an action. A rule that does not match leaves the
 *                       block alone, so "show it" was always a no-op.
 *   promote          →  not an action. Ordering is `rank`, moved explicitly.
 *
 * New here, with no old equivalent: `webview`, and `redirect` carrying an
 * explicit 302/307.
 */

/** Matches the backend's `GEO_BUCKETS`. */
export const GEO_BUCKETS = ["na", "eu", "apac", "latam", "mea", "xx"] as const;
export const DEVICES = ["mobile", "tablet", "desktop"] as const;
export const REFERRERS = ["ig", "tt", "li", "yt", "x", "fb", "dir", "oth"] as const;

export type GeoBucket = (typeof GEO_BUCKETS)[number];
export type DeviceKind = (typeof DEVICES)[number];
export type ReferrerKind = (typeof REFERRERS)[number];

/**
 * `MAX_RULES` on the backend, which reads it from the environment and defaults
 * to 20. A deployment that raises it makes this copy pessimistic, which costs a
 * creator a rule they could have had; a copy that is too generous costs them a
 * failed save after they have written it. Pessimistic is the kinder miss.
 */
export const MAX_RULES = 20;
/** `when` is capped at 8 conditions server-side. */
export const MAX_CONDITIONS = 8;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const hm = z.string().regex(HHMM, "Use 24-hour HH:mm");
const tz = z.string().min(1, "Pick a timezone").refine(isValidTimezone, "That is not an IANA timezone");

export const conditionSchema = z.discriminatedUnion("dim", [
  z.object({ dim: z.literal("geo"), in: z.array(z.enum(GEO_BUCKETS)).min(1, "Pick at least one region") }),
  z.object({ dim: z.literal("device"), in: z.array(z.enum(DEVICES)).min(1, "Pick at least one device") }),
  z.object({ dim: z.literal("referrer"), in: z.array(z.enum(REFERRERS)).min(1, "Pick at least one source") }),
  z.object({
    dim: z.literal("lang"),
    in: z.array(z.string().length(2, "Two-letter language code")).min(1, "Add at least one language"),
  }),
  z.object({ dim: z.literal("webview"), is: z.boolean() }),
  z.object({
    dim: z.literal("time"),
    tz,
    /** 0 = Sunday. Absent means every day — the backend treats it as optional, not as an empty array. */
    days: z.array(z.number().int().min(0).max(6)).min(1).optional(),
    from: hm,
    to: hm,
  }),
]);

export const actionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("redirect"),
    // The backend's SafeUrl also refuses private and link-local hosts, which
    // this cannot check from a browser. A target that passes here and fails
    // there comes back as a 400 with the field path on it.
    target: z.string().url("Needs a full URL, including https://"),
    status: z.union([z.literal(302), z.literal(307)]),
  }),
  z.object({ kind: z.literal("hide") }),
]);

export const ruleSchema = z.object({
  id: z.string().min(1).max(64),
  priority: z.number().int().min(0).max(9999),
  when: z.array(conditionSchema).min(1, "A rule with no conditions always fires").max(MAX_CONDITIONS),
  then: actionSchema,
});

/**
 * A whole rule set, which is the only unit the API accepts: `PUT
 * /v1/profiles/:id/blocks/:bid/rules` replaces it wholesale. There is no
 * per-rule endpoint, so there is nothing smaller to validate.
 *
 * The two cross-rule checks are the backend's, restated: ids are unique within
 * the set, and one rule may not carry two conditions on the same dimension —
 * they would AND to nothing a creator could have meant. `time` is exempt
 * because two windows on one rule is a legitimate (if unusual) way to say "on
 * either of these".
 */
export const ruleSetSchema = z
  .array(ruleSchema)
  .max(MAX_RULES, `At most ${MAX_RULES} rules on one block`)
  .superRefine((rules, ctx) => {
    const ids = new Set<string>();
    rules.forEach((r, i) => {
      if (ids.has(r.id)) ctx.addIssue({ code: "custom", path: [i, "id"], message: "duplicate rule id" });
      ids.add(r.id);
      const dims = new Set<string>();
      r.when.forEach((c, j) => {
        if (c.dim !== "time" && dims.has(c.dim)) {
          ctx.addIssue({ code: "custom", path: [i, "when", j], message: `Two ${c.dim} conditions on one rule` });
        }
        dims.add(c.dim);
      });
    });
  });

export type RuleCondition = z.infer<typeof conditionSchema>;
export type RuleAction = z.infer<typeof actionSchema>;
export type BlockRule = z.infer<typeof ruleSchema>;
export type TimeCondition = Extract<RuleCondition, { dim: "time" }>;

/** The dimensions a condition can be built on, in the order the builder offers them. */
export const RULE_DIMENSIONS = ["geo", "device", "referrer", "lang", "webview", "time"] as const;
export type RuleDimension = (typeof RULE_DIMENSIONS)[number];

export function isValidTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Field-level errors keyed by the dotted path the form inputs use. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".");
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}
