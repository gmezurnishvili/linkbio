"use client";

import { useMemo, useState } from "react";
import {
  DEVICES,
  GEO_BUCKETS,
  MAX_CONDITIONS,
  REFERRERS,
  fieldErrors,
  ruleSchema,
  type BlockRule,
  type RuleAction,
  type RuleCondition,
  type RuleDimension,
  type TimeCondition,
} from "@/lib/rules/schema";
import { windowWarnings } from "@/lib/rules/dst";
import {
  GEO_LABELS,
  REFERRER_LABELS,
  RULE_DIMENSION_LABELS,
  TONE_DIMENSION,
  describeAction,
  toTimeWindow,
} from "@/lib/rules/language";
import { Button, Chip, DIMENSION_TONE, Field, Input, Select, cx } from "@/components/ui/primitives";

/**
 * Rules are authored as rows, never as JSON. Validation runs against the same
 * shape the backend validates (lib/rules/schema.ts, mirrored from
 * api/src/domain/schema.ts), so the form cannot accept something the server
 * will reject on grounds this side can see.
 *
 * What it cannot see: the backend's `SafeUrl` also refuses private and
 * link-local hosts, which a browser has no way to resolve. Those come back as a
 * 400 with a field path and surface as the store's error banner.
 *
 * A rule belongs to one block. Its id is minted here rather than by the server
 * — `PUT .../rules` replaces the whole set and takes the ids as given, so the
 * client is the only thing that can tell a new rule from an edited one.
 */

const DIMENSION_OPTIONS: RuleDimension[] = ["geo", "device", "referrer", "lang", "webview", "time"];

