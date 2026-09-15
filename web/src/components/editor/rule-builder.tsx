"use client";

import { useMemo, useState } from "react";
import type { Condition, Dimension, Rule, RuleEffect, TimeWindow } from "@/lib/api/types";
import { fieldErrors, ruleInputSchema } from "@/lib/rules/schema";
import { windowWarnings } from "@/lib/rules/dst";
import { describeEffect } from "@/lib/rules/language";
import { Button, Chip, DIMENSION_TONE, Field, Input, Select, cx } from "@/components/ui/primitives";

/**
 * Rules are authored as rows, never as JSON. Validation runs against the same
 * Zod schema the backend uses, so the form cannot accept something the server
 * will reject — the only failure left is one the server knows about and the
 * client cannot, which is why saved warnings are rendered too.
 */

const DIMENSION_OPTIONS: { value: Dimension; label: string }[] = [
  { value: "country", label: "Country" },
  { value: "region", label: "Region" },
  { value: "device", label: "Device" },
  { value: "os", label: "Operating system" },
  { value: "referrer", label: "Came from" },
  { value: "language", label: "Language" },
  { value: "time", label: "Time" },
];

const ENUM_VALUES: Partial<Record<Dimension, string[]>> = {
  device: ["mobile", "tablet", "desktop"],
  os: ["ios", "android", "macos", "windows", "other"],
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface RuleDraft {
  id?: string;
  name: string;
  conditions: Condition[];
  effect: RuleEffect;
  priority: number;
  enabled: boolean;
}

export function emptyDraft(): RuleDraft {
  return {
    name: "",
    conditions: [{ dimension: "country", op: "in", values: [] }],
    effect: { type: "show" },
    priority: 100,
    enabled: true,
  };
}

export function draftFrom(rule: Rule): RuleDraft {
  return {
    id: rule.id,
    name: rule.name,
    conditions: rule.conditions,
    effect: rule.effect,
    priority: rule.priority,
    enabled: rule.enabled,
  };
}

export function RuleBuilder({
  draft,
  onChange,
  onSave,
  onCancel,
  onDelete,
  saving,
  savedWarnings,
}: {
  draft: RuleDraft;
  onChange: (next: RuleDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete?: () => void;
  saving?: boolean;
  savedWarnings?: Rule["warnings"];
}) {
  const [errors, setErrors] = useState<Record<string, string>>({});

  const advisory = useMemo(
    () =>
      draft.conditions
        .filter((c) => c.dimension === "time" && c.window)
        .flatMap((c) => windowWarnings(c.window!)),
    [draft.conditions],
  );

  function patch(next: Partial<RuleDraft>) {
    onChange({ ...draft, ...next });
  }

  function setCondition(index: number, next: Condition) {
    patch({ conditions: draft.conditions.map((c, i) => (i === index ? next : c)) });
  }

  function submit() {
    const parsed = ruleInputSchema.safeParse({
      name: draft.name,
      conditions: draft.conditions,
      effect: draft.effect,
      priority: draft.priority,
      enabled: draft.enabled,
    });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    onSave();
  }

  return (
    <div className="flex flex-col gap-4">
      <Field label="Name" error={errors.name} hint="You'll see this in the decision trace.">
        <Input
          value={draft.name}
          onChange={(e) => patch({ name: e.target.value })}
          placeholder="iOS visitors get Apple Music"
        />
      </Field>

      <div>
        <p className="mb-1.5 text-[0.8125rem] text-muted">When all of these are true</p>
        <div className="flex flex-col gap-2">
          {draft.conditions.map((condition, i) => (
            <ConditionRow
              key={i}
              condition={condition}
              error={errors[`conditions.${i}.values`] ?? errors[`conditions.${i}`]}
              onChange={(next) => setCondition(i, next)}
              onRemove={
                draft.conditions.length > 1
                  ? () => patch({ conditions: draft.conditions.filter((_, j) => j !== i) })
                  : undefined
              }
            />
          ))}
        </div>
        {errors.conditions ? (
          <p role="alert" className="mt-1.5 text-[0.75rem] text-alert">
            {errors.conditions}
          </p>
        ) : null}
        <Button
          size="sm"
          className="mt-2"
          onClick={() =>
            patch({
              conditions: [...draft.conditions, { dimension: "device", op: "in", values: [] }],
            })
          }
        >
          <span aria-hidden="true" className="text-faint">
            +
          </span>
          Condition
        </Button>
      </div>

      <EffectEditor
        effect={draft.effect}
        error={errors["effect.url"]}
        onChange={(effect) => patch({ effect })}
      />

      {advisory.map((w, i) => (
        <p key={i} className="rounded-desk bg-clock-wash px-2.5 py-2 text-[0.8125rem] text-clock">
          {w.message}
        </p>
      ))}
      {savedWarnings?.map((w, i) => (
        <p
          key={`saved-${i}`}
          className={cx(
            "rounded-desk px-2.5 py-2 text-[0.8125rem]",
            w.code === "unreachable" || w.code === "no-effect"
              ? "bg-alert-wash text-alert"
              : "bg-clock-wash text-clock",
          )}
        >
          {w.message}
        </p>
      ))}

      <div className="flex items-center gap-2 border-t border-line pt-3">
        <Button variant="primary" onClick={submit} disabled={saving}>
          {saving ? "Saving" : draft.id ? "Save rule" : "Add rule"}
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

function ConditionRow({
  condition,
  onChange,
  onRemove,
  error,
}: {
  condition: Condition;
  onChange: (next: Condition) => void;
  onRemove?: () => void;
  error?: string;
}) {
  const tone = DIMENSION_TONE[condition.dimension];

  function changeDimension(dimension: Dimension) {
    if (dimension === "time") {
      onChange({ dimension, op: "within", window: defaultWindow() });
      return;
    }
    onChange({ dimension, op: "in", values: [] });
  }

  return (
    <div className={cx("rounded-desk border border-line p-2.5", tone.wash)}>
      <div className="flex gap-2">
        <Select
          aria-label="Context"
          value={condition.dimension}
          onChange={(e) => changeDimension(e.target.value as Dimension)}
          className="max-w-[10rem] bg-panel"
        >
          {DIMENSION_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>

        {condition.dimension !== "time" ? (
          <Select
            aria-label="Operator"
            value={condition.op}
            onChange={(e) => onChange({ ...condition, op: e.target.value as Condition["op"] })}
            className="max-w-[7.5rem] bg-panel"
          >
            <option value="in">is</option>
            <option value="not-in">is not</option>
            {condition.dimension === "referrer" ? <option value="matches">matches</option> : null}
          </Select>
        ) : null}

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
        {condition.dimension === "time" ? (
          <WindowEditor
            window={condition.window ?? defaultWindow()}
            onChange={(window) => onChange({ ...condition, window })}
          />
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
  condition: Condition;
  onChange: (next: Condition) => void;
  error?: string;
}) {
  const options = ENUM_VALUES[condition.dimension];
  const values = condition.values ?? [];

  if (options) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => {
          const on = values.includes(option);
          return (
            <button
              key={option}
              type="button"
              aria-pressed={on}
              onClick={() =>
                onChange({
                  ...condition,
                  values: on ? values.filter((v) => v !== option) : [...values, option],
                })
              }
              className={cx(
                "rounded border px-2 py-1 text-[0.8125rem] transition-colors",
                on ? "border-ink bg-ink text-white" : "border-line bg-panel hover:border-line-strong",
              )}
            >
              {option}
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

  return (
    <Field
      label=""
      error={error}
      hint={
        condition.dimension === "country"
          ? "Two-letter codes, comma separated. US, CA"
          : condition.dimension === "referrer"
            ? "Hostnames. instagram.com, t.co"
            : "Comma separated"
      }
    >
      <Input
        className="bg-panel"
        value={values.join(", ")}
        onChange={(e) =>
          onChange({
            ...condition,
            values: e.target.value
              .split(",")
              .map((v) => v.trim())
              .filter(Boolean)
              .map((v) => (condition.dimension === "country" ? v.toUpperCase() : v.toLowerCase())),
          })
        }
        placeholder={condition.dimension === "country" ? "US, CA" : "instagram.com"}
      />
    </Field>
  );
}

function WindowEditor({
  window,
  onChange,
}: {
  window: TimeWindow;
  onChange: (next: TimeWindow) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1">
        {DAYS.map((day, i) => {
          const on = window.daysOfWeek.length === 0 || window.daysOfWeek.includes(i);
          return (
            <button
              key={day}
              type="button"
              aria-pressed={on}
              onClick={() =>
                onChange({
                  ...window,
                  daysOfWeek: toggleDay(window.daysOfWeek, i),
                })
              }
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
          value={window.start}
          onChange={(e) => onChange({ ...window, start: e.target.value })}
        />
        <span className="text-[0.8125rem] text-muted">to</span>
        <Input
          type="time"
          aria-label="Closes"
          className="max-w-[7rem] bg-panel tnum"
          value={window.end}
          onChange={(e) => onChange({ ...window, end: e.target.value })}
        />
      </div>

      <Select
        aria-label="Timezone"
        className="bg-panel"
        value={window.timezone}
        onChange={(e) => onChange({ ...window, timezone: e.target.value })}
      >
        <option value="viewer">The visitor's own timezone</option>
        {COMMON_ZONES.map((z) => (
          <option key={z} value={z}>
            {z}
          </option>
        ))}
      </Select>

      {window.timezone === "viewer" ? (
        <p className="text-[0.75rem] text-clock">
          Visitor-local windows split the cache by timezone bucket. A fixed zone
          stays one cached copy for everyone.
        </p>
      ) : null}
    </div>
  );
}

function EffectEditor({
  effect,
  onChange,
  error,
}: {
  effect: RuleEffect;
  onChange: (next: RuleEffect) => void;
  error?: string;
}) {
  return (
    <div>
      <p className="mb-1.5 text-[0.8125rem] text-muted">Then</p>
      <div className="flex gap-2">
        <Select
          aria-label="Effect"
          value={effect.type}
          onChange={(e) => {
            const type = e.target.value as RuleEffect["type"];
            if (type === "rewrite") onChange({ type, url: "" });
            else if (type === "promote") onChange({ type, toIndex: 0 });
            else onChange({ type } as RuleEffect);
          }}
          className="max-w-[11rem]"
        >
          <option value="show">Show it</option>
          <option value="hide">Hide it</option>
          <option value="rewrite">Send somewhere else</option>
          <option value="promote">Move it up</option>
        </Select>

        {effect.type === "rewrite" ? (
          <Input
            aria-label="Destination"
            value={effect.url}
            onChange={(e) => onChange({ type: "rewrite", url: e.target.value })}
            placeholder="https://music.apple.com/..."
          />
        ) : null}
        {effect.type === "promote" ? (
          <Input
            aria-label="Position"
            type="number"
            min={1}
            className="max-w-[5rem] tnum"
            value={effect.toIndex + 1}
            onChange={(e) =>
              onChange({ type: "promote", toIndex: Math.max(0, Number(e.target.value) - 1) })
            }
          />
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="mt-1.5 text-[0.75rem] text-alert">
          {error}
        </p>
      ) : (
        <p className="mt-1.5 text-[0.75rem] text-faint">Reads as: {describeEffect(effect)}</p>
      )}
    </div>
  );
}

export function RuleSummaryChips({ rule }: { rule: Rule }) {
  return (
    <span className="flex flex-wrap gap-1.5">
      {rule.conditions.map((c, i) => (
        <Chip
          key={i}
          tone={
            c.dimension === "time"
              ? "clock"
              : c.dimension === "country" || c.dimension === "region"
                ? "geo"
                : "device"
          }
        >
          {c.dimension}
        </Chip>
      ))}
    </span>
  );
}

function toggleDay(days: number[], day: number): number[] {
  // Empty means every day. Turning one off from "every day" has to expand it
  // first, or the click would read as a no-op.
  const expanded = days.length === 0 ? [0, 1, 2, 3, 4, 5, 6] : days;
  const next = expanded.includes(day)
    ? expanded.filter((d) => d !== day)
    : [...expanded, day].sort((a, b) => a - b);
  return next.length === 7 ? [] : next;
}

function defaultWindow(): TimeWindow {
  return {
    timezone: guessZone(),
    daysOfWeek: [],
    start: "18:00",
    end: "23:00",
  };
}

function guessZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
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
