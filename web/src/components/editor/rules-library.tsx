"use client";

import { useState } from "react";
import { describeRule } from "@/lib/rules/language";
import { Button, Chip, Empty, Toggle, cx } from "@/components/ui/primitives";
import { RuleBuilder, draftFrom, emptyDraft, type RuleDraft } from "./rule-builder";
import { useProfile } from "./profile-store";

/**
 * Every rule on the profile in one list, ordered the way the evaluator runs
 * them. Block-level editing is where most rules get written, but "what is
 * routing traffic on this page, and in what order" is a question that needs a
 * single place to stand.
 */
export function RulesLibrary() {
  const { state, ops } = useProfile();
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const rules = [...state.profile.rules].sort((a, b) => a.priority - b.priority);

  async function save() {
    if (!draft) return;
    const saved = await ops.saveRule({
      id: draft.id,
      name: draft.name,
      conditions: draft.conditions,
      effect: draft.effect,
      priority: draft.priority,
      enabled: draft.enabled,
    });
    if (saved) setDraft(null);
  }

  if (draft) {
    return (
      <div className="max-w-[34rem]">
        <h2 className="mb-4 text-[0.9375rem] font-medium">
          {draft.id ? "Edit rule" : "New rule"}
        </h2>
        <RuleBuilder
          draft={draft}
          onChange={setDraft}
          onSave={() => void save()}
          onCancel={() => setDraft(null)}
          onDelete={
            draft.id
              ? () => {
                  void ops.deleteRule(draft.id!);
                  setDraft(null);
                }
              : undefined
          }
          saving={state.pending.has(draft.id ?? "new-rule")}
          savedWarnings={rules.find((r) => r.id === draft.id)?.warnings}
        />
      </div>
    );
  }

  return (
    <section className="max-w-[44rem]">
      <header className="mb-3 flex items-baseline justify-between">
        <div>
          <h2 className="text-[0.9375rem] font-medium">Rules</h2>
          <p className="mt-0.5 text-[0.8125rem] text-muted">
            Evaluated top to bottom. The first one to change a block wins.
          </p>
        </div>
        <Button size="sm" onClick={() => setDraft(emptyDraft())}>
          <span aria-hidden="true" className="text-faint">
            +
          </span>
          Rule
        </Button>
      </header>

      {rules.length === 0 ? (
        <Empty
          title="No rules yet"
          body="Your page looks the same to everyone. Add a rule when you want it to answer differently — by where someone is, what they're holding, or when they arrive."
          action={<Button variant="primary" onClick={() => setDraft(emptyDraft())}>Add a rule</Button>}
        />
      ) : (
        <ul className="overflow-hidden rounded-desk border border-line bg-panel">
          {rules.map((rule) => {
            const blocks = state.profile.blocks.filter((b) => b.ruleIds.includes(rule.id));
            return (
              <li
                key={rule.id}
                className="flex gap-3 border-b border-line px-3 py-3 last:border-b-0"
              >
                <span className="tnum mt-0.5 w-8 flex-none font-mono text-[0.6875rem] text-faint">
                  {rule.priority}
                </span>

                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={() => setDraft(draftFrom(rule))}
                    className="block w-full text-left"
                  >
                    <span
                      className={cx(
                        "text-sm font-medium",
                        !rule.enabled && "text-muted line-through decoration-line-strong",
                      )}
                    >
                      {rule.name}
                    </span>
                    <span className="mt-0.5 block text-[0.8125rem] text-muted">
                      {describeRule(rule)}
                    </span>
                  </button>

                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {blocks.length === 0 ? (
                      <Chip tone="alert">not on any block</Chip>
                    ) : (
                      blocks.map((b) => <Chip key={b.id}>{b.label}</Chip>)
                    )}
                  </div>

                  {rule.warnings?.map((w, i) => (
                    <p
                      key={i}
                      className="mt-2 rounded-desk bg-clock-wash px-2 py-1.5 text-[0.75rem] text-clock"
                    >
                      {w.message}
                    </p>
                  ))}
                </div>

                <div className="w-[7.5rem] flex-none">
                  <Toggle
                    checked={rule.enabled}
                    onChange={(next) => void ops.saveRule({ ...rule, enabled: next })}
                    label={rule.enabled ? "On" : "Off"}
                    disabled={state.conflict || state.pending.has(rule.id)}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
