"use client";

import { useEffect, useState } from "react";
import type { Block } from "@/lib/api/types";
import { describeRule } from "@/lib/rules/language";
import { Button, Field, Input, Sheet, Toggle } from "@/components/ui/primitives";
import { RuleBuilder, draftFrom, emptyDraft, normalise, type RuleDraft } from "./rule-builder";
import { nextPriority } from "./rules-library";
import { orderedRules, useProfile } from "./profile-store";

export function BlockSheet({ block, onClose }: { block: Block | null; onClose: () => void }) {
  const { state, ops } = useProfile();
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [draft, setDraft] = useState<RuleDraft | null>(null);

  const rules = orderedRules(block?.rules ?? []);

  useEffect(() => {
    if (!block) return;
    setLabel(block.label);
    setUrl(block.url ?? "");
    setDraft(null);
  }, [block?.id]);

  if (!block) return null;
  const busy = state.pending.has(block.id);
  const savingRules = state.pending.has(`${block.id}:rules`);

  function save() {
    void ops.updateBlock(block!.id, {
      label,
      // Only a link carries a destination, and the backend refuses a link
      // without one — `checkBlockShape` validates the merged block, so clearing
      // it on a PATCH is a 400 rather than a silent 404 at the redirector.
      ...(block!.kind === "link" ? { url } : {}),
    });
  }

  /**
   * Rules go through their own endpoint, not through the block PATCH.
   *
   * These two writes used to be issued from the same continuation with the
   * version read at render time, so the second one always carried the version
   * the first had just superseded and came back 409. The store keeps the
   * version in a ref it updates on every response, so the sequence works — but
   * they are still separate writes, and the rule set is the one that matters,
   * so it goes on its own.
   */
  async function saveRule() {
    if (!draft) return;
    const clean = normalise(draft);
    const exists = rules.some((r) => r.id === clean.id);
    const next = exists ? rules.map((r) => (r.id === clean.id ? clean : r)) : [...rules, clean];
    if (await ops.saveBlockRules(block!.id, next)) setDraft(null);
  }

  async function deleteRule(ruleId: string) {
    if (await ops.saveBlockRules(block!.id, rules.filter((r) => r.id !== ruleId))) setDraft(null);
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={block.kind === "header" ? "Note" : block.label || "Block"}
      footer={
        draft ? null : (
          <>
            <Button variant="primary" onClick={save} disabled={busy}>
              {busy ? "Saving" : "Save changes"}
            </Button>
            <Button
              variant="danger"
              size="sm"
              className="ml-auto"
              onClick={() => {
                void ops.deleteBlock(block.id);
                onClose();
              }}
            >
              Delete block
            </Button>
          </>
        )
      }
    >
      {draft ? (
        <RuleBuilder
          draft={draft}
          onChange={setDraft}
          onSave={() => void saveRule()}
          onCancel={() => setDraft(null)}
          onDelete={rules.some((r) => r.id === draft.id) ? () => void deleteRule(draft.id) : undefined}
          saving={savingRules}
        />
      ) : (
        <div className="flex flex-col gap-4">
          <Field label={block.kind === "header" ? "Text" : "Label"}>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} />
          </Field>

          {block.kind === "link" && (
            <Field
              label="Destination"
              hint="Rules can send some visitors somewhere else without changing this."
            >
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://"
                inputMode="url"
              />
            </Field>
          )}

          {block.kind === "feed" && block.feed && (
            <div className="rounded-desk bg-sunk px-3 py-2.5 text-[0.8125rem]">
              <p>
                Filled from <span className="font-mono">{block.feed.source}</span> ·{" "}
                <span className="font-mono">{block.feed.ref}</span>
              </p>
              <p className="mt-1 text-muted">
                {block.items?.length ?? 0} items, refreshing every{" "}
                {Math.round(block.feed.ttlSeconds / 60)} min
                {block.feedRefreshedAt
                  ? `, last ${new Date(block.feedRefreshedAt).toLocaleString()}`
                  : ", never fetched"}
              </p>
            </div>
          )}

          <div className="flex flex-col gap-3 border-t border-line pt-4">
            <Toggle
              checked={!block.hidden}
              onChange={(next) => void ops.updateBlock(block.id, { hidden: !next })}
              label="Visible"
              description="Hidden blocks stay in your list but never render, for anyone."
            />
          </div>

          <div className="border-t border-line pt-4">
            <p className="text-[0.8125rem] text-muted">Rules on this block</p>
            <ul className="mt-2 flex flex-col gap-1.5">
              {rules.map((rule) => (
                <li key={rule.id}>
                  <button
                    type="button"
                    onClick={() => setDraft(draftFrom(rule))}
                    className="w-full rounded-desk border border-line px-2.5 py-2 text-left text-[0.8125rem] hover:border-line-strong"
                  >
                    <span className="tnum block font-mono text-[0.6875rem] text-faint">
                      {rule.priority}
                    </span>
                    <span className="mt-0.5 block text-muted">{describeRule(rule)}</span>
                  </button>
                </li>
              ))}
              {rules.length === 0 ? (
                <li className="text-[0.8125rem] text-faint">
                  None. This block looks the same to everyone.
                </li>
              ) : null}
            </ul>
            <Button
              size="sm"
              className="mt-2"
              disabled={state.conflict}
              onClick={() => setDraft(emptyDraft(nextPriority(rules)))}
            >
              <span aria-hidden="true" className="text-faint">
                +
              </span>
              Rule
            </Button>
          </div>
        </div>
      )}
    </Sheet>
  );
}
