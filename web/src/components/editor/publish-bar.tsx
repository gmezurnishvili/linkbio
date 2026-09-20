"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Button, Chip, cx } from "@/components/ui/primitives";
import { useProfile } from "./profile-store";

/**
 * `pages` is every page on the account, so the bar can switch between them.
 * The backend has always modelled many profiles per user; until the routing
 * let anyone reach `/app/new` twice there was never more than one to list.
 */
export function PublishBar({ pages = [] }: { pages?: { id: string; handle: string }[] }) {
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
   * `current` is an equality against the version the server recorded as
   * published. It used to be permanently false — `POST /:id/publish` wrote
   * `publishedVersion: p.version` through an `updateProfile` that bumps the
   * version in the same write, leaving it one behind forever. That is fixed on
   * the backend, where it belongs; guessing at +1 on this side would have made
   * a real pending edit invisible.
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
            {/* Shown even with one page, because it is also the only route to
                a second one — hiding it until there are two is the same
                bootstrapping problem the /app/new redirect used to have. */}
            {pages.length > 0 ? (
              <PageSwitcher pages={pages} current={p.id} />
            ) : (
              <h1 className="truncate text-[0.9375rem] font-medium">{p.handle}</h1>
            )}
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

          {/* A plain form, not a fetch. The refresh token it revokes is
              httpOnly, so no script on this origin can read it — the route
              handler is the only place that holds both the token and the
              cookie jar. POST rather than a link, so a cross-site image tag
              cannot sign someone out. */}
          <form action="/logout" method="post">
            <Button type="submit" variant="quiet" size="sm">
              Sign out
            </Button>
          </form>
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

/**
 * A select, not a menu.
 *
 * It is a jump between documents, which is exactly what a native select does
 * on every platform without needing focus trapping, keyboard handling or a
 * portal — and on a phone it becomes the system picker.
 */
function PageSwitcher({
  pages,
  current,
}: {
  pages: { id: string; handle: string }[];
  current: string;
}) {
  const router = useRouter();
  return (
    <select
      aria-label="Which page"
      value={current}
      onChange={(e) => {
        if (e.target.value === "new") router.push("/app/new");
        else router.push(`/app/${e.target.value}`);
      }}
      className="max-w-[12rem] truncate rounded-desk border border-transparent bg-transparent py-0.5 pl-0 pr-5 text-[0.9375rem] font-medium outline-none hover:border-line focus:border-geo"
    >
      {pages.map((page) => (
        <option key={page.id} value={page.id}>
          {page.handle}
        </option>
      ))}
      <option value="new">+ New page</option>
    </select>
  );
}
