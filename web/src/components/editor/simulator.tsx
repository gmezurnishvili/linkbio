"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api/client";
import type { Resolution, VisitorContext } from "@/lib/api/types";
import { renderProfile } from "@/lib/site/render";
import { Chip, Select, cx } from "@/components/ui/primitives";
import { useProfile } from "./profile-store";

/**
 * The simulator is the reason the rest of this app is trustworthy.
 *
 * A page that changes by context is unverifiable by looking at it — a creator
 * only ever sees their own variant. So this asks the backend to run the real
 * evaluator against an injected context and renders the result with the same
 * renderProfile the public route uses. What appears in the frame is not an
 * approximation of the visitor's page; it is that page, byte for byte, minus
 * the beacons.
 *
 * The trace underneath is the evaluator's own reasoning, including the
 * s-maxage it computed and the next instant the answer changes.
 */

const COUNTRIES = [
  ["", "Anywhere"],
  ["US", "United States"],
  ["CA", "Canada"],
  ["GB", "United Kingdom"],
  ["DE", "Germany"],
  ["GE", "Georgia"],
  ["BR", "Brazil"],
  ["JP", "Japan"],
  ["NG", "Nigeria"],
  ["AU", "Australia"],
] as const;

const CLIENTS: { label: string; ctx: Partial<VisitorContext> }[] = [
  { label: "iPhone · Safari", ctx: { device: "mobile", os: "ios" } },
  { label: "iPhone · Instagram", ctx: { device: "mobile", os: "ios", referrerHost: "instagram.com" } },
  { label: "Android · Chrome", ctx: { device: "mobile", os: "android" } },
  { label: "Android · TikTok", ctx: { device: "mobile", os: "android", referrerHost: "tiktok.com" } },
  { label: "iPad", ctx: { device: "tablet", os: "ios" } },
  { label: "Mac · desktop", ctx: { device: "desktop", os: "macos" } },
];

export function Simulator() {
  const { state } = useProfile();
  const [clientIndex, setClientIndex] = useState(0);
  const [country, setCountry] = useState("");
  const [at, setAt] = useState(() => toLocalInput(new Date()));
  const [resolution, setResolution] = useState<Resolution | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const seq = useRef(0);

  const context = useMemo<VisitorContext>(() => {
    const client = CLIENTS[clientIndex] ?? CLIENTS[0]!;
    const instant = new Date(at);
    return {
      ...client.ctx,
      country: country || undefined,
      language: "en",
      at: (Number.isNaN(instant.getTime()) ? new Date() : instant).toISOString(),
    };
  }, [clientIndex, country, at]);

  // Re-resolve on any context change and after any mutation — the profile
  // version is in the dependency list precisely so an edit refreshes the frame.
  useEffect(() => {
    const id = ++seq.current;
    const timer = setTimeout(async () => {
      setStatus("loading");
      try {
        const next = await api.preview(state.profile.id, context);
        if (seq.current === id) {
          setResolution(next);
          setStatus("idle");
        }
      } catch {
        if (seq.current === id) setStatus("error");
      }
    }, 180);
    return () => clearTimeout(timer);
  }, [context, state.profile.id, state.profile.version]);

  const html = useMemo(
    () =>
      resolution
        ? renderProfile({
            resolution,
            origin: process.env.NEXT_PUBLIC_SITE_ORIGIN ?? "",
            beaconUrl: "",
            preview: true,
          })
        : "",
    [resolution],
  );

  return (
    <aside className="flex flex-col gap-3">
      <h2 className="text-[0.8125rem] text-muted">Simulate a visitor</h2>

      <div className="flex flex-col gap-2">
        <Select
          aria-label="Country"
          value={country}
          onChange={(e) => setCountry(e.target.value)}
        >
          {COUNTRIES.map(([code, name]) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </Select>

        <Select
          aria-label="Client"
          value={clientIndex}
          onChange={(e) => setClientIndex(Number(e.target.value))}
        >
          {CLIENTS.map((c, i) => (
            <option key={c.label} value={i}>
              {c.label}
            </option>
          ))}
        </Select>

        <input
          aria-label="Time of visit"
          type="datetime-local"
          value={at}
          onChange={(e) => setAt(e.target.value)}
          className="tnum h-9 w-full rounded-desk border border-line bg-panel px-2.5 text-sm outline-none focus:border-geo"
        />
      </div>

      <div className="rounded-[14px] bg-sunk p-2.5">
        <div
          className={cx(
            "overflow-hidden rounded-[10px] border border-line-strong bg-white transition-opacity",
            status === "loading" && "opacity-60",
          )}
        >
          {resolution ? (
            <iframe
              title="Visitor preview"
              srcDoc={html}
              sandbox="allow-scripts allow-popups"
              className="h-[560px] w-full border-0"
            />
          ) : (
            <div className="grid h-[560px] place-items-center px-6 text-center text-[0.8125rem] text-muted">
              {status === "error"
                ? "Couldn't reach the evaluator. Retry by changing a field."
                : "Resolving…"}
            </div>
          )}
        </div>
      </div>

      {resolution ? <Trace resolution={resolution} /> : null}
    </aside>
  );
}

function Trace({ resolution }: { resolution: Resolution }) {
  return (
    <div>
      <h3 className="mb-1.5 text-[0.8125rem] text-muted">Why this page</h3>
      <ul className="flex flex-col gap-0.5 font-mono text-[0.6875rem] leading-5">
        {resolution.trace.length === 0 ? (
          <li className="text-faint">No rules applied. Everyone sees this.</li>
        ) : (
          resolution.trace.map((step, i) => (
            <li key={`${step.ruleId}-${i}`} className="flex gap-2">
              <span className={step.outcome === "match" ? "text-live" : "text-faint"}>
                {step.outcome === "match" ? "match" : "skip "}
              </span>
              <span className="min-w-0 flex-1 truncate text-ink" title={step.ruleName}>
                {step.ruleName}
              </span>
              <span className="text-muted">{step.because}</span>
            </li>
          ))
        )}
      </ul>

      <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-line pt-2 text-[0.75rem]">
        <span className="text-muted">Cached for</span>
        <span className="tnum font-mono">{formatTtl(resolution.sMaxAge)}</span>
        {resolution.varyOn.length > 0 ? (
          <>
            <span className="text-muted">keyed on</span>
            {resolution.varyOn.map((d) => (
              <Chip key={d} tone="geo" className="font-mono">
                {d}
              </Chip>
            ))}
          </>
        ) : (
          <Chip tone="live">one copy for everyone</Chip>
        )}
      </div>

      {resolution.warnings.map((w, i) => (
        <p key={i} className="mt-2 rounded-desk bg-clock-wash px-2.5 py-2 text-[0.75rem] text-clock">
          {w.message}
        </p>
      ))}
    </div>
  );
}

function formatTtl(seconds: number): string {
  if (seconds <= 0) return "not cached";
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

/** datetime-local wants local wall time with no zone suffix. */
function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}
