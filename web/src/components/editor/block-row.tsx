"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Block, Dimension } from "@/lib/api/types";
import { describeCondition } from "@/lib/rules/language";
import { Chip, DIMENSION_TONE, cx } from "@/components/ui/primitives";
import { useBlockRules, useProfile } from "./profile-store";

const KIND_LABEL: Record<Block["kind"], string> = {
  link: "",
  feed: "feed",
  gate: "gated",
  text: "note",
  embed: "embed",
};

/**
 * A block row's left edge is a rail, split into one segment per context
 * dimension the block's rules read. It is the fastest way to answer "which of
 * these change by who's looking" while scanning a list, and it costs no
 * horizontal space in a column that is already tight.
 */
export function BlockRow({ block, onOpen }: { block: Block; onOpen: () => void }) {
  const { state } = useProfile();
  const rules = useBlockRules(block);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: block.id });

  const dimensions = [
    ...new Set(rules.flatMap((r) => r.conditions.map((c) => c.dimension))),
  ] as Dimension[];
  const warnings = rules.flatMap((r) => r.warnings ?? []);
  const busy = state.pending.has(block.id);

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cx(
        "relative flex gap-3 border-b border-line bg-panel px-3 py-3 last:border-b-0",
        isDragging && "is-dragging z-10",
        busy && "opacity-60",
      )}
    >
      <Rail dimensions={dimensions} />

      <button
        type="button"
        {...attributes}
        {...listeners}
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
        <button type="button" onClick={onOpen} className="block w-full text-left">
          <span className="flex items-center gap-2">
            <span
              className={cx(
                "truncate text-sm font-medium",
                block.hidden && "text-muted line-through decoration-line-strong",
              )}
            >
              {block.label}
            </span>
            {KIND_LABEL[block.kind] ? (
              <Chip tone={block.kind === "gate" ? "alert" : "neutral"}>
                {KIND_LABEL[block.kind]}
              </Chip>
            ) : null}
            {block.banditEnabled ? (
              <Chip tone="live">{block.banditPinned ? "pinned" : "auto-order"}</Chip>
            ) : null}
          </span>

          {rules.length > 0 ? (
            <span className="mt-1.5 flex flex-wrap gap-1.5">
              {rules.map((rule) =>
                rule.conditions.map((c, i) => (
                  <Chip key={`${rule.id}-${i}`} tone={toneFor(c.dimension)}>
                    {describeCondition(c)}
                  </Chip>
                )),
              )}
            </span>
          ) : block.kind === "link" && block.url ? (
            <span className="mt-1 block truncate text-[0.75rem] text-faint">{block.url}</span>
          ) : null}

          {block.source ? (
            <span className="mt-1 block text-[0.75rem] text-faint">
              {block.source.adapter}
              {block.source.refreshedAt
                ? ` · refreshed ${relative(block.source.refreshedAt)}`
                : " · never refreshed"}
            </span>
          ) : null}
        </button>

        {warnings.map((w, i) => (
          <p
            key={i}
            className="mt-2 rounded-desk bg-clock-wash px-2 py-1.5 text-[0.75rem] text-clock"
          >
            {w.message}
          </p>
        ))}
      </div>
    </li>
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

function toneFor(d: Dimension) {
  if (d === "time") return "clock" as const;
  if (d === "country" || d === "region") return "geo" as const;
  if (d === "referrer") return "neutral" as const;
  return "device" as const;
}

function relative(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "unknown";
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
