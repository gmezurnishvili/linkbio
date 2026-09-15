"use client";

import { useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type { Block } from "@/lib/api/types";
import { Button, Empty } from "@/components/ui/primitives";
import { BlockRow, BlockRowOverlay } from "./block-row";
import { BlockSheet } from "./block-sheet";
import { CacheCost } from "./cache-cost";
import { useProfile } from "./profile-store";

export function BlocksPanel() {
  const { state, ops } = useProfile();
  const [openId, setOpenId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const blocks = state.profile.blocks;

  const sensors = useSensors(
    // A small distance threshold keeps a tap-to-open from registering as a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function onDragStart({ active }: DragStartEvent) {
    setDraggingId(String(active.id));
  }

  function onDragEnd({ active, over }: DragEndEvent) {
    setDraggingId(null);
    if (!over || active.id === over.id) return;
    const to = blocks.findIndex((b) => b.id === over.id);
    if (to !== -1) void ops.reorder(String(active.id), to);
  }

  const open = blocks.find((b) => b.id === openId) ?? null;
  const dragging = blocks.find((b) => b.id === draggingId) ?? null;

  return (
    <section>
      <header className="mb-2 flex items-baseline justify-between">
        <h2 className="text-[0.8125rem] text-muted">Blocks</h2>
        <span className="tnum font-mono text-[0.6875rem] text-faint">
          {blocks.length ? `${blocks[0]!.rank} → ${blocks[blocks.length - 1]!.rank}` : "empty"}
        </span>
      </header>

      {blocks.length === 0 ? (
        <Empty
          title="Add your first link"
          body="Blocks are what visitors see. Rules come after — you can't route traffic to something that isn't there yet."
          action={
            <Button variant="primary" onClick={() => add("link", "New link")}>
              Add a link
            </Button>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-desk border border-line bg-panel">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis]}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onDragCancel={() => setDraggingId(null)}
          >
            <SortableContext
              items={blocks.map((b) => b.id)}
              strategy={verticalListSortingStrategy}
            >
              <ul>
                {blocks.map((b) => (
                  <BlockRow key={b.id} block={b} onOpen={() => setOpenId(b.id)} />
                ))}
              </ul>
            </SortableContext>

            {/* The row in the list stays behind as the slot being aimed at, so
                what follows the pointer has to be a copy of it. */}
            <DragOverlay>{dragging ? <BlockRowOverlay block={dragging} /> : null}</DragOverlay>
          </DndContext>
        </div>
      )}

      <div className="mt-2.5 flex flex-wrap gap-2">
        {/* The four the backend accepts (BLOCK_KINDS). "Gated link" is gone:
            there is no gate kind, so every one of those was a 400. */}
        <AddButton label="Link" onClick={() => add("link", "New link")} />
        <AddButton label="Feed" onClick={() => add("feed", "Tour dates")} />
        <AddButton label="Embed" onClick={() => add("embed", "Embedded")} />
        <AddButton label="Note" onClick={() => add("header", "Say something")} />
      </div>

      <CacheCost />

      <BlockSheet block={open} onClose={() => setOpenId(null)} />
    </section>
  );

  /**
   * A new block has to arrive complete.
   *
   * `checkBlockShape` refuses a link with no target and a feed with no source,
   * so "add an empty one and fill it in" is a 400 rather than a draft. The
   * placeholders below are what the creator replaces in the sheet — visibly
   * wrong on purpose, because a plausible-looking default is one you forget to
   * change.
   */
  function add(kind: Block["kind"], label: string) {
    void ops.createBlock({
      kind,
      label,
      ...(kind === "link" || kind === "embed" ? { url: "https://example.com" } : {}),
      ...(kind === "feed"
        ? { feed: { source: "rss", ref: "https://example.com/feed.xml", ttlSeconds: 3600 } }
        : {}),
    });
  }
}

function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  const { state } = useProfile();
  return (
    <Button size="sm" onClick={onClick} disabled={state.conflict || state.pending.has("new")}>
      <span aria-hidden="true" className="text-faint">
        +
      </span>
      {label}
    </Button>
  );
}
