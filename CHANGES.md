# linkbio — feeds, hot links, and the block-kind vocabulary

Three of the four gaps from the audit. Analytics is deliberately left out of the
MVP; the backend still records events, there is still no dashboard reading them.

**Gates:** api `npm test` 397 passing (was 331), `npm run typecheck` clean,
`npx cdk synth` succeeds, both Lambda bundles build. web `npx vitest run` 106
passing (was 86), `npx tsc --noEmit` clean, `next build` passes. The full
header → embed → feed → link page was rendered against the real backend, not
the mock.

---

## 1. Feed blocks now have something behind them

`dueForRefresh`, the GSI2 index, `feed.ttlSeconds` and the `items` field have
existed since the schema was written. Nothing ever walked them, so every feed
block a creator added rendered as nothing at all — `feedBlock` returns an empty
string for zero items, which is why it looked like the block had failed to save
rather than like a feature that was not built.

**`src/feeds/xml.ts`** — RSS 2.0 and Atom, by hand, no dependency. Tolerance is
a deliberate property rather than whatever a library happens to do this major
version: CDATA is text, unknown entities are left verbatim rather than replaced
with a placeholder that would corrupt a title containing `&something;`, a
mismatched close tag unwinds to the matching open if there is one, an
unterminated tag ends the document instead of throwing. A feed that is 90%
well-formed yields 90% of its items.

**`src/feeds/fetch.ts`** — the only route to the network. `SafeUrl` validates
what a creator types, which is necessary and not sufficient: `http://evil.test/`
passes and then 302s to the instance metadata service. So redirects are followed
by hand and every hop is re-validated, the body is read through a byte cap
rather than buffered and sliced, and adapters that talk to a known API pin the
host they think they are calling.

**`src/feeds/adapters.ts`** — all five sources. YouTube goes through its
per-channel Atom feed, which needs no key and has no quota; the cost is that an
`@handle` cannot be resolved without the Data API or a page scrape, so that case
returns the fix rather than an empty block. GitHub reads releases for
`owner/repo` and recently-pushed repos for a username. Spotify and Twitch use
client-credentials tokens cached per process.

Two failure kinds are distinguished, because they need opposite handling.
`FeedRefUnusable` is the creator's ref being wrong — retrying hourly forever
burns quota and will never succeed, so it backs off hard and the message reaches
the editor. `FeedNotConfigured` is a missing operator credential, which the
creator can do nothing about; that one does not touch their failure count and
does not put an error on their block blaming them for it.

**Backoff.** I added `feedAttemptedAt`, `feedFailures` and `feedError`, and
moved the due-time calculation into `nextFeedDueAt` in `domain/types.ts` so both
repositories schedule identically. The interval doubles per consecutive failure
to a 16× ceiling. Keying the index off `feedRefreshedAt` alone — which is what
it did — leaves a broken feed permanently due and retried on every single run.

**`src/refresher.ts`** — its own scheduled Lambda, not a route on the API. It
waits on five third parties so it needs six times the API's timeout, and a feed
that hangs must not be able to eat the concurrency a creator's dashboard is
using. Idempotent by construction, so EventBridge firing twice duplicates a
fetch and corrupts nothing.

Feeds are pulled on a schedule and never on the render path. A cache miss is
already the slowest thing a visitor can do; putting YouTube in that path turns a
third party's outage into a creator's page timing out. The cost is that a new
feed block is empty for a few minutes, so the editor now says so.

Two conformance bugs fell out of this. `MemoryRepo.dueForRefresh` ignored the
shard argument, so a refresher walking ten shards processed every block ten
times against memory and once against DynamoDB — and only one of those was under
test. And the document client is configured with `removeUndefinedValues`, so
clearing `feedError` deletes the attribute in production while memory kept the
key with an undefined value; `MemoryRepo.putBlock` now drops them the same way.

## 2. The `hot:` key path has a writer

`edge/normalize.js` has always read `hot:<handle>/<slug>` to answer a static
redirect without touching the origin. Nothing wrote it, so the branch was
unreachable.

`publish.ts` is now `publishRouting`, deriving both key families and sending
puts and deletes in one `UpdateKeys` call — so the edge never observes a state
where the mask has moved to a renamed handle while the old hot links still
answer under the old one.

