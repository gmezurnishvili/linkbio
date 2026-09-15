# linkbio — what changed

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
