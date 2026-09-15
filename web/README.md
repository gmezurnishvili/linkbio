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

## Running it with the backend

Nothing here needs AWS. Two processes, two terminals.

```sh
# terminal 1 — the Hono server, in-memory
cd ../api && DB_DRIVER=memory PORT=8787 npm run dev

# terminal 2 — this app
cd web && cp .env.example .env.local && npm install && npm run dev
```

`.env.local` only needs `API_ORIGIN=http://localhost:8787`. The browser never
talks to the backend directly except for the click beacon, so there is no CORS
to configure — everything else goes through `/api/proxy` on port 3000. The
beacon endpoint does get hit cross-origin, by `sendBeacon` with a `text/plain`
body: that is a simple request, so no preflight, but it must accept a POST with
no `Authorization` header.

### Before the real backend can drive this

Four things the frontend assumes:

1. `POST /v1/public/:handle/resolve` and `POST /v1/profiles/:id/preview`, both
   returning `Resolution` — blocks, `sMaxAge`, `varyOn`, `trace`, `warnings`.
2. `GET /v1/me` returning the signed-in user and their profiles.
3. Every write accepts `If-Match: <version>`, returns 409 when stale, and
   answers `{ data, version, cacheDimensions }` on success.
4. `POST /v1/auth/token` and `/v1/auth/refresh` returning
   `{ accessToken, refreshToken, expiresIn }`. Local HS256 is fine for dev.

### Running against the mock instead

`dev/mock-api.mjs` implements all of the above in memory, with one seeded
profile at `/giorgi` carrying a country rule, an iOS rewrite, and a late-night
window that crosses both midnight and a DST fall-back.

```sh
npm run dev:mock      # mock on 8787, Next on 3000
```

Sign in at `/login` with any email and password. The mock's rule evaluation is
a stand-in, not a port of the real one — notably it finds `sMaxAge` by scanning
forward a minute at a time, and does no DST gap or ambiguity detection. Where
the two disagree, the real evaluator is right.

### Probing it

Visitor context comes entirely from request headers, so curl can be any visitor
without a VPN, a device lab, or waiting until Saturday night:

```sh
npm run probe                      # the matrix below
dev/probe.sh giorgi https://…      # or against a deployed origin
```

```
no context            200  s-maxage=3600  Presave -> open.spotify.com  Merch -> shop.example.com
US · iPhone           200  s-maxage=3600  feed:Tour dates  Presave -> music.apple.com  Merch -> …
US · Android          200  s-maxage=3600  feed:Tour dates  Presave -> open.spotify.com  Merch -> …
DE · desktop          200  s-maxage=3600  Presave -> open.spotify.com  Merch -> shop.example.com
```

Three things that row set is checking: the country rule adds the tour feed for
US and CA only, the OS rule rewrites the presave destination for iOS without
changing the stored URL, and `vary` lists only the dimensions the rules
actually read.

Nothing caches locally, so this shows what CloudFront would be *told*, not what
it would do. To watch `s-maxage` change as a time window opens, move the
`datetime-local` field in the simulator — it sends an injected instant and the
trace prints the boundary. To exercise the real cache, deploy, or point a
caching proxy at port 3000.

### Checks worth running by hand

```sh
# no session -> 401, session -> proxied
curl -i localhost:3000/api/proxy/v1/me
curl -b 'lc_at=dev.fake' localhost:3000/api/proxy/v1/me

# stale If-Match -> 409, which is what raises the conflict banner
curl -X PATCH -b 'lc_at=dev.fake' -H 'if-match: 1' \
  -H 'content-type: application/json' -d '{"displayName":"X"}' \
  localhost:3000/api/proxy/v1/profiles/p_1
```

In the dashboard, the conflict path is worth seeing once: open the editor in two
tabs, edit a block in one, then drag a block in the other. The second tab stops
accepting writes and offers to reload rather than overwriting.

## Registering a user and seeing the page

In the browser, with the mock or a backend that supports it:

1. `/signup` — email and password. The server action posts to
   `/v1/auth/register`, writes the cookies, and sends you to onboarding.
2. `/app/new` — pick a handle. Availability is checked as you type;
   the profile and the claim happen in one transaction server-side.
3. `/app/:id` — add a block or two, then **Publish**.
4. `/:handle` — the public page. Or click "View live" in the header.

Publishing matters at step 3: a page with `publishedVersion: null` is a draft.
The mock resolves live data regardless, so a brand-new page renders immediately
there; decide what the real backend should do with an unpublished handle —
404 is the defensible answer.

To check the same flow without a browser:

```sh
dev/register-flow.sh                      # random email and handle
dev/register-flow.sh me@studio.com giorgi2
```

```
registering someone+1789502585@studio.com
session:      {"userId":"u_2e9eff","email":"…","profiles":[]}
handle check: {"available":true}
created:      p_1eacc8 at /newpage2585
claim again:  409 (409 means the claim is transactional)
added a link

public page at http://localhost:3000/newpage2585:
  name: Test page
  block-label: My album
  block-meta: example.com
```

Registration posts straight to the API because it runs in a server action
before any cookie exists. Everything after it goes through `/api/proxy`, the
way the browser does.

### Two more endpoints this needs

On top of the four listed above:

```
POST /v1/auth/register   { email, password } -> tokens, 409 if email taken
POST /v1/profiles        { handle, displayName } -> Profile, 409 if handle taken
```

The profile creation and the handle claim have to be one transaction. Two calls
would leave a profile with no handle whenever the second one lost a race, and
the frontend has no sensible way to recover from that state.

### Signing in as the seeded account

The mock ships one profile at `/giorgi` owned by `you@studio.com`. Sign in at
`/login` with that email and any password to edit it — it has a country rule, an
iOS rewrite, and a late-night window already set up, so the simulator has
something to show. Registering a new account leaves it in place: profiles are
scoped by owner, so `giorgi` still reads as taken.
