"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api/client";
import type { Resolution, VisitorContext } from "@/lib/api/types";
import { toLocalInput } from "@/lib/datetime";
import { renderProfile } from "@/lib/site/render";
import { GEO_LABELS, REFERRER_LABELS } from "@/lib/rules/language";
import { DEVICES, GEO_BUCKETS, REFERRERS } from "@/lib/rules/schema";
import { Chip, Select, Toggle, cx } from "@/components/ui/primitives";
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

/**
 * Every control here is a dimension the evaluator can actually tell apart.
 *
 * It used to offer nine countries and an os — "iPhone · Safari" against
 * "Android · Chrome" — and neither survived the trip: the adapter folds a
 * country into one of six buckets and drops os outright, so picking iOS moved
 * nothing on screen. A control that changes nothing is worse than a missing
 * one, because it teaches a creator that their rule does not work.
 *
 * The lists come from lib/rules/schema.ts, which mirrors the backend's enums,
 * and the words from lib/rules/language.ts, so a bucket is named the same here
 * as it is in the rule that selects it.
 *
 * `ANY` is the empty option every picker carries: a visitor the edge could not
 * classify, which is a real visitor and not the same as any of the values.
 */
const ANY = "";

type Geo = NonNullable<VisitorContext["geo"]>;
type Device = NonNullable<VisitorContext["device"]>;
type Referrer = NonNullable<VisitorContext["referrer"]>;

/** Enough to exercise a `lang` rule; the wire wants a two-letter code. */
const LANGUAGES = [
  ["en", "English"],
  ["es", "Spanish"],
  ["pt", "Portuguese"],
  ["fr", "French"],
  ["de", "German"],
  ["ja", "Japanese"],
  ["ar", "Arabic"],
] as const;

export function Simulator() {
  const { state } = useProfile();
  const [geo, setGeo] = useState<Geo | typeof ANY>(ANY);
  const [device, setDevice] = useState<Device | typeof ANY>(ANY);
  const [referrer, setReferrer] = useState<Referrer | typeof ANY>(ANY);
  const [language, setLanguage] = useState<string>("en");
  const [webview, setWebview] = useState(false);
  const [at, setAt] = useState(() => toLocalInput(new Date()));
  const [resolution, setResolution] = useState<Resolution | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const seq = useRef(0);

  const context = useMemo<VisitorContext>(() => {
    const instant = new Date(at);
    return {
      // The coarse values directly: these are the ones the edge would have
      // computed, and `toWireContext` passes them straight through. "Anywhere"
      // is absent rather than a bucket, which is how a visitor whose country
      // header never arrived reaches the evaluator.
      geo: geo || undefined,
      device: device || undefined,
      referrer: referrer || undefined,
      language: language || undefined,
      webview,
      at: (Number.isNaN(instant.getTime()) ? new Date() : instant).toISOString(),
    };
  }, [geo, device, referrer, language, webview, at]);

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
        <Select aria-label="Region" value={geo} onChange={(e) => setGeo(e.target.value as Geo)}>
          <option value={ANY}>Anywhere</option>
          {GEO_BUCKETS.map((b) => (
            <option key={b} value={b}>
              {GEO_LABELS[b] ?? b}
            </option>
          ))}
        </Select>

        <Select
          aria-label="Device"
          value={device}
          onChange={(e) => setDevice(e.target.value as Device)}
        >
          <option value={ANY}>Any device</option>
          {DEVICES.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </Select>

        <Select
          aria-label="Came from"
          value={referrer}
          onChange={(e) => setReferrer(e.target.value as Referrer)}
        >
          <option value={ANY}>Any source</option>
          {REFERRERS.map((r) => (
            <option key={r} value={r}>
              {REFERRER_LABELS[r] ?? r}
            </option>
          ))}
        </Select>

        <Select
          aria-label="Language"
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
        >
          <option value={ANY}>Any language</option>
          {LANGUAGES.map(([code, name]) => (
            <option key={code} value={code}>
              {name}
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

        <Toggle
          checked={webview}
          onChange={setWebview}
          label="In-app browser"
          description="Opened inside Instagram or TikTok rather than in Safari or Chrome."
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