A block qualifies only while it has no rules, no activity window, an http(s)
target, and sits on a published profile. Each of those is load-bearing: the edge
serves a constant where the origin computes a variable, which is the same class
of bug as the old positional `x-ctx` decoding and cached just as hard. A draft
profile gets no entries at all, since `/r/` 404s for one and a hot link would
publish a page its owner never published.

Stale keys are **derived rather than remembered**. Storing the last published
key list on the profile would mean a second write after every mutation, and that
write bumps the version the client is holding as its `If-Match`. Deriving costs
a handful of idempotent deletes and keeps the version meaning one thing. A
deleted block's id is passed in explicitly, because it is gone from `listBlocks`
by the time the publish runs.

**This caught a bug that predates hot links.** A handle rename left `mask:<old>`
behind entirely — the next creator to claim that handle inherited a cache-key
mask derived from someone else's rules. Neither handle-claim route republished
at all. `profiles.patch` did not either, which is worse than it sounds: the mask
value carries the profile version, so editing a bio left the edge announcing a
stale version, the origin read that as a stale key, and the page silently
stopped caching.

I also changed the wire format to `<status>|<url>`, split on the first
separator. A URL may legally contain `|` in its query and the old split
truncated exactly those targets. The edge now also skips the lookup entirely
when the slug is empty, which was a KeyValueStore read on every page view for a
key the API never writes.

**One trade-off to be aware of:** a redirect answered at the edge never reaches
`/r/`, so it is never counted server-side. The page's own beacon still fires; a
visitor with JavaScript off is invisible. `HOT_LINKS=off` puts everything back
on the origin path. Given analytics is out of the MVP this seemed like the right
default, but it is a one-line change if you disagree.

## 3. Block kinds are one vocabulary again

The backend's `BLOCK_KINDS` is `link | header | embed | feed`. The renderer
switched on `feed`, `text`, `gate`, then fell through to the link renderer — so
`header` rendered as a clickable card with no destination and an empty hint
line, `embed` rendered as a plain link, and the `text` and `gate` arms were
unreachable. The client had been papering over the first of those by translating
`header` to `text` on the way through.

- `header` is now an `<h2 class="section">`. A section divider in a list of
  links is the reason the kind exists, and a screen-reader user navigating by
  heading is the reason it is a heading rather than a styled paragraph.
- `embed` renders a player, from an allowlist: YouTube (via `-nocookie`),
  Spotify, SoundCloud, Vimeo, Apple Music. Anything unrecognised stays a link
  card, because losing the block entirely because the creator pasted a URL from
  a service with no player is worse.
- `text` and `gate` are gone, along with the `RenderedBlockKind` type that was
  wider than `BlockKind` — that widening is what let the dead arms sit there
  without the compiler saying anything.

The CSP is `default-src 'none'`, so `frame-src` matters. `renderProfileDocument`
returns the hosts it actually framed and the route handler names exactly those —
a page with one YouTube embed is not permitted to frame Spotify. The iframes are
deliberately **not** sandboxed: a cross-origin frame is already isolated, and
the attributes a player needs to work (`allow-scripts allow-same-origin`) are
precisely the pair that makes `sandbox` a no-op. The allowlist plus `frame-src`
is the control that holds. Embeds also carry no `data-block`, since a pointer
landing on an iframe is a play or a scrub, not a click-through.

**Editor.** Feed blocks were displaying their config read-only, so a feed could
be created but never corrected; embeds had no URL field at all, because the
destination input was gated on `kind === "link"`. Both are editable now, with
`lib/feeds.ts` giving per-source hints and a shape check on the ref — the
`@handle` case especially, which looks completely reasonable and would otherwise
fail minutes later on a block that had already saved. That file checks shape and
claims nothing about validity: the adapters are the authority, and a client copy
that drifts is worse than no client check, which is the lesson
`lib/rules/schema.ts` already has in its header.

**Also fixed:** `sameAs` in the JSON-LD was mapping `b.href`, which is
`/r/:handle/:id` — so every entry was a self-reference back into this site,
which is the opposite of what `sameAs` is for.

## Still not done

- Analytics, by your call. Backend records, nothing reads.
- The analytics UTC-day bucketing, which splits the day for a creator outside
  UTC±0. Waiting on the dashboard that would show it.
- `next build` was verified here with the Google Fonts import stubbed, because
  this sandbox has no egress to `fonts.googleapis.com`. Real fonts are restored
  in the diff and `tsc` is clean against them, but run a production build before
  you ship.
