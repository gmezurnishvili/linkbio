import { BlocksPanel } from "@/components/editor/blocks-panel";
import { Simulator } from "@/components/editor/simulator";

/**
 * The editor. Two columns, and the split is deliberate: what the page is on the
 * left, what a given visitor gets on the right. Neither makes sense alone.
 */
export default function EditorPage() {
  return (
    <div className="grid gap-7 lg:grid-cols-[minmax(0,1fr)_17rem]">
      <BlocksPanel />
      <Simulator />
    </div>
  );
}