/** Every dimension whose values are a closed set, and the labels for them. */
const ENUM_OPTIONS: Partial<Record<RuleDimension, { value: string; label: string }[]>> = {
  geo: GEO_BUCKETS.map((v) => ({ value: v, label: GEO_LABELS[v] ?? v })),
  device: DEVICES.map((v) => ({ value: v, label: v })),
  referrer: REFERRERS.map((v) => ({ value: v, label: REFERRER_LABELS[v] ?? v })),
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export type RuleDraft = BlockRule;

/** Ids are opaque to the server, ≤64 chars, and only have to be unique in the set. */
function newRuleId(): string {
  return `r_${Math.random().toString(36).slice(2, 10)}`;
}

export function emptyDraft(priority = 100): RuleDraft {
  return {
    id: newRuleId(),
    priority,
    when: [{ dim: "geo", in: [] }],
    then: { kind: "hide" },
  };
}

export function draftFrom(rule: BlockRule): RuleDraft {
  return structuredClone(rule);
}

export function RuleBuilder({
  draft,
  onChange,
  onSave,
  onCancel,
  onDelete,
  saving,
}: {
  draft: RuleDraft;
  onChange: (next: RuleDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete?: () => void;
  saving?: boolean;
}) {
  const [errors, setErrors] = useState<Record<string, string>>({});

  /**
   * DST advice, computed locally. The backend resolves an ambiguous wall time
   * deterministically (`resolveEdge` in api/src/rules/rules.ts takes the
   * earlier instant for a start and the later for an end), so this is not a
   * warning that anything is broken — it is telling the creator that the day
   * they picked has a window that is shorter or longer than it reads.
   */
  const advisory = useMemo(
    () =>
      draft.when
        .filter((c): c is TimeCondition => c.dim === "time")
        .flatMap((c) => windowWarnings(toTimeWindow(c))),
    [draft.when],
  );

  function patch(next: Partial<RuleDraft>) {
    onChange({ ...draft, ...next });
  }

  function setCondition(index: number, next: RuleCondition) {
    patch({ when: draft.when.map((c, i) => (i === index ? next : c)) });
  }

  function submit() {
    const parsed = ruleSchema.safeParse(normalise(draft));
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    onSave();
  }

  /** Dimensions already spoken for: the backend refuses two of the same on one rule. */
  const used = new Set(draft.when.filter((c) => c.dim !== "time").map((c) => c.dim));
  const spare = DIMENSION_OPTIONS.find((d) => d === "time" || !used.has(d));

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="mb-1.5 text-[0.8125rem] text-muted">When all of these are true</p>
        <div className="flex flex-col gap-2">
          {draft.when.map((condition, i) => (
            <ConditionRow
              key={i}
              condition={condition}
              taken={used}
              error={errors[`when.${i}.in`] ?? errors[`when.${i}`] ?? errors[`when.${i}.tz`]}
              onChange={(next) => setCondition(i, next)}
              onRemove={
                draft.when.length > 1
                  ? () => patch({ when: draft.when.filter((_, j) => j !== i) })
                  : undefined
              }
            />
          ))}
        </div>
        {errors.when ? (
          <p role="alert" className="mt-1.5 text-[0.75rem] text-alert">
            {errors.when}
          </p>
        ) : null}
        <Button
          size="sm"
          className="mt-2"
          disabled={!spare || draft.when.length >= MAX_CONDITIONS}
          onClick={() => spare && patch({ when: [...draft.when, blankCondition(spare)] })}
        >
          <span aria-hidden="true" className="text-faint">
            +
          </span>
          Condition
        </Button>
      </div>

      <ActionEditor
        action={draft.then}
        error={errors["then.target"]}
        onChange={(then) => patch({ then })}
      />

      <Field
        label="Priority"
        error={errors.priority}
        hint="Lowest number wins. The first rule that matches decides the block; the rest are never consulted."
      >
        <Input
          type="number"
          min={0}
          max={9999}
          className="max-w-[6rem] tnum"
          value={draft.priority}
          onChange={(e) => patch({ priority: Math.max(0, Number(e.target.value) || 0) })}
        />
      </Field>

      {advisory.map((w, i) => (
        <p key={i} className="rounded-desk bg-clock-wash px-2.5 py-2 text-[0.8125rem] text-clock">
          {w.message}
        </p>
      ))}

      <div className="flex items-center gap-2 border-t border-line pt-3">
        <Button variant="primary" onClick={submit} disabled={saving}>
          {saving ? "Saving" : "Save rule"}
        </Button>
        <Button variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
        {onDelete ? (
          <Button variant="danger" size="sm" className="ml-auto" onClick={onDelete}>
            Delete
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * "Every day" is the absence of `days`, not seven of them.
 *
 * The schema is `z.array(...).min(1).optional()`, so an empty array is the one
 * spelling it refuses — and it is exactly what the day picker produces when a
 * creator turns the last day back on. Normalising on the way out keeps the
 * picker's state simple and the payload valid.
 */
export function normalise(rule: RuleDraft): RuleDraft {
  return {
    ...rule,
    when: rule.when.map((c) => {
      if (c.dim !== "time") return c;
      const { days, ...rest } = c;
      return days && days.length > 0 && days.length < 7 ? { ...rest, days } : rest;
    }),
  };
}

function blankCondition(dim: RuleDimension): RuleCondition {
  switch (dim) {
    case "webview":
      return { dim, is: true };
    case "time":
      return { dim, tz: guessZone(), from: "18:00", to: "23:00" };
    default:
      return { dim, in: [] } as RuleCondition;
  }
}

function ConditionRow({
  condition,
  taken,
  onChange,
  onRemove,
  error,
}: {
  condition: RuleCondition;
  taken: Set<string>;
  onChange: (next: RuleCondition) => void;
  onRemove?: () => void;
  error?: string;
}) {
  const tone = DIMENSION_TONE[TONE_DIMENSION[condition.dim]];

  return (
    <div className={cx("rounded-desk border border-line p-2.5", tone.wash)}>
      <div className="flex gap-2">
        <Select
          aria-label="Context"
          value={condition.dim}
          onChange={(e) => onChange(blankCondition(e.target.value as RuleDimension))}
          className="max-w-[11rem] bg-panel"
        >
          {DIMENSION_OPTIONS.map((d) => (
            <option key={d} value={d} disabled={d !== condition.dim && d !== "time" && taken.has(d)}>
              {RULE_DIMENSION_LABELS[d]}
            </option>
          ))}
        </Select>

        {onRemove ? (
          <Button
            variant="quiet"
            size="sm"
            className="ml-auto"
            onClick={onRemove}
            aria-label="Remove condition"
          >
            Remove
          </Button>
        ) : null}
      </div>

      <div className="mt-2">
        {condition.dim === "time" ? (
          <WindowEditor condition={condition} onChange={onChange} error={error} />
        ) : condition.dim === "webview" ? (
          <Select
            aria-label="In-app browser"
            className="bg-panel"
            value={condition.is ? "yes" : "no"}
            onChange={(e) => onChange({ dim: "webview", is: e.target.value === "yes" })}
          >
            <option value="yes">They are in one</option>
            <option value="no">They are not</option>
          </Select>
        ) : (
          <ValueEditor condition={condition} onChange={onChange} error={error} />
        )}
      </div>
    </div>
  );
}

function ValueEditor({
  condition,
  onChange,
  error,
}: {
  condition: Exclude<RuleCondition, { dim: "time" } | { dim: "webview" }>;
  onChange: (next: RuleCondition) => void;
  error?: string;
}) {
  const options = ENUM_OPTIONS[condition.dim];
  const values: string[] = condition.in;

  if (options) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => {
          const on = values.includes(option.value);
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={on}
              onClick={() =>
                onChange({
                  ...condition,
                  in: on ? values.filter((v) => v !== option.value) : [...values, option.value],
                } as RuleCondition)
              }
              className={cx(
                "rounded border px-2 py-1 text-[0.8125rem] transition-colors",
                on ? "border-ink bg-ink text-white" : "border-line bg-panel hover:border-line-strong",
              )}
            >
              {option.label}
            </button>
          );
        })}
        {error ? (
          <p role="alert" className="w-full text-[0.75rem] text-alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  // Language: an open set, so it stays a text field. Two letters only — the
  // edge folds `en-GB` down to `en` before the cache key is built, so a
  // regional variant here would match nothing.
  return (
    <Field label="" error={error} hint="Two-letter codes, comma separated. en, ka, de">
      <Input
        className="bg-panel"
        value={values.join(", ")}
        onChange={(e) =>
          onChange({
            ...condition,
            in: e.target.value
              .split(",")
              .map((v) => v.trim().slice(0, 2).toLowerCase())
              .filter(Boolean),
          } as RuleCondition)
        }
        placeholder="en, ka"
      />
    </Field>
  );
}

function WindowEditor({
  condition,
  onChange,
  error,
}: {
  condition: TimeCondition;
  onChange: (next: RuleCondition) => void;
  error?: string;
}) {
  const days = condition.days ?? [];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1">
        {DAYS.map((day, i) => {
          const on = days.length === 0 || days.includes(i);
          return (
            <button
              key={day}
              type="button"
              aria-pressed={on}
              onClick={() => onChange({ ...condition, days: toggleDay(days, i) })}
              className={cx(
                "w-9 rounded border py-1 text-[0.75rem] transition-colors",
                on ? "border-clock bg-clock text-white" : "border-line bg-panel",
              )}
            >
              {day}
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-2">
        <Input
          type="time"
          aria-label="Opens"
          className="max-w-[7rem] bg-panel tnum"
          value={condition.from}
          onChange={(e) => onChange({ ...condition, from: e.target.value })}
        />
        <span className="text-[0.8125rem] text-muted">to</span>
        <Input
          type="time"
          aria-label="Closes"
          className="max-w-[7rem] bg-panel tnum"
          value={condition.to}
          onChange={(e) => onChange({ ...condition, to: e.target.value })}
        />
      </div>

      <Select
        aria-label="Timezone"
        className="bg-panel"
        value={condition.tz}
        onChange={(e) => onChange({ ...condition, tz: e.target.value })}
      >
        {COMMON_ZONES.map((z) => (
          <option key={z} value={z}>
            {z}
          </option>
        ))}
      </Select>

      {error ? (
        <p role="alert" className="text-[0.75rem] text-alert">
          {error}
        </p>
      ) : (
        <p className="text-[0.75rem] text-faint">
          A fixed zone, always — the window means the same instant to every visitor, so the
          page stays one cached copy. Time never enters the cache key; it bounds how long
          the answer is cached for.
        </p>
      )}
    </div>
  );
}

function ActionEditor({
  action,
  onChange,
  error,
}: {
  action: RuleAction;
  onChange: (next: RuleAction) => void;
  error?: string;
}) {
  return (
    <div>
      <p className="mb-1.5 text-[0.8125rem] text-muted">Then</p>
      <div className="flex gap-2">
        <Select
          aria-label="Action"
          value={action.kind}
          onChange={(e) =>
            onChange(
              e.target.value === "redirect"
                ? { kind: "redirect", target: "", status: 302 }
                : { kind: "hide" },
            )
          }
          className="max-w-[11rem]"
        >
          <option value="hide">Hide it</option>
          <option value="redirect">Send somewhere else</option>
        </Select>

        {action.kind === "redirect" ? (
          <>
            <Input
              aria-label="Destination"
              value={action.target}
              onChange={(e) => onChange({ ...action, target: e.target.value })}
              placeholder="https://music.apple.com/..."
            />
            <Select
              aria-label="Redirect kind"
              value={action.status}
              onChange={(e) => onChange({ ...action, status: Number(e.target.value) as 302 | 307 })}
              className="max-w-[8rem]"
            >
              <option value={302}>302 found</option>
              <option value={307}>307 keep method</option>
            </Select>
          </>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="mt-1.5 text-[0.75rem] text-alert">
          {error}
        </p>
      ) : (
        <p className="mt-1.5 text-[0.75rem] text-faint">Reads as: {describeAction(action)}</p>
      )}
    </div>
  );
}

export function RuleSummaryChips({ rule }: { rule: BlockRule }) {
  return (
    <span className="flex flex-wrap gap-1.5">
      {rule.when.map((c, i) => (
        <Chip
          key={i}
          tone={
            c.dim === "time" ? "clock" : c.dim === "geo" ? "geo" : c.dim === "referrer" ? "neutral" : "device"
          }
        >
          {c.dim}
        </Chip>
      ))}
    </span>
  );
}

function toggleDay(days: number[], day: number): number[] {
  // Absent means every day. Turning one off from "every day" has to expand it
  // first, or the click would read as a no-op. The backend wants the field
  // gone rather than set to all seven, so a full week collapses back to empty
  // and `saveBlockRules` drops it.
  const expanded = days.length === 0 ? [0, 1, 2, 3, 4, 5, 6] : days;
  const next = expanded.includes(day)
    ? expanded.filter((d) => d !== day)
    : [...expanded, day].sort((a, b) => a - b);
  return next.length === 7 ? [] : next;
}

function guessZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && COMMON_ZONES.includes(zone) ? zone : "UTC";
  } catch {
    return "UTC";
  }
}

const COMMON_ZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Tbilisi",
  "Africa/Lagos",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Tokyo",
  "Australia/Sydney",
];
