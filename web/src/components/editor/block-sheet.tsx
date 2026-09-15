"use client";

import { useEffect, useState } from "react";
import type { Block } from "@/lib/api/types";
import { describeRule } from "@/lib/rules/language";
import { Button, Field, Input, Select, Sheet, Toggle } from "@/components/ui/primitives";
import { RuleBuilder, draftFrom, emptyDraft, type RuleDraft } from "./rule-builder";
import { useBlockRules, useProfile } from "./profile-store";

export function BlockSheet({ block, onClose }: { block: Block | null; onClose: () => void }) {
  const { state, ops } = useProfile();
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [slug, setSlug] = useState("");
  const [prompt, setPrompt] = useState("");
  const [draft, setDraft] = useState<RuleDraft | null>(null);

  const rules = useBlockRules(block ?? ({ ruleIds: [] } as unknown as Block));

  useEffect(() => {
    if (!block) return;
    setLabel(block.label);
    setUrl(block.url ?? "");
    setSlug(block.slug ?? "");
    setPrompt(block.gate?.prompt ?? "");
    setDraft(null);
  }, [block?.id]);

  if (!block) return null;
  const busy = state.pending.has(block.id);

  function save() {
    void ops.updateBlock(block!.id, {
      label,
      ...(block!.kind === "link" || block!.kind === "gate" ? { url, slug: slug || undefined } : {}),
      ...(block!.kind === "gate" && block!.gate
        ? { gate: { ...block!.gate, prompt } }
        : {}),
    });
  }

  async function saveRule() {
    if (!draft) return;
    const saved = await ops.saveRule({
      id: draft.id,
      name: draft.name,
      conditions: draft.conditions,
      effect: draft.effect,
      priority: draft.priority,
      enabled: draft.enabled,
    });
    if (!saved) return;
    if (!block!.ruleIds.includes(saved.id)) {
      await ops.updateBlock(block!.id, { ruleIds: [...block!.ruleIds, saved.id] });
    }
    setDraft(null);
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={block.kind === "text" ? "Note" : block.label || "Block"}
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
      ) : (
        <div className="flex flex-col gap-4">
          <Field label={block.kind === "text" ? "Text" : "Label"}>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} />
          </Field>

          {(block.kind === "link" || block.kind === "gate") && (
            <>
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
              <Field label="Short path" hint={`Visitors reach it at /${state.profile.handle}/l/${slug || "…"}`}>
                <Input
                  value={slug}
                  onChange={(e) => setSlug(e.target.value.replace(/[^a-z0-9-]/gi, "").toLowerCase())}
                  placeholder="presave"
                />
              </Field>
            </>
          )}

          {block.kind === "gate" && (
            <>
              <Field label="What visitors do first">
                <Select
                  value={block.gate?.type ?? "email"}
                  onChange={(e) =>
                    void ops.updateBlock(block.id, {
                      gate: {
                        type: e.target.value as NonNullable<Block["gate"]>["type"],
                        prompt,
                      },
                    })
                  }
                >
                  <option value="email">Leave an email</option>
                  <option value="code">Enter a code</option>
                  <option value="referrer">Arrive from a specific place</option>
                </Select>
              </Field>
              <Field label="Prompt">
                <Input value={prompt} onChange={(e) => setPrompt(e.target.value)} />
              </Field>
            </>
          )}

          {block.kind === "feed" && block.source && (
            <div className="rounded-desk bg-sunk px-3 py-2.5 text-[0.8125rem]">
              <p>
                Filled by <span className="font-mono">{block.source.adapter}</span>
              </p>
              <p className="mt-1 text-muted">
                {block.source.itemCount ?? 0} items
                {block.source.refreshedAt
                  ? `, last refreshed ${new Date(block.source.refreshedAt).toLocaleString()}`
                  : ", never refreshed"}
              </p>
            </div>
          )}

          <div className="flex flex-col gap-3 border-t border-line pt-4">
            <Toggle
              checked={!block.hidden}
              onChange={(next) => void ops.updateBlock(block.id, { hidden: !next })}
              label="Visible"
              description="Hidden blocks stay in your list but never render."
            />
            <Toggle
              checked={block.banditEnabled}
              onChange={(next) => void ops.updateBlock(block.id, { banditEnabled: next })}
              label="Let position be optimised"
              description="Moves this block up or down based on what gets clicked."
            />
            {block.banditEnabled ? (
              <Toggle
                checked={block.banditPinned}
                onChange={(next) => void ops.updateBlock(block.id, { banditPinned: next })}
                label="Pin where it is"
                description="Keeps the current position while still measuring clicks."
              />
            ) : null}
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
                    <span className="block font-medium">{rule.name}</span>
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
            <Button size="sm" className="mt-2" onClick={() => setDraft(emptyDraft())}>
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
