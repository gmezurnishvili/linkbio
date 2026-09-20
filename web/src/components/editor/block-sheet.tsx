"use client";

import { useEffect, useState } from "react";
import type { Block, FeedOutcome } from "@/lib/api/types";
import { FEED_SOURCES, feedRefHint, feedRefProblem } from "@/lib/feeds";
import { resolveEmbed } from "@/lib/site/embed";
import { describeRule } from "@/lib/rules/language";
import { fromLocalInput, toLocalInput } from "@/lib/datetime";
import { Button, Field, Input, Select, Sheet, Toggle } from "@/components/ui/primitives";
import { RuleBuilder, draftFrom, emptyDraft, normalise, type RuleDraft } from "./rule-builder";
import { nextPriority } from "./rules-library";
import { orderedRules, useProfile } from "./profile-store";

export function BlockSheet({ block, onClose }: { block: Block | null; onClose: () => void }) {
  const { state, ops } = useProfile();
  const [label, setLabel] = useState("");
  const [icon, setIcon] = useState("");
  const [url, setUrl] = useState("");
  const [feed, setFeed] = useState<NonNullable<Block["feed"]>>(EMPTY_FEED);
  const [draft, setDraft] = useState<RuleDraft | null>(null);

  const rules = orderedRules(block?.rules ?? []);

  useEffect(() => {
    if (!block) return;
    setLabel(block.label);
    setIcon(block.icon ?? "");
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
      icon: icon.trim(),
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
          <div className="flex gap-2">
            {block.kind !== "header" ? (
              // Deliberately a plain text field and not a picker. The backend
              // stores any string up to 64 characters and the renderer prints
              // it verbatim, so an emoji keyboard is the picker — a curated
              // set would be a shorter list than the one the OS already has.
              <Field label="Icon" className="w-20 flex-none">
                <Input
                  value={icon}
                  onChange={(e) => setIcon(e.target.value)}
                  placeholder="✦"
                  className="text-center"
                  maxLength={8}
                />
              </Field>
            ) : null}
            <Field label={block.kind === "header" ? "Text" : "Label"} className="flex-1">
              <Input value={label} onChange={(e) => setLabel(e.target.value)} />
            </Field>
          </div>

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

          <Schedule block={block} />

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
 * When this block is on the page at all.
 *
 * `activeFrom` and `activeUntil` are evaluated ahead of every rule — outside
 * the window the block resolves to `hide` with no rule involved — and the TTL
 * the evaluator returns runs exactly to the next boundary, so a block that
 * opens at eight is cached until eight and not a second past it. All of that
 * has been true and tested since the evaluator was written, with no control
 * anywhere to set the two fields.
 *
 * The window is a property of the block, so it saves on change rather than
 * waiting for the sheet's Save button, which only covers the label and the
 * destination. Two separate writes to the same block would race for the
 * version otherwise.
 */
function Schedule({ block }: { block: Block }) {
  const { state, ops } = useProfile();
  const busy = state.pending.has(block.id);

  const set = (field: "activeFrom" | "activeUntil", value: string) => {
    const iso = fromLocalInput(value);
    // null rather than undefined: `toBlockInput` only forwards keys that are
    // not undefined, so clearing a date has to be an explicit value. The
    // backend takes null as "no boundary" and an absent key as "leave it".
    void ops.updateBlock(block.id, { [field]: iso ? Date.parse(iso) : null });
  };

  const backwards =
    block.activeFrom && block.activeUntil && block.activeUntil <= block.activeFrom;

  return (
    <div className="flex flex-col gap-3 border-t border-line pt-4">
      <div>
        <p className="text-sm font-medium">When it&rsquo;s up</p>
        <p className="mt-0.5 text-[0.8125rem] text-muted">
          Leave both empty and it is always up. Outside the window nobody sees it, and no
          rule can bring it back.
        </p>
      </div>

      <div className="flex gap-2">
        <Field label="From">
          <Input
            type="datetime-local"
            className="tnum"
            disabled={busy}
            value={block.activeFrom ? toLocalInput(new Date(block.activeFrom)) : ""}
            onChange={(e) => set("activeFrom", e.target.value)}
          />
        </Field>
        <Field label="Until">
          <Input
            type="datetime-local"
            className="tnum"
            disabled={busy}
            value={block.activeUntil ? toLocalInput(new Date(block.activeUntil)) : ""}
            onChange={(e) => set("activeUntil", e.target.value)}
          />
        </Field>
      </div>

      {backwards ? (
        <p className="text-[0.8125rem] text-alert">
          Until is before From, so this block never shows. The server refuses this pair —
          fix one of them.
        </p>
      ) : null}
    </div>
  );
}

/**
 * What the refresher last did with this block, and a way to make it do it now.
 *
 * A feed block with no items renders as nothing at all on the public page, and
 * from the editor that is indistinguishable from the block not having saved.
 * This is the only place the difference is visible, so it says which it is.
 *
 * "Fetch now" is not a convenience. The scheduler runs one TTL apart, so
 * without it a creator who pastes the wrong channel id waits an hour to find
 * out — and learns nothing, because the error lands on a row they cannot see.
 */
function FeedStatus({ block }: { block: Block }) {
  const { state, ops } = useProfile();
  const [outcome, setOutcome] = useState<FeedOutcome | null>(null);
  const busy = state.pending.has(`${block.id}:feed`);

  const count = block.items?.length ?? 0;
  const fetched = block.feedRefreshedAt
    ? new Date(block.feedRefreshedAt).toLocaleString()
    : null;

  const fetchNow = async () => {
    setOutcome(null);
    setOutcome(await ops.refreshFeed(block.id));
  };

  return (
    <div className="rounded-desk bg-sunk px-3 py-2.5 text-[0.8125rem]">
      {block.feedError ? (
        <>
          <p className="text-alert">Last refresh failed</p>
          <p className="mt-1 text-muted">{block.feedError}</p>
          {block.feedFailures && block.feedFailures > 1 ? (
            <p className="mt-1 text-faint">
              {block.feedFailures} attempts in a row. Each failure doubles the wait before
              the next one.
            </p>
          ) : null}
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
          Not fetched yet. Feeds fill in on a schedule, so a new block stays empty for a few
          minutes — or fetch it now.
        </p>
      )}

      {/* The outcome of *this* click, which is not always the same thing as the
          block's stored state: an `unconfigured` source leaves no feedError
          behind, because a missing credential is not the creator's fault and
          should not back their block off. */}
      {outcome?.status === "unconfigured" ? (
        <p className="mt-1.5 text-clock">
          This source isn&rsquo;t configured on the server, so nothing can be fetched from it
          yet.
        </p>
      ) : outcome?.status === "ok" ? (
        <p className="mt-1.5 text-live">
          Fetched {outcome.items} item{outcome.items === 1 ? "" : "s"}.
        </p>
      ) : null}

      <Button
        size="sm"
        variant="quiet"
        className="mt-2"
        disabled={busy || !block.feed?.ref}
        onClick={() => void fetchNow()}
      >
        {busy ? "Fetching" : "Fetch now"}
      </Button>
    </div>
  );
}
