import { z } from "zod";

/**
 * These mirror the backend's Zod schemas. Move them into a shared package
 * (`@linkctx/schemas`) and import the same objects on both sides — a copy that
 * drifts is worse than no client validation at all, because the form will
 * accept input the server rejects.
 */

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const timeWindowSchema = z
  .object({
    timezone: z
      .string()
      .min(1, "Pick a timezone")
      .refine(isValidTimezone, "That is not an IANA timezone"),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7),
    start: z.string().regex(HHMM, "Use 24-hour HH:mm"),
    end: z.string().regex(HHMM, "Use 24-hour HH:mm"),
  })
  .refine((w) => w.start !== w.end, {
    message: "A window that starts and ends at the same minute never opens",
    path: ["end"],
  });

export const conditionSchema = z.discriminatedUnion("dimension", [
  z.object({
    dimension: z.literal("country"),
    op: z.enum(["in", "not-in"]),
    values: z.array(z.string().regex(/^[A-Z]{2}$/, "Two-letter country code")).min(1),
  }),
  z.object({
    dimension: z.literal("region"),
    op: z.enum(["in", "not-in"]),
    values: z.array(z.string().min(2)).min(1),
  }),
  z.object({
    dimension: z.literal("device"),
    op: z.enum(["in", "not-in"]),
    values: z.array(z.enum(["mobile", "tablet", "desktop"])).min(1),
  }),
  z.object({
    dimension: z.literal("os"),
    op: z.enum(["in", "not-in"]),
    values: z.array(z.enum(["ios", "android", "macos", "windows", "other"])).min(1),
  }),
  z.object({
    dimension: z.literal("referrer"),
    op: z.enum(["in", "not-in", "matches"]),
    values: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    dimension: z.literal("language"),
    op: z.enum(["in", "not-in"]),
    values: z.array(z.string().min(2)).min(1),
  }),
  z.object({
    dimension: z.literal("time"),
    op: z.literal("within"),
    window: timeWindowSchema,
  }),
]);

export const ruleEffectSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("show") }),
  z.object({ type: z.literal("hide") }),
  z.object({ type: z.literal("rewrite"), url: z.string().url("Needs a full URL") }),
  z.object({ type: z.literal("promote"), toIndex: z.number().int().min(0) }),
]);

export const ruleInputSchema = z.object({
  name: z.string().min(1, "Give the rule a name you'll recognise in six months").max(80),
  conditions: z.array(conditionSchema).min(1, "A rule with no conditions always fires"),
  effect: ruleEffectSchema,
  priority: z.number().int().min(0).max(999),
  enabled: z.boolean(),
});

export type RuleInput = z.infer<typeof ruleInputSchema>;

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
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