- Spotify's artist endpoint requires a `market` and has no global variant, so
  the track list is the US one for every visitor. A per-country list would need
  geo in the cache key for a block whose rules never asked for it.

---

# Previously — the audit fixes

All of it is in your working copy. Nothing is committed; `git status` shows 53
modified and 26 new files. `git diff` is the review.

**Gates:** api `npm test` 331 passing, `npm run typecheck` clean, `npx cdk synth`
succeeds. web `npx vitest run` 86 passing, `npx tsc --noEmit` clean. The full
signup → profile → block → rule → publish → public page flow verified against
the real backend, not the mock.

---

## Running it now

```bash
# terminal 1
cd api && npm install
DB_DRIVER=memory AUTH_SECRET=a-secret-of-at-least-32-bytes-long PORT=8787 npm run dev

# terminal 2
cd web && npm install && cp .env.example .env.local && npm run dev
```

`npm run dev:mock` still works — the mock now implements the same contract, so
the two are interchangeable. `dev/register-flow.sh` exercises the whole flow
without a browser against either.

`AUTH_SECRET` is required and must be at least 32 bytes. Config is parsed and
validated at load, so a wrong value stops the process instead of silently
becoming `NaN`.

---

## The five blockers

**`x-ctx` was encoded by name and decoded by position.** The edge emitted a
token only for masked dimensions; the origin destructured five fixed slots. A
device-only mask put the device token in the geo slot, so the rule never
matched — and the wrong answer went out with `s-maxage=3600` and was replayed to
everyone sharing that key. Now five fixed slots with `-` for uncovered
dimensions, which costs four bytes and changes cardinality not at all. The
origin's coverage check reads the dimensions the edge actually sent rather than
re-deriving them from the database, where they were complete by construction and
could only ever pass. `test/edge.test.ts` pins the round trip for all 32 masks.

Verified: a mobile viewer now gets the mobile destination, and the old encoding
degrades to `no-store` rather than caching a wrong answer.

**Stored XSS on the public page.** `esc()` is an HTML-entity escaper and was
used on every `href`; `z.string().url()` accepts `javascript:`; the CSP set
`script-src 'unsafe-inline'`, which is exactly what makes a `javascript:`
navigation execute. Public pages share an origin with the dashboard and `lc_at`
is a `path="/"` cookie, so script on a profile page could drive `/api/proxy`
with the user's authority. Fixed at all three layers: a `safeHref` scheme
allowlist at render (handling `java\nscript:` and control characters), scheme
validation at input, and per-request SHA-256 hashes computed from the exact
inline blocks instead of `'unsafe-inline'`.

**`DynamoRepo.recordEvents` could not succeed.** Nested `ADD` plus overlapping
document paths — rejected twice over — and the error handler rebuilt the same
expression and called itself, recursing until the Lambda timed out. Rewritten as
one row per day, one per (day, block) and one per block for all-time totals,
every counter a top-level `ADD`. That also keeps a busy profile off the 400 KB
item ceiling a single map of block ids would have hit. The `STAT#` rows
`getBlockTotals` reads are now actually written.

**The deployed stack had no auth configuration**, so `cdk deploy` produced a
control plane that answered 401 to everything. It now sets a generated
`AUTH_SECRET` from Secrets Manager. While wiring it up I found `infra/` had
never been typechecked (`aws-cdk-lib` was not a dependency) and there was no
`cdk.json` or app entrypoint, so `npx cdk deploy` had nothing to synthesize.
Both fixed; `cdk synth` succeeds.

**The 204 and 409 bugs in the editor.** A successful DELETE returned 204, the
client turned that into `undefined`, and the store treated a falsy result as
failure — rolling back a delete that had worked. And `"replace"` reset
`conflict: false`, so the rollback that follows a 409 cleared the lock the 409
had just set: the banner never appeared for profile edits. Both fixed, with the
failure signal moved out of band.

---

## The contract, closed

The frontend called nine endpoints that did not exist and disagreed on three
more; `grep -rni "if-match" api/src` returned nothing. Added to the backend:

```
POST /v1/auth/register | /token | /refresh      GET /v1/me
GET  /v1/handles/:handle                        POST /v1/public/:handle/resolve
POST /v1/profiles/:id/preview | /publish        POST /v1/profiles/:id/handle
```

