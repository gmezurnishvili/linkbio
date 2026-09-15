"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button, Chip, cx } from "@/components/ui/primitives";
import { useProfile } from "./profile-store";

export function PublishBar() {
  const { state, ops } = useProfile();
  const p = state.profile;
  const pathname = usePathname();
  const published = p.publishedVersion === p.version;
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
            {published ? (
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
          <a
            href={`/${p.handle}`}
            target="_blank"
            rel="noreferrer"
            className="text-[0.8125rem] text-muted hover:text-ink"
          >
            View live
          </a>
          <Button
            variant="primary"
            onClick={() => void ops.publish()}
            disabled={published || publishing || state.conflict}
          >
            {publishing ? "Publishing" : published ? "Published" : "Publish"}
          </Button>
        </div>
      </div>

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
