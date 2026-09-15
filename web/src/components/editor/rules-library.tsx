"use client";

import { useState } from "react";
import type { Block } from "@/lib/api/types";
import type { BlockRule } from "@/lib/rules/schema";
import { describeRule } from "@/lib/rules/language";
import { Button, Chip, Empty, cx } from "@/components/ui/primitives";
import { RuleBuilder, draftFrom, emptyDraft, normalise, type RuleDraft } from "./rule-builder";
import { orderedRules, useProfile } from "./profile-store";

/**
 * Every rule on the page, grouped by the block it routes.
 *
 * It used to be a flat pool with blocks referencing rules by id, which is not
 * how the backend models it: a rule is a field on a block, the set is replaced
 * whole, and two blocks cannot share one. So the grouping is not a presentation
 * choice — it is the shape of the data, and a flat list would have to invent a
 * sharing relationship that does not exist.
 *
 * What the list is still for: "what is routing traffic on this page, and in
 * what order" is a question you cannot answer from four separate block sheets.
 */
export function RulesLibrary() {
  const { state } = useProfile();
  const blocks = state.profile.blocks;

  const total = blocks.reduce((n, b) => n + b.rules.length, 0);

  return (
    <section className="max-w-[44rem]">
      <header className="mb-3">
        <h2 className="text-[0.9375rem] font-medium">Rules</h2>
        <p className="mt-0.5 text-[0.8125rem] text-muted">
          Each block is evaluated on its own, lowest priority first. The first rule that
          matches decides that block; the rest are never consulted.
        </p>
      </header>

      {blocks.length === 0 ? (
        <Empty
          title="No blocks yet"
          body="Rules route traffic to something. Add a link first."
        />
      ) : total === 0 ? (
        <Empty
          title="No rules yet"
          body="Your page looks the same to everyone. Add a rule when you want it to answer differently — by where someone is, what they're holding, or when they arrive."
        />
      ) : null}

      <div className="mt-2 flex flex-col gap-4">
        {blocks.map((block) => (
          <BlockRules key={block.id} block={block} />
        ))}
      </div>
    </section>
  );
}

function BlockRules({ block }: { block: Block }) {
  const { state, ops } = useProfile();
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const rules = orderedRules(block.rules);
  const saving = state.pending.has(`${block.id}:rules`);

  /** The whole set, with this draft put in place of its old self or appended. */
  async function save() {
    if (!draft) return;
    const clean = normalise(draft);
    const exists = rules.some((r) => r.id === clean.id);
    const next = exists ? rules.map((r) => (r.id === clean.id ? clean : r)) : [...rules, clean];
    if (await ops.saveBlockRules(block.id, next)) setDraft(null);
  }

  async function remove(ruleId: string) {
    if (await ops.saveBlockRules(block.id, rules.filter((r) => r.id !== ruleId))) setDraft(null);
  }

  return (
    <div className="overflow-hidden rounded-desk border border-line bg-panel">
      <header className="flex items-baseline gap-2 border-b border-line px-3 py-2.5">
        <span className={cx("text-sm font-medium", block.hidden && "text-muted line-through decoration-line-strong")}>
          {block.label}
        </span>
        {block.hidden ? <Chip tone="neutral">hidden</Chip> : null}
        <span className="ml-auto text-[0.75rem] text-faint">
          {rules.length === 0 ? "no rules" : `${rules.length} rule${rules.length === 1 ? "" : "s"}`}
        </span>
      </header>

      {draft ? (
        <div className="px-3 py-3">
          <RuleBuilder
            draft={draft}
            onChange={setDraft}
            onSave={() => void save()}
            onCancel={() => setDraft(null)}
            onDelete={rules.some((r) => r.id === draft.id) ? () => void remove(draft.id) : undefined}
            saving={saving}
          />
        </div>
      ) : (
        <>
          <ul>
            {rules.map((rule) => (
              <li key={rule.id} className="flex gap-3 border-b border-line px-3 py-2.5 last:border-b-0">
                <span className="tnum mt-0.5 w-8 flex-none font-mono text-[0.6875rem] text-faint">
                  {rule.priority}
                </span>
                <button
                  type="button"
                  onClick={() => setDraft(draftFrom(rule))}
                  className="min-w-0 flex-1 text-left text-[0.8125rem] text-muted hover:text-ink"
                >
                  {describeRule(rule)}
                </button>
              </li>
            ))}
          </ul>
          <div className="px-3 py-2.5">
            <Button
              size="sm"
              disabled={state.conflict}
              onClick={() => setDraft(emptyDraft(nextPriority(rules)))}
            >
              <span aria-hidden="true" className="text-faint">
                +
              </span>
              Rule
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * A new rule goes last. Priorities are sparse on purpose so a creator can slot
 * something between two existing rules without renumbering the set.
 */
export function nextPriority(rules: BlockRule[]): number {
  const highest = rules.reduce((n, r) => Math.max(n, r.priority), -10);
  return Math.min(9999, highest + 10);
}
