"use client";

import { useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type { Block } from "@/lib/api/types";
import { Button, Empty } from "@/components/ui/primitives";
import { BlockRow } from "./block-row";
import { BlockSheet } from "./block-sheet";
import { CacheCost } from "./cache-cost";
import { useProfile } from "./profile-store";

export function BlocksPanel() {
  const { state, ops } = useProfile();
  const [openId, setOpenId] = useState<string | null>(null);
  const blocks = state.profile.blocks;

  const sensors = useSensors(
    // A small distance threshold keeps a tap-to-open from registering as a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    const to = blocks.findIndex((b) => b.id === over.id);
    if (to !== -1) void ops.reorder(String(active.id), to);
  }

  const open = blocks.find((b) => b.id === openId) ?? null;

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
            <Button
              variant="primary"
              onClick={() => void ops.createBlock({ kind: "link", label: "New link" })}
            >
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
            onDragEnd={onDragEnd}
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
          </DndContext>
        </div>
      )}

      <div className="mt-2.5 flex flex-wrap gap-2">
        <AddButton label="Link" onClick={() => add("link", "New link")} />
        <AddButton label="Feed" onClick={() => add("feed", "Tour dates")} />
        <AddButton label="Gated link" onClick={() => add("gate", "Members only")} />
        <AddButton label="Note" onClick={() => add("text", "Say something")} />
      </div>

      <CacheCost />

      <BlockSheet block={open} onClose={() => setOpenId(null)} />
    </section>
  );

  function add(kind: Block["kind"], label: string) {
    void ops.createBlock({ kind, label });
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
