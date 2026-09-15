# Frontend

Two surfaces in one Next.js app, with opposite requirements.

| | Public profile | Dashboard |
|---|---|---|
| Route | `/:handle` | `/app/*` |
| Rendering | HTML string from a route handler | React, App Router |
| Client JS | 1.1 KB gzipped, inline, no framework | normal bundle |
| Caching | `s-maxage` from the rule evaluator, per request | `private, no-store` |
| Auth | none | httpOnly cookies via `/api/proxy` |

## Why the public page isn't a React page

Two structural reasons, both inherited from the backend.

**The TTL is a per-request value.** The evaluator computes the earliest instant
any decision on the page could change, and `s-maxage` has to equal exactly
that. A Next.js page component has no access to the response headers, so the
TTL would have to be a static guess. A route handler sets it precisely, and
because `renderProfile` and `cacheControlFor` are called side by side in
`app/[handle]/route.ts`, the HTML and the TTL cannot disagree.

**It is in the LCP path for every visitor a creator ever gets.** There is no
interactive state on the page, so a client framework would be paying hydration
cost for three event listeners. Measured on the smoke-test fixture: 8 KB of
HTML, 3.2 KB gzipped over the wire, zero requests to `_next/static`.

The dashboard is a conventional React app. Nothing about the public renderer is
a house style — it is a response to those two constraints.

## The three inline scripts

`lib/site/runtime.ts` is the only JavaScript a visitor downloads. Each of the
three jobs is client-side because it cannot be done on the server without
breaking the cache:

1. **In-app browser escape.** Depends on the user-agent. UA is not in the cache
   key, and adding it would fragment every cached page by browser build string.
   Detected after paint, so the banner costs nothing until it applies.
2. **Click beacons.** `sendBeacon` on `pointerdown`, so navigation never waits
   on the network. Suppressed when `data-preview` is set, because counting a
   creator testing their own page would poison the bandit that orders it.
3. **Countdown.** Computed in the browser from a target instant in the markup,
   never from a pre-rendered duration — the HTML is cached, and "4h 12m" ages
   badly.

## What the backend still needs

Two endpoints this app calls that weren't in the original API:

```
POST /v1/public/:handle/resolve   { VisitorContext } -> Resolution
POST /v1/profiles/:id/preview     { VisitorContext } -> Resolution (draft, with trace)
```

`Resolution` carries the resolved blocks, `sMaxAge`, `varyOn`, the decision
`trace`, and any evaluator `warnings`. The shape is in `lib/api/types.ts`.

Every write is expected to take `If-Match: <version>` and return
`{ data, version, cacheDimensions }`. The client treats version and mask as
server-owned; see below.

## Contracts worth not breaking

**Version and mask are server-owned.** Every mutation sends the profile version
as `If-Match`, and every response carries the new version *and* the new cache
mask. A block edit bumps the version server-side, so a client that kept writing
against a stale one would be writing against a mask that no longer describes
the page — which fails silently rather than loudly. On 409 the store sets a
conflict flag, blocks all further writes, and asks the creator to reload. It
does not retry.

**Ranks come from the server.** Reorder posts `{ afterId, beforeId }` rather
than a key, so key generation and rebalancing live in one place.
`lib/rank.ts` mints an optimistic key so a dragged row stays sorted during the
round trip; it is discarded the moment the server answers.

**Mask derivation stays a correctness gate.** `profile.cacheDimensions` from the
server is the authoritative value and is what the editor displays.
`deriveCacheDimensions` in `lib/rules/language.ts` exists only to warn that an
unsaved edit will change it.

**The DST check here is advisory.** `lib/rules/dst.ts` finds transitions by
bisecting month boundaries with `Intl` offsets and flags windows that overlap
one, so typing `02:15` warns immediately instead of after a save. The backend
evaluator — which probes wall time from both sides of the day, because a
single-sided probe silently misses fall-back ambiguity — remains the authority,
and its saved warnings render alongside.

**Validation is the server's schema.** `lib/rules/schema.ts` mirrors the
backend's Zod objects. Move them into a shared package; a copy that drifts is
worse than no client validation, because the form will accept input the server
rejects.

## Swapping in the typed client

`lib/api/client.ts` is hand-written so this app builds standalone. In a shared
workspace, delete the route shapes and use Hono's RPC client instead:

```ts
import { hc } from "hono/client";
import type { AppType } from "@linkctx/api";
export const api = hc<AppType>(process.env.NEXT_PUBLIC_API_BASE!);
```

The domain types stay — the rule builder renders against them.

## Auth

Both tokens live in httpOnly cookies; `/api/proxy/*` attaches the access token
server-side and refreshes once on expiry. The usual advice is "access token in
memory, refresh in a cookie", which is fine when an app owns its whole origin.
This one does not: the same apex domain serves creator-authored pages, so an
XSS anywhere in that surface could read an in-memory token out of a dashboard
tab. Keeping both out of JS costs one hop through the Next Lambda, and the
dashboard is uncached anyway.

## Known rough edges

- **Next appends its own `Vary`** (`rsc, next-router-state-tree, …`) to route
  handler responses, so the public page ships two `Vary` headers. CloudFront
  builds its key from the KeyValueStore mask and ignores this, but an
  intermediary proxy would fragment on `rsc`. Strip it in an origin-response
  function, or accept it.
- **CSP uses `'unsafe-inline'`** for the one style and one script block. Both
  are ours, not creator input, but the hashes change per theme, so a nonce
  would defeat edge caching. Hashing the literal blocks at build time is the
  version to move to.
- **`estimateVariants`** counts each named value plus a fallthrough bucket,
  which is an upper bound, not a measurement. Once real traffic exists, replace
  it with observed cache-key cardinality.
- **No analytics.** Deliberately out of scope for this pass. When it lands, the
  top line should read from the DynamoDB counters and anything Athena-backed
  should sit behind an explicit "run report" with polling — a dashboard that
  looks real-time and takes nine seconds to paint is worse than one that says
  what it is doing.
- **Dark mode** is implemented for the public page themes but not for the
  dashboard.

## Running it

```sh
cp .env.example .env.local     # point API_ORIGIN at the Hono server
npm install
npm run dev
npm run typecheck
npm test                        # 28 tests, no network, no AWS
```

The tests cover the pure logic that is easy to get wrong and hard to notice:
fractional rank splitting at a tight seam, DST gap and ambiguity detection
against fixed 2027 transitions, `s-maxage` clamping and flooring, mask
derivation, HTML escaping, and handle shape.
