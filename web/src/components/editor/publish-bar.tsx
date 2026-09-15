"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button, Chip, cx } from "@/components/ui/primitives";
import { useProfile } from "./profile-store";

export function PublishBar() {
  const { state, ops } = useProfile();
  const p = state.profile;
  const pathname = usePathname();
  /**
   * Three states, not two.
   *
   * `publishedVersion === null` is a page that has never been live, and the
   * public routes 404 for it — a draft nobody has chosen to show is not a page
   * that happens to be empty. Collapsing it into "unpublished changes" told a
   * creator their page was up when nothing of it was reachable.
   *
   * `current` reads false immediately after a publish, and that is a backend
   * bug rather than a display one: `POST /:id/publish` writes
   * `publishedVersion: p.version` through `updateProfile`, which bumps the
   * version as part of the same write — so the published version is always
   * exactly one behind and this can never settle on "Published". The fix is in
   * api/src/routes/profiles.ts, not here; guessing at +1 on this side would
   * make a real pending edit invisible.
   */
  const live = p.publishedVersion !== null;
  const current = p.publishedVersion === p.version;
  const publishing = state.pending.has("publish");

  const tabs = [
    { href: `/app/${p.id}`, label: "Page" },
    { href: `/app/${p.id}/rules`, label: "Rules" },
    { href: `/app/${p.id}/settings`, label: "Settings" },
  ];

  return (
    <div className="sticky top-0 z-30 border-b border-line bg-paper/95 backdrop-blur">
      <div className="mx-auto flex max-w-[64rem] items-center gap-4 px-5 py-3">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <h1 className="truncate text-[0.9375rem] font-medium">{p.handle}</h1>
            <span className="tnum font-mono text-[0.6875rem] text-faint">v{p.version}</span>
            {!live ? (
              <Chip tone="alert">draft — not live yet</Chip>
            ) : current ? (
              <Chip tone="live">published</Chip>
            ) : (
              <Chip tone="clock">unpublished changes</Chip>
            )}
          </div>
          <p className="truncate text-[0.75rem] text-muted">{p.displayName}</p>
        </div>

        <nav className="ml-auto flex items-center gap-1">
          {tabs.map((tab) => {
            const active = pathname === tab.href;
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={cx(
                  "rounded-desk px-2.5 py-1.5 text-[0.8125rem] transition-colors",
                  active ? "bg-sunk text-ink" : "text-muted hover:text-ink",
                )}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>

        <div className="flex items-center gap-2">
          {live ? (
            <a
              href={`/${p.handle}`}
              target="_blank"
              rel="noreferrer"
              className="text-[0.8125rem] text-muted hover:text-ink"
            >
              View live
            </a>
          ) : (
            // Linking to a page that 404s is worse than not offering the link.
            <span className="text-[0.8125rem] text-faint">Nothing live yet</span>
          )}
          <Button
            variant="primary"
            onClick={() => void ops.publish()}
            disabled={current || publishing || state.conflict}
          >
            {publishing ? "Publishing" : current ? "Published" : !live ? "Publish it" : "Publish"}
          </Button>
        </div>
      </div>

      {!live ? (
        <div className="border-t border-line bg-sunk px-5 py-2">
          <p className="mx-auto max-w-[64rem] text-[0.8125rem] text-muted">
            <span className="font-mono">/{p.handle}</span> answers 404 until you publish.
            Editing and previewing work on the draft; visitors see nothing.
          </p>
        </div>
      ) : null}

      {state.conflict ? (
        <div className="border-t border-alert/20 bg-alert-wash px-5 py-2.5">
          <div className="mx-auto flex max-w-[64rem] items-center gap-3 text-[0.8125rem] text-alert">
            <span>
              This page changed somewhere else — another tab, or someone else on the
              account. Editing stopped so nothing overwrites it.
            </span>
            <Button size="sm" className="ml-auto" onClick={() => void ops.reload()}>
              Load the current version
            </Button>
          </div>
        </div>
      ) : null}

      {state.error ? (
        <div className="border-t border-line bg-sunk px-5 py-2">
          <div className="mx-auto flex max-w-[64rem] items-center gap-3 text-[0.8125rem]">
            <span>{state.error}</span>
            <Button variant="quiet" size="sm" className="ml-auto" onClick={ops.dismissError}>
              Dismiss
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
