"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api/client";
import type { PageMode, Theme } from "@/lib/api/types";
import { handleProblem } from "@/lib/handles";
import { Button, Chip, Field, Input, Select, cx } from "@/components/ui/primitives";
import { useProfile } from "./profile-store";

const MODES: { value: PageMode; label: string; help: string }[] = [
  { value: "standard", label: "Standard", help: "A page of links." },
  {
    value: "event",
    label: "Event",
    help: "Counts down to a time, then rearranges itself around the event.",
  },
  {
    value: "drop",
    label: "Drop",
    help: "Hides everything behind a countdown, then releases it at once.",
  },
];

const PRESETS: Theme["preset"][] = ["paper", "ink", "signal"];

export function SettingsForm() {
  const { state, ops } = useProfile();
  const p = state.profile;

  const [displayName, setDisplayName] = useState(p.displayName);
  const [bio, setBio] = useState(p.bio);

  return (
    <div className="flex max-w-[34rem] flex-col gap-8">
      <section className="flex flex-col gap-4">
        <h2 className="text-[0.9375rem] font-medium">Who this is</h2>

        <Field label="Name">
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>

        <Field label="Bio" hint="Two lines at most. It sits above every link.">
          <Input value={bio} onChange={(e) => setBio(e.target.value)} />
        </Field>

        <div>
          <Button
            variant="primary"
            onClick={() => void ops.updateProfileFields({ displayName, bio })}
            disabled={displayName === p.displayName && bio === p.bio}
          >
            Save
          </Button>
        </div>
      </section>

      <HandleSection />

      <section className="flex flex-col gap-3">
        <h2 className="text-[0.9375rem] font-medium">Page mode</h2>
        <div className="flex flex-col gap-2">
          {MODES.map((mode) => (
            <button
              key={mode.value}
              type="button"
              onClick={() => void ops.updateProfileFields({ mode: mode.value })}
              className={cx(
                "rounded-desk border px-3 py-2.5 text-left transition-colors",
                p.mode === mode.value
                  ? "border-ink bg-panel"
                  : "border-line bg-panel hover:border-line-strong",
              )}
            >
              <span className="text-sm font-medium">{mode.label}</span>
              <span className="mt-0.5 block text-[0.8125rem] text-muted">{mode.help}</span>
            </button>
          ))}
        </div>

        {p.mode !== "standard" ? (
          <Field
            label="Happens at"
            hint="The countdown is computed in the visitor's browser, so a cached page still shows the right number."
          >
            <Input
              type="datetime-local"
              className="tnum"
              value={p.eventAt ? p.eventAt.slice(0, 16) : ""}
              onChange={(e) =>
                void ops.updateProfileFields({
                  eventAt: e.target.value ? new Date(e.target.value).toISOString() : undefined,
                })
              }
            />
          </Field>
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-[0.9375rem] font-medium">Look</h2>
        <div className="flex gap-2">
          {PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => void ops.updateProfileFields({ theme: { preset } })}
              className={cx(
                "flex-1 rounded-desk border px-3 py-2.5 text-left text-sm capitalize transition-colors",
                p.theme.preset === preset ? "border-ink" : "border-line hover:border-line-strong",
              )}
            >
              {preset}
            </button>
          ))}
        </div>

        <div className="flex gap-2">
          <Field label="Accent">
            <Input
              type="color"
              className="h-9 w-16 p-1"
              value={p.theme.accent || "#141a22"}
              onChange={(e) => void ops.updateProfileFields({ theme: { accent: e.target.value } })}
            />
          </Field>
          <Field label="Corners">
            <Select
              value={p.theme.cornerStyle}
              onChange={(e) =>
                void ops.updateProfileFields({
                  theme: { cornerStyle: e.target.value as Theme["cornerStyle"] },
                })
              }
            >
              <option value="pill">Round</option>
              <option value="soft">Soft</option>
              <option value="square">Square</option>
            </Select>
          </Field>
          <Field label="Typeface">
            <Select
              value={p.theme.typeface}
              onChange={(e) =>
                void ops.updateProfileFields({
                  theme: { typeface: e.target.value as Theme["typeface"] },
                })
              }
            >
              <option value="system">System</option>
              <option value="grotesque">Grotesque</option>
              <option value="serif">Serif</option>
            </Select>
          </Field>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-[0.9375rem] font-medium">For agents</h2>
        <p className="text-[0.8125rem] text-muted">
          Anything reading your page as data gets a stable answer here — no geo, no
          device, no time rules applied.
        </p>
        <div className="flex items-center gap-2 rounded-desk bg-sunk px-3 py-2.5">
          <code className="flex-1 truncate font-mono text-[0.75rem]">
            {`/${p.handle}/identity.json`}
          </code>
          <a
            href={`/${p.handle}/identity.json`}
            target="_blank"
            rel="noreferrer"
            className="text-[0.8125rem] text-muted hover:text-ink"
          >
            Open
          </a>
        </div>
      </section>
    </div>
  );
}

function HandleSection() {
  const { state, ops } = useProfile();
  const p = state.profile;
  const [handle, setHandle] = useState(p.handle);
  const [check, setCheck] = useState<{ available: boolean; reason?: string } | null>(null);

  const problem = handle.trim().toLowerCase() === p.handle ? null : handleProblem(handle);

  useEffect(() => {
    const cleaned = handle.trim().toLowerCase();
    if (!cleaned || cleaned === p.handle || handleProblem(cleaned)) {
      setCheck(null);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        setCheck(await api.checkHandle(cleaned));
      } catch {
        setCheck(null);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [handle, p.handle]);

  const reasons: Record<string, string> = {
    taken: "Someone has this one.",
    reserved: "This one is reserved.",
    tombstoned:
      "Recently released. It stays held for 90 days so old links don't land on a stranger's page.",
  };

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[0.9375rem] font-medium">Handle</h2>
      <Field
        label=""
        hint="Changing it holds the old one for 90 days, so links already out in the world keep working."
        error={problem ?? (check && !check.available ? reasons[check.reason ?? ""] : undefined)}
      >
        <div className="flex items-center gap-2">
          <span className="text-[0.8125rem] text-muted">/</span>
          <Input
            value={handle}
            onChange={(e) => setHandle(e.target.value.replace(/[^a-z0-9._-]/gi, "").toLowerCase())}
          />
          {check?.available ? <Chip tone="live">free</Chip> : null}
        </div>
      </Field>
      <div>
        <Button
          onClick={() => void ops.claimHandle(handle.trim().toLowerCase())}
          disabled={Boolean(problem) || handle.trim().toLowerCase() === p.handle || !check?.available}
        >
          Claim it
        </Button>
      </div>
    </section>
  );
}
