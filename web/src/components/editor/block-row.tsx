"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Block, Dimension } from "@/lib/api/types";
import type { RuleDimension } from "@/lib/rules/schema";
import { TONE_DIMENSION, describeCondition } from "@/lib/rules/language";
import { Chip, DIMENSION_TONE, cx } from "@/components/ui/primitives";
import { orderedRules, useProfile } from "./profile-store";

const KIND_LABEL: Record<Block["kind"], string> = {
  link: "",
  feed: "feed",
  header: "note",
  embed: "embed",
};

const ROW = "relative flex gap-3 bg-panel px-3 py-3";

/**
 * A block row's left edge is a rail, split into one segment per context
 * dimension the block's rules read. It is the fastest way to answer "which of
 * these change by who's looking" while scanning a list, and it costs no
 * horizontal space in a column that is already tight.
 */
export function BlockRow({ block, onOpen }: { block: Block; onOpen: () => void }) {
  const { state } = useProfile();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: block.id });
  const busy = state.pending.has(block.id);

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cx(
        ROW,
        "border-b border-line last:border-b-0",
        isDragging && "is-dragging z-10",
        busy && "opacity-60",
      )}
    >
      <RowBody block={block} onOpen={onOpen} handleProps={{ ...attributes, ...listeners }} />
    </li>
  );
}

/**
 * The copy that travels with the pointer. The row itself stays put as the slot
 * the drop will land in, so without this there is nothing to look at mid-drag.
 */
export function BlockRowOverlay({ block }: { block: Block }) {
  return (
    <div
      aria-hidden="true"
      className={cx(ROW, "rounded-desk border border-line-strong shadow-lg")}
    >
      <RowBody block={block} />
    </div>
  );
}

function RowBody({
  block,
  onOpen,
  handleProps,
}: {
  block: Block;
  onOpen?: () => void;
  handleProps?: Record<string, unknown>;
}) {
  const rules = orderedRules(block.rules);

  // The rail is painted from the product's colour vocabulary, which predates
  // the backend's dimension names; `TONE_DIMENSION` is the map between them.
  const dimensions = [
    ...new Set(rules.flatMap((r) => r.when.map((c) => TONE_DIMENSION[c.dim]))),
  ];

  return (
    <>
      <Rail dimensions={dimensions} />

      <button
        type="button"
        {...handleProps}
        tabIndex={handleProps ? undefined : -1}
        aria-label={`Reorder ${block.label}`}
        className="mt-0.5 h-5 w-4 flex-none cursor-grab text-faint hover:text-muted active:cursor-grabbing"
      >
        <svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true" fill="currentColor">
          <circle cx="2" cy="3" r="1.2" />
          <circle cx="8" cy="3" r="1.2" />
          <circle cx="2" cy="8" r="1.2" />
          <circle cx="8" cy="8" r="1.2" />
          <circle cx="2" cy="13" r="1.2" />
          <circle cx="8" cy="13" r="1.2" />
        </svg>
      </button>

      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={onOpen}
          tabIndex={onOpen ? undefined : -1}
          className="block w-full text-left"
        >
          <span className="flex items-center gap-2">
            {/* aria-hidden for the same reason the public page hides it: the
                label beside it already says what this is. */}
            {block.icon ? (
              <span aria-hidden="true" className="flex-none text-[0.9375rem] leading-none">
                {block.icon}
              </span>
            ) : null}
            <span
              className={cx(
                "truncate text-sm font-medium",
                block.hidden && "text-muted line-through decoration-line-strong",
              )}
            >
              {block.label}
            </span>
            {KIND_LABEL[block.kind] ? (
              <Chip tone="neutral">{KIND_LABEL[block.kind]}</Chip>
            ) : null}
          </span>

          {rules.length > 0 ? (
            <span className="mt-1.5 flex flex-wrap gap-1.5">
              {rules.map((rule) =>
                rule.when.map((c, i) => (
                  <Chip key={`${rule.id}-${i}`} tone={toneFor(c.dim)}>
                    {describeCondition(c)}
                  </Chip>
                )),
              )}
            </span>
          ) : block.kind === "link" && block.url ? (
            <span className="mt-1 block truncate text-[0.75rem] text-faint">{block.url}</span>
          ) : null}

          {block.feed ? (
            <span className="mt-1 block text-[0.75rem] text-faint">
              {block.feed.source}
              {block.feedRefreshedAt
                ? ` · refreshed ${relative(block.feedRefreshedAt)}`
                : " · never refreshed"}
            </span>
          ) : null}
        </button>
      </div>
    </>
  );
}

function Rail({ dimensions }: { dimensions: Dimension[] }) {
  if (dimensions.length === 0) {
    return <span aria-hidden="true" className="absolute left-0 top-0 h-full w-[3px] bg-line" />;
  }
  return (
    <span
      aria-hidden="true"
      className="absolute left-0 top-0 flex h-full w-[3px] flex-col overflow-hidden"
    >
      {dimensions.map((d) => (
        <span key={d} className={cx("flex-1", DIMENSION_TONE[d].bar)} />
      ))}
    </span>
  );
}

function toneFor(d: RuleDimension) {
  if (d === "time") return "clock" as const;
  if (d === "geo") return "geo" as const;
  if (d === "referrer") return "neutral" as const;
  return "device" as const;
}

function relative(at: number): string {
  const ms = Date.now() - at;
  if (!Number.isFinite(ms)) return "unknown";
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
