"use client";

import { Chip } from "@/components/ui/primitives";
import { deriveCacheDimensions, estimateVariants } from "@/lib/rules/language";
import { useProfile } from "./profile-store";

/**
 * What the current rules cost at the edge.
 *
 * The mask is a correctness gate on the backend, so it is worth showing here
 * rather than hiding: a creator who adds a per-country rule for six markets has
 * just multiplied their cache entries, and the only person who can decide
 * whether that trade is worth it is them. Showing the number turns an invisible
 * infrastructure consequence into an editorial choice.
 *
 * The published value is authoritative. The derived value is only used to warn
 * that an unsaved edit will change it.
 */
export function CacheCost() {
  const { state } = useProfile();
  const published = state.profile.cacheDimensions;
  // Rules live on blocks now, so the estimate is over every rule on the page —
  // which is also what the backend's own `cacheDimensionsFor` reads.
  const rules = state.profile.blocks.flatMap((b) => b.rules);
  const pending = deriveCacheDimensions(rules);
  const added = pending.filter((d) => !published.includes(d));
  const variants = estimateVariants(rules);

  return (
    <div className="mt-5 rounded-desk bg-sunk px-3 py-2.5">
      <p className="text-[0.75rem] text-muted">Cached separately for</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {published.length === 0 && added.length === 0 ? (
          <span className="text-[0.8125rem]">Everyone — one copy at the edge.</span>
        ) : (
          <>
            {published.map((d) => (
              <Chip key={d} tone="geo" className="font-mono">
                {d}
              </Chip>
            ))}
            {added.map((d) => (
              <Chip key={d} tone="clock" className="font-mono">
                +{d}
              </Chip>
            ))}
            <span className="tnum text-[0.75rem] text-faint">
              up to {variants} cached copies
            </span>
          </>
        )}
      </div>
      {added.length > 0 ? (
        <p className="mt-2 text-[0.75rem] text-clock">
          Publishing adds {added.join(" and ")} to the cache key. Coarser values — a
          region instead of six countries — keep more visitors on a warm copy.
        </p>
      ) : null}
    </div>
  );
}
