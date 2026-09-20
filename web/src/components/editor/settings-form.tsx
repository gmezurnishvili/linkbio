"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api/client";
import type { PageMode, Theme } from "@/lib/api/types";
import { fromLocalInput, toLocalInput } from "@/lib/datetime";
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
  const [avatarUrl, setAvatarUrl] = useState(p.avatarUrl ?? "");

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

        {/* A URL rather than an upload. There is no object store in this stack
            and nothing that issues a signed PUT, so an upload control would be
            a button that cannot work; the renderer has been ready for the
            field since it was written, and every page has been showing an
            empty grey circle because nothing ever set it.

            The backend validates it as a SafeUrl, so a javascript: or data:
            value is refused there rather than trusted from here. */}
        <Field
          label="Avatar"
          hint="A direct link to an image. It becomes the page's picture and its social card."
          error={avatarProblem(avatarUrl) ?? undefined}
        >
          <Input
            value={avatarUrl}
            placeholder="https://example.com/me.jpg"
            onChange={(e) => setAvatarUrl(e.target.value)}
          />
        </Field>

        {avatarUrl && !avatarProblem(avatarUrl) ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={avatarUrl}
            alt=""
            className="h-14 w-14 rounded-full border border-line object-cover"
          />
        ) : null}

        <div>
          <Button
            variant="primary"
            onClick={() =>
              void ops.updateProfileFields({
                displayName,
                bio,
                // Empty clears it. The backend takes an absent key as "leave it
                // alone", so sending "" is the only way to remove one.
                avatarUrl: avatarUrl.trim(),
              })
            }
            disabled={
              Boolean(avatarProblem(avatarUrl)) ||
              (displayName === p.displayName &&
                bio === p.bio &&
                avatarUrl.trim() === (p.avatarUrl ?? ""))
            }
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
              value={p.eventAt ? toLocalInput(new Date(p.eventAt)) : ""}
              onChange={(e) =>
                void ops.updateProfileFields({ eventAt: fromLocalInput(e.target.value) })
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

      <DangerZone />
    </div>
  );
}

/**
 * The two irreversible things, kept together and kept last.
 *
 * Both existed on the backend with nothing in front of them: `DELETE
 * /v1/profiles/:id` was not even in the proxy's allowlist, so the browser got a
 * 404 from our own proxy, and `revokeRefreshTokens` had no route at all.
 */
function DangerZone() {
  const { state, ops } = useProfile();
  const p = state.profile;
  const [confirm, setConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);

  const remove = async () => {
    setDeleting(true);
    // Navigate rather than re-render: the profile this whole subtree is built
    // around no longer exists, and /app will send us to whatever is left.
    if (await ops.deleteProfile()) window.location.href = "/app";
    else setDeleting(false);
  };

  return (
    <section className="flex flex-col gap-3 border-t border-line pt-8">
      <h2 className="text-[0.9375rem] font-medium text-alert">Irreversible</h2>

      {p.publishedVersion !== null ? (
        <div className="flex flex-col gap-2 rounded-desk border border-line px-3 py-3">
          <p className="text-sm font-medium">Take the page down</p>
          <p className="text-[0.8125rem] text-muted">
            <span className="font-mono">/{p.handle}</span> goes back to answering 404. Nothing
            is lost — the draft stays exactly as it is, and publishing again puts it back.
          </p>
          <div>
            <Button
              size="sm"
              className="mt-1"
              disabled={state.pending.has("publish") || state.conflict}
              onClick={() => void ops.unpublish()}
            >
              Unpublish
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-2 rounded-desk border border-line px-3 py-3">
        <p className="text-sm font-medium">Sign out everywhere</p>
        <p className="text-[0.8125rem] text-muted">
          Ends every session on this account, on every device. Use it if you think someone
          else has one.
        </p>
        <form action="/logout?all=1" method="post">
          <Button type="submit" size="sm" className="mt-1">
            Sign out everywhere
          </Button>
        </form>
      </div>

      <div className="flex flex-col gap-2 rounded-desk border border-alert/25 px-3 py-3">
        <p className="text-sm font-medium">Delete this page</p>
        <p className="text-[0.8125rem] text-muted">
          The page, its blocks and its rules go, and{" "}
          <span className="font-mono">/{p.handle}</span> stops answering. The handle is held
          for 90 days so old links don&rsquo;t land on a stranger&rsquo;s page, then anyone
          can take it.
        </p>
        <Field
          label={`Type ${p.handle} to confirm`}
          hint="A page is a lot of work to lose to a misclick."
        >
          <Input
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="off"
          />
        </Field>
        <div>
          <Button
            variant="danger"
            size="sm"
            disabled={confirm.trim().toLowerCase() !== p.handle || deleting || state.conflict}
            onClick={() => void remove()}
          >
            {deleting ? "Deleting" : "Delete this page"}
          </Button>
        </div>
      </div>
    </section>
  );
}

/**
 * Enough to catch a paste that will be refused, said here rather than by a 400.
 * The backend's `SafeUrl` is the authority; this only spares a round trip.
 */
function avatarProblem(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return "That isn't a full URL. It needs to start with https://";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return "Only http and https links work here.";
  }
  return null;
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
        hint="Changing it holds the old one for 90 days, so links already out in the world keep working."
        error={problem ?? (check && !check.available ? reasons[check.reason ?? ""] : undefined)}
      >
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="text-[0.8125rem] text-muted">
            /
          </span>
          <Input
            aria-label="Handle"
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