Registration is scrypt with a constant-time dummy verify for unknown accounts.
Refresh tokens are stored hashed and rotate; a second use of a spent token is
treated as a leak and revokes every session for that user. That made the
frontend's refresh path a hazard — two requests arriving together after the
access cookie expired would both spend the same token and log the user out
everywhere — so `session.ts` now single-flights the exchange.

Every mutation takes `If-Match: <profile version>` and returns
`{ data, version, cacheDimensions }`. The version bump is a conditional write
that happens before anything else in the request, which serializes the whole
profile — that is what stops two concurrent block creates computing the same
rank. The two 409s are now distinguishable by `title`, so hitting the block cap
no longer says "this page changed somewhere else".

Rules moved to the backend's model as you chose: embedded per-block, replaced as
a whole set. `lib/rules/schema.ts` genuinely mirrors the backend now — it
previously shared no vocabulary with it at all, which is the exact failure its
own header comment warned about.

Publishing is real: `publishedVersion: null` is a draft and the public routes
404 for it.

---

## Also fixed

**Ranking was worse than the review said.** `rankBetween('0a','0b')` threw — any
insert between two blocks sharing a rank prefix was a 500, which is the ordinary
case once keys pass one digit. Rewritten in both implementations, with a
`RankExhausted` error the routes catch and turn into a list rebalance. There was
no rebalance path at all before, despite a client comment claiming one.

**The two repositories were not interchangeable**, though both the interface and
the README said so, in five ways: tombstones, all-time totals, event recording,
leaked `PK`/`SK`/GSI fields in every response, and the refresh index.
`test/conformance.test.ts` now runs one suite against both. One old test
asserted the opposite of production behaviour and has been corrected.

**Security:** CORS pinned to an env allowlist instead of reflecting any origin;
JWT verification requires `exp`, pins algorithms, and requires an audience when
an external issuer is configured; `DEV_JWT_SECRET` is rejected in production;
`/v1/events` is throttled, capped at four handles per batch, and drops block ids
that are not on the profile; `SafeUrl` now covers IPv6, v4-mapped IPv6, integer
and octal host forms, and CGNAT; the proxy has a path allowlist, an Origin check
and a body cap; cookies are `__Host-` prefixed over HTTPS; the dashboard has a
CSP, `nosniff` and HSTS; a WAF rate rule sits in front of the whole thing.

**Correctness:** publish was off by one so the editor could never show
"published"; `eventAt` shifted by the UTC offset on every save; the DST advisory
missed transitions crossing local midnight (Santiago and Havana emitted
nothing); `cacheControlFor` could emit `s-maxage=NaN`; `initialRanks` produced
duplicates above ~30 rows; `destinationHint` was being passed a path `new URL()`
throws on, so every block's destination line rendered empty; `varyHeader` had no
entries for the three dimensions the backend most often reports; the visitor
context never set `webview`, which made any profile with a webview rule
permanently uncacheable; click writes on the redirect path were dropped on
Lambda because `executionCtx` does not exist there.

**Design:** blocks mounted under the profiles router, so auth and ownership run
once per request instead of twice; repo errors mapped centrally instead of at
whichever call site remembered; `requestId` surfaced in error responses; mask
publish failures no longer swallowed; Origin Shield enabled, which the
architecture actually requires since every edge TTL expires in the same instant;
log retention, a DLQ and three alarms; the `Sheet` got focus management and the
drag got a visible overlay.

---

## Worth knowing

- **`npx cdk synth` caught a real deployment blocker.** OAC signs the origin
  request with SigV4 in the `Authorization` header, so a viewer's bearer token
  would be overwritten; CloudFront refuses to forward that header at all.
  `edge/auth-header.js` copies it to `x-authorization` and the origin reads that
  first. This is the conflict I flagged as "verify against a live deployment" —
  it was real.
- **`npm install` in `api/`** — I added `aws-cdk-lib`, `constructs` and `aws-cdk`
  as devDependencies so `infra/` is typechecked and deployable.
- **`.gitignore` gained `.next/`** — Next.js wrote that itself when I first ran
  the dev server. Harmless, but it is in your diff.
- **`next build` is unverified.** It fails in my sandbox fetching Google Fonts,
  which has no egress. `next dev` renders every route and `tsc` is clean, but run
  a production build before you ship.
- **Not done:** the analytics UTC-day bucketing, the `hot:` key path the edge
  reads and nothing writes, and `dueForRefresh` still has no consumer. All three
  are features rather than defects, and all three are noted in `linkbio-review.md`.
