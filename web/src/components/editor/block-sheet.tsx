"use client";

import { useEffect, useState } from "react";
import type { Block } from "@/lib/api/types";
import { FEED_SOURCES, feedRefHint, feedRefProblem } from "@/lib/feeds";
import { resolveEmbed } from "@/lib/site/embed";
import { describeRule } from "@/lib/rules/language";
import { Button, Field, Input, Select, Sheet, Toggle } from "@/components/ui/primitives";
import { RuleBuilder, draftFrom, emptyDraft, normalise, type RuleDraft } from "./rule-builder";
import { nextPriority } from "./rules-library";
import { orderedRules, useProfile } from "./profile-store";

export function BlockSheet({ block, onClose }: { block: Block | null; onClose: () => void }) {
  const { state, ops } = useProfile();
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [feed, setFeed] = useState<NonNullable<Block["feed"]>>(EMPTY_FEED);
  const [draft, setDraft] = useState<RuleDraft | null>(null);

  const rules = orderedRules(block?.rules ?? []);

  useEffect(() => {
    if (!block) return;
    setLabel(block.label);
    setUrl(block.url ?? "");
    setFeed(block.feed ?? EMPTY_FEED);
    setDraft(null);
  }, [block?.id]);

  if (!block) return null;
  const busy = state.pending.has(block.id);
  const savingRules = state.pending.has(`${block.id}:rules`);

  const refProblem = block?.kind === "feed" ? feedRefProblem(feed.source, feed.ref) : null;
  // An embed whose URL no provider matches still renders — as a link card — so
  // this is a note, not an error.
  const embedFallback = block?.kind === "embed" && url.trim() !== "" && !resolveEmbed(url);

  function save() {
    void ops.updateBlock(block!.id, {
      label,
      // A link is refused without a destination and an embed is useless without
      // one, so both send it. `checkBlockShape` validates the merged block, so
      // clearing a link's target on a PATCH is a 400 rather than a silent 404
      // at the redirector later.
      ...(block!.kind === "link" || block!.kind === "embed" ? { url } : {}),
      ...(block!.kind === "feed" ? { feed } : {}),
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
            <Button variant="primary" onClick={save} disabled={busy || Boolean(refProblem)}>
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

          {(block.kind === "link" || block.kind === "embed") && (
            <Field
              label={block.kind === "embed" ? "What to embed" : "Destination"}
              hint={
                block.kind === "embed"
                  ? "A share link from YouTube, Spotify, SoundCloud, Vimeo or Apple Music."
                  : "Rules can send some visitors somewhere else without changing this."
              }
            >
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://"
                inputMode="url"
              />
              {embedFallback && (
                <p className="mt-1.5 text-[0.8125rem] text-muted">
                  No player for that link — it will render as an ordinary link card.
                </p>
              )}
            </Field>
          )}

          {block.kind === "feed" && (
            <>
              <Field label="Source">
                <Select
                  value={feed.source}
                  onChange={(e) => setFeed({ ...feed, source: e.target.value })}
                >
                  {FEED_SOURCES.map((sourceId) => (
                    <option key={sourceId} value={sourceId}>
                      {sourceId}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="What to pull" hint={feedRefHint(feed.source)} error={refProblem ?? undefined}>
                <Input value={feed.ref} onChange={(e) => setFeed({ ...feed, ref: e.target.value })} />
              </Field>

              <Field
                label="Refresh every"
                hint="The page itself is cached for up to five minutes on top of this."
              >
                <Select
                  value={String(feed.ttlSeconds)}
                  onChange={(e) => setFeed({ ...feed, ttlSeconds: Number(e.target.value) })}
                >
                  {[
                    [900, "15 minutes"],
                    [3600, "hour"],
                    [21600, "6 hours"],
                    [86400, "day"],
                  ].map(([seconds, human]) => (
                    <option key={seconds} value={seconds}>
                      {human}
                    </option>
                  ))}
                </Select>
              </Field>

              <FeedStatus block={block} />
            </>
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

const EMPTY_FEED = { source: "rss", ref: "", ttlSeconds: 3600 };

/**
 * What the refresher last did with this block.
 *
 * A feed block with no items renders as nothing at all on the public page, and
 * from the editor that is indistinguishable from the block not having saved.
 * This is the only place the difference is visible, so it says which it is.
 */
function FeedStatus({ block }: { block: Block }) {
  const count = block.items?.length ?? 0;
  const fetched = block.feedRefreshedAt
    ? new Date(block.feedRefreshedAt).toLocaleString()
    : null;

  return (
    <div className="rounded-desk bg-sunk px-3 py-2.5 text-[0.8125rem]">
      {block.feedError ? (
        <>
          <p className="text-alert">Last refresh failed</p>
          <p className="mt-1 text-muted">{block.feedError}</p>
          {count > 0 && (
            <p className="mt-1 text-muted">
              Still showing {count} item{count === 1 ? "" : "s"} from {fetched}.
            </p>
          )}
        </>
      ) : fetched ? (
        <p className="text-muted">
          {count} item{count === 1 ? "" : "s"}, fetched {fetched}.
        </p>
      ) : (
        <p className="text-muted">
          Not fetched yet. Feeds fill in on a schedule, so a new block stays empty for a few minutes.
        </p>
      )}
    </div>
  );
}
