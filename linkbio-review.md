# linkbio — run guide and code review

Reviewed 15 Sep 2026. Backend (`api/`) and frontend (`web/`) were both booted and
exercised; every finding below was confirmed by reading or executing the code.

---

## Part 1 — Running it locally

### Prerequisites

- Node 22.6 or newer (the API runs TypeScript directly via `--experimental-strip-types`).
  You have v22.23.2 — fine.
- No AWS account, no Docker, no database.

### The catch you need to know first

**The frontend cannot run against the real backend.** The web app calls nine
endpoints the API does not implement, and disagrees with it on three more. You
have three usable configurations:

| Setup | Works? | Use it for |
|---|---|---|
| API alone | Yes | backend work, `curl`, the test suite |
| Web + `dev/mock-api.mjs` | Yes | all frontend work — this is the intended path |
| Web + real API | **No** | blocked until the gap in Part 3.1 is closed |

### A. Backend only

```bash
cd api
npm install
DB_DRIVER=memory DEV_JWT_SECRET=a-secret-at-least-32-bytes-long PORT=8787 npm run dev
```

Verify:

```bash
curl -s localhost:8787/health          # {"ok":true,"ts":...}
npm test                               # 66 pass
npm run typecheck                      # clean
```

`scripts/token.mjs` mints a dev JWT for the authenticated routes.

### B. Frontend against the mock — the one that actually works end to end

```bash
cd web
npm install
cp .env.example .env.local
npm run dev:mock        # mock API on 8787, Next on 3000
```

Then:

- `http://localhost:3000/login` — sign in with `you@studio.com` and any password
  to get the seeded profile, or any email for a fresh account.
- `http://localhost:3000/giorgi` — the seeded public page.
- `npm run probe` — header-driven visitor matrix (country, OS, referrer).
- `dev/register-flow.sh` — signup → handle claim → block → public page, no browser.
- `npm test` (28 pass), `npm run typecheck` (clean).

### C. Frontend against the real backend

```bash
# terminal 1
cd api && DB_DRIVER=memory DEV_JWT_SECRET=a-secret-at-least-32-bytes-long PORT=8787 npm run dev
# terminal 2
cd web && npm run dev
```

The app boots and `/login` renders, but nothing beyond that works. Measured:

```
POST localhost:8787/v1/auth/register  -> 404
GET  localhost:8787/v1/me             -> 404
GET  localhost:3000/giorgi            -> 404 (resolve endpoint missing)
GET  localhost:3000/app               -> 307 /login (correct)
```

### Windows note

`node_modules` in your working copy was installed on Windows, so the native
binaries are `@next/swc-win32-x64-msvc` and `@esbuild/win32-x64`. That is correct
for your machine. If you ever move the folder to WSL, a container or CI, delete
both `node_modules` directories and reinstall — Next will otherwise try to
download the Linux SWC binary at startup and crash if it has no network.

---

## Part 2 — What is good

Worth saying before the list of problems, because the parts that are done well
are done unusually well.

- **The rule engine and DST math are correct.** `api/src/rules/tz.ts` handles
  spring-forward gaps, fall-back ambiguity, 30-minute shifts (Lord Howe) and
  half-hour zones. The three-seed probe surfaces *both* occurrences on a
  fall-back date, which a single-sided probe misses. `nextBoundary` re-evaluates
  on both sides of each candidate, so a math error degrades to a short TTL rather
  than a wrong destination — that is the right failure direction.
- **The caching design is coherent.** Deriving a per-profile cache mask, folding
  only those dimensions into one `x-ctx` header, and computing `s-maxage` as the
  exact seconds to the next decision boundary is a genuinely good answer to
  personalisation-versus-CDN. The `maxTtl > MAX_S_MAXAGE` invariant is documented
  and holds.
- **The public page as a route handler, not a React page,** is correctly argued in
  `web/README.md`: a page component cannot set a per-request header, so HTML and
  TTL could disagree. 3.2 KB gzipped, zero `_next/static` requests.
- **httpOnly cookies + server-side proxy** is the right call given the apex domain
  also serves creator content.
- **Drag-and-drop is keyboard accessible** — `KeyboardSensor` with
  `sortableKeyboardCoordinates`, real `<button>` handles, `aria-label` on each.
- **The simulator's iframe is properly isolated** — `sandbox="allow-scripts
  allow-popups"` without `allow-same-origin`.
- **The READMEs are excellent** and honest about trade-offs. The "things that will
  bite you" section is the kind of documentation most projects never write.

---

## Part 3 — Blocking issues

### 3.1 Frontend and backend implement different APIs

Confirmed by request. Missing entirely:

```
GET  /v1/me
POST /v1/auth/register   POST /v1/auth/token   POST /v1/auth/refresh
POST /v1/public/:handle/resolve
POST /v1/profiles/:id/preview
POST /v1/profiles/:id/publish
GET  /v1/handles/:handle
POST/PATCH/DELETE /v1/profiles/:id/rules[/:ruleId]
```

Mismatched where both sides exist:

- `claimHandle` — web sends `POST /v1/profiles/:id/handle`, API registers `PUT`. 405.
- `createProfile` — web sends `{handle, displayName}`, API's `ProfileCreate`
  requires `title`. 400 on every signup.
- Envelope — web expects `{data, version, cacheDimensions}`, API returns the bare entity.
- Rules — web models them as profile-level with per-rule CRUD; API models them as
  per-block, whole-set replace. These are different data models, not different URLs.
- Beacon — `.env.example` points at `/v1/beacon`, API serves `/v1/events`.

**`grep -rni "if-match" api/src` returns nothing.** The frontend's entire
optimistic-concurrency design has no server counterpart.

### 3.2 `x-ctx` is encoded by name and decoded by position — context routing is silently wrong

`api/edge/normalize.js:72-90` pushes a token **only for dimensions in the mask**.
`api/src/auth.ts:113` destructures positionally:

```ts
const [geo, device, referrer, lang, webview] = body.split('.');
```

There are no placeholders, so any mask omitting an earlier dimension shifts every
later one. Executed:

```
mask='d'  edge emits 'v7|m'    -> {"geo":"m"}              device is lost
mask='r'  edge emits 'v7|ig'   -> {"geo":"ig"}             referrer is lost
mask='gd' edge emits 'v7|na.m' -> {"geo":"na","device":"mobile"}   ok only because g is present
```

A mobile viewer on a device-only rule gets the desktop URL — **and it is returned
with `s-maxage=3600`**, so the wrong answer is then served to everyone sharing
that cache key. Every rule set that does not happen to include a geo condition is
affected. This is the product's core feature failing.

The one `x-ctx` test (`api/test/api.test.ts:322`) uses `'v1|eu.d.dir.en.0'` — a
full five-token string no mask ever produces.

**Fix:** fixed-width slots with `-` for unmasked dimensions, or `key=value` pairs
decoded by name. Then unit-test `normalize.js` → `decodeCtx` across all 31
non-empty masks; it is 90 lines of pure function.

### 3.3 Stored XSS on the public page → session-riding against the dashboard

Four things line up:

1. **No scheme validation on input.** `web/src/components/editor/block-sheet.tsx:114`
   uses `inputMode="url"`, a keyboard hint, not validation.
2. **No scheme validation in the schema.** `web/src/lib/rules/schema.ts:68` uses
   `z.string().url()`. Executed against the installed zod 3.25.76:
   ```
   z.string().url().safeParse("javascript:alert(1)").success = true
   z.string().url().safeParse("JaVaScRiPt:alert(1)").success = true
   z.string().url().safeParse("data:text/html,<script>x</script>").success = true
   ```
3. **`esc()` is an HTML-entity escaper, not a URL sanitiser.**
   `web/src/lib/site/render.ts:220` escapes `& < > " '` — correct for attribute
   context, useless for URL context. Executed:
   ```
   esc("javascript:alert(document.cookie)") -> javascript:alert(document.cookie)
   ```
   Affects `render.ts:109` (gate), `:125` (link/embed) and `:143` (feed items) —
   every `href` on the page.
4. **The CSP permits it.** `web/src/app/[handle]/route.ts:65` sets
   `script-src 'unsafe-inline'`, and per CSP3 a `javascript:` navigation is allowed
   exactly when `'unsafe-inline'` is present. The comment above it ("ours, not
   creator input") is an assumption `'unsafe-inline'` cannot express.

**Impact.** `/{handle}` and `/app/*` share an origin, and `lc_at` is a `path="/"`
cookie. Script on a profile page can `fetch('/api/proxy/v1/profiles/<id>', {method:'PATCH'})`
same-origin; the cookie rides along and the proxy attaches the bearer. `httpOnly`
stops an attacker *reading* the token — it does not stop them *using* it. This is
the exact threat `web/src/lib/auth/session.ts:8-12` names and believes it closed.

**Fix:** allowlist schemes at the render boundary (`http:`, `https:`, `mailto:`,
`tel:`, root-relative; drop everything else), *and* at input, *and* replace
`'unsafe-inline'` with build-time hashes of the two literal blocks. The backend
already has the right primitive in `api/src/domain/schema.ts:18` (`SafeUrl`) — the
renderer must not depend on it, but it should be the shared implementation.

### 3.4 `DynamoRepo.recordEvents` cannot succeed, and its fallback recurses forever

`api/src/db/dynamo.ts:250`:

```ts
UpdateExpression: `ADD ${adds.join(', ')} SET #bb = if_not_exists(#bb, :empty)`,
```

`adds` contains `byBlock.#b0 :n0`. Two independent DynamoDB violations: `ADD` only
accepts top-level attributes, and `byBlock` / `byBlock.#b0` are overlapping
document paths. Every click write fails. The `.catch()` at line 258 calls
`recordEventsFallback`, which seeds the map and calls `recordEvents` again (line
272) — rebuilding the identical invalid expression. Unbounded recursion to the
Lambda timeout. `MemoryRepo.recordEvents` is a plain map update, so no test sees it.

Related: `getBlockTotals` (`dynamo.ts:295`) queries `STAT#` items. `K.stat`
(`types.ts:54`) has **zero call sites** — nothing writes them. In production
`byBlock` in the analytics response is permanently `{}`.

### 3.5 The deployed stack has no auth configuration

`api/infra/stack.ts:60` sets only `TABLE_NAME`, `KVS_ARN`, `NODE_OPTIONS`. With
neither `JWKS_URL` nor `DEV_JWT_SECRET`, `auth.ts:43` throws on every
authenticated request. `cdk deploy` ships a control plane that returns 401 to
everything.

---

## Part 4 — High-severity correctness bugs

### 4.1 A successful `204` delete is rolled back in the UI

`web/src/lib/api/client.ts:61` returns `undefined as T` for 204. `guard` returns
`T | null` and callers test truthiness, so `profile-store.tsx:288`:

```ts
if (!res) { dispatch({ type: "blocks", blocks: previous }); return; }
```

undoes a delete that succeeded. The real backend returns exactly this
(`api/src/routes/blocks.ts:131`, `c.body(null, 204)`). The mock returns a body,
which is why it was never seen. Same shape in `deleteRule`.

**Fix:** have `guard` signal failure out-of-band — `{ok, value}` or a sentinel —
rather than by falsiness.

### 4.2 The conflict lock is cleared by the rollback that follows the conflict

`profile-store.tsx:66`: `case "replace": return {...state, profile: action.profile, conflict: false, ...}`.

Trace `updateProfileFields`: optimistic `replace` → 409 → `dispatch({type:"conflict"})`
→ `if (!res) dispatch({type:"replace", profile: previous})`. The rollback runs
after the conflict in the same continuation, so final state is `conflict: false`.
The banner never appears for profile edits and writes are not blocked — the
inverse of the documented invariant. `claimHandle`, `publish`, `deleteRule`'s
rollback and `reload` all clear it too, so a conflict raised by a *block* op is
wiped by the next settings save.

`guard`'s early-out (`:158`) does not save it: `ref.current` only refreshes during
render, so it still holds pre-dispatch state.

**Fix:** a distinct `rollback` action, or make `replace` preserve `conflict` and
clear it only from `reload`.

### 4.3 Any backend 409 is misread as a version conflict

`ApiError.isVersionConflict` (`web/src/lib/api/types.ts:208`) keys on status 409.
The backend's only 409s are the handle-taken conflict and the block limit
(`api/src/routes/blocks.ts:44`). So hitting the 200-block cap locks the editor and
shows "This page changed somewhere else — another tab, or someone else on the
account." Discriminate on the problem+json `code`, not the status.

### 4.4 No optimistic concurrency server-side; concurrent creates wedge reordering

`version` is bumped but never asserted. `DynamoRepo.updateProfile` conditions only
on `attribute_exists(PK)`; `updateBlock` is an unconditional read-modify-write.
Two concurrent `POST /blocks` compute the same `rankBetween(last, null)` and both
write it. The next `move` across that pair throws `RangeError: rankBetween
requires a < b` from `api/src/rank.ts:19` — not an `ApiError`, so it surfaces as a
generic 500, and that list position is permanently unreorderable. There is no
rebalance routine anywhere, despite `web/src/lib/api/client.ts:146` claiming the
server has one.

### 4.5 The memory and Dynamo repositories do not have identical semantics

They are asserted to (`db/memory.ts:6`, `db/repo.ts:7`, `README.md:14`) and the
test suite depends on it. Confirmed divergences:

| Behaviour | `MemoryRepo` | `DynamoRepo` |
|---|---|---|
| Handle rename | frees the old handle immediately (`memory.ts:55`) | writes a 90-day tombstone at that key that blocks reclaim, including by the owner (`dynamo.ts:100`) |
| Analytics totals | real `totals` map | reads `STAT#` rows nothing writes |
| `recordEvents` | plain map update | invalid expression, infinite recursion |
| Returned shape | domain object | raw item, leaking `PK/SK/GSI1PK/GSI1SK/type` to the client |
| `dueForRefresh` | `updatedAt + ttl` | GSI2 query, and `GSI2SK` resets on *every* write |

`api/test/api.test.ts:125` ("renaming frees the old handle") asserts the memory
behaviour and would **fail against DynamoDB**. The suite certifies the wrong one.

**Fix:** one conformance suite run against both implementations (DynamoDB Local or
`aws-sdk-client-mock`), so any divergence fails the build.

---

## Part 5 — Security hardening

- **CORS reflects any origin.** `api/src/app.ts:28`, `origin: (o) => o ?? '*'`.
  Not a CSRF hole today (no `credentials: true`), but it becomes one the moment
  anyone adds a cookie session. Pin to an env allowlist.
- **JWT verification is loose** (`api/src/auth.ts:37`): no `exp` required — a
  token with no expiry returns 200; no `algorithms` allowlist; issuer and audience
  optional, so a shared Cognito/Auth0 pool lets other tenants in. `scopes` are
  parsed at `:53` and never enforced — every token can do everything.
- **`DEV_JWT_SECRET` is load-bearing in production.** `auth.ts:41` falls back to
  HS256 whenever `JWKS_URL` is unset, with no `NODE_ENV` gate and no length check.
  A stray env var converts the whole API to a shared symmetric secret, silently.
- **`POST /v1/events` is unauthenticated, unvalidated and unrated.** `tooMany` in
  `errors.ts:20` is defined and never used; no WAF in the stack. Anyone can inflate
  any creator's counters. `blockId` is never checked against the profile —
  attacker-chosen ids land in the owner's analytics, and on DynamoDB each becomes a
  map key on one item, so ~5,000 of them hits the 400 KB limit and analytics writes
  fail permanently. One 50-event request with 50 distinct handles costs 100
  unauthenticated `GetItem`s.
- **The proxy is an unrestricted authenticated forwarder.**
  `web/src/app/api/proxy/[...path]/route.ts:28` — no path allowlist, no
  Origin/Referer check on state-changing methods, no CSRF token, no body size cap.
  CSRF rests entirely on `sameSite: "lax"`, which is same-*site*: add a subdomain
  to this apex and it stops protecting you. Nothing documents that dependency.
  (No SSRF — the host is a fixed prefix. The refresh token is not leaked — `cookie`
  and `set-cookie` are correctly excluded.)
- **Cookies lack `Secure` outside production and have no `__Host-` prefix**
  (`web/src/lib/auth/session.ts:20`), so a staging build over HTTPS can be
  overwritten by a sibling subdomain.
- **The dashboard has no CSP, no `nosniff`, no HSTS** — `web/next.config.ts:7`
  sets only `Cache-Control` and `X-Frame-Options`, on an origin that by design
  also serves creator-authored HTML.
- **`SafeUrl`'s blocklist is partial** (`api/src/domain/schema.ts:18`): misses
  IPv6 (`[::1]`, `[::ffff:127.0.0.1]`), `0.0.0.0`, integer/octal encodings
  (`http://2130706433/`), the rest of `169.254.0.0/16`, and CGNAT `100.64.0.0/10`.
  Harmless while nothing fetches targets server-side — but `dueForRefresh` exists
  to add exactly that, and `avatarUrl` and `feed.ref` are already user-supplied.
- **Client-controlled `x-ctx` on maskless profiles.** `edge/normalize.js:70`
  returns early without stripping the header, and `x-ctx` is the sole cache key.
  A client can mint arbitrary cache keys, or force `no-store` on demand. Strip or
  overwrite unconditionally.
- **`BlockPatch` discards all cross-field validation.** `schema.ts:119` calls
  `.innerType()`, unwrapping the `superRefine`. `PATCH {activeFrom: <future>,
  activeUntil: 1000}` returns 200 and permanently hides the block; a PATCH can also
  clear a link's `target`, after which `/r/` 404s.

---

## Part 6 — Design and quality

### Backend

- **Ownership middleware runs twice per block request.** `profiles.use('/:id/*')`
  and `blocks.use('*')` both match, so every block call does two JWT verifications
  and two `getProfile` calls. With `republish`, a single `POST /blocks` is ~5
  DynamoDB round trips. Compounding it, `getBlock` (`dynamo.ts:169`) is a **full
  paginated partition scan plus `Array.find`**, because `rank` is embedded in the
  sort key with no compensating GSI.
- **The mask-coverage safety check can never fire.** `public.ts:100` derives `dims`
  from the *current database rules*, so it is coverage-complete by construction.
  It should derive from the `x-ctx` payload the edge actually sent — which is
  precisely why 3.2 yields a *cacheable* wrong answer instead of `no-store`.
- **`GET /p/:handle` has no stale-version check**, unlike `/r/`.
- **`PUT /blocks/:id/rules` swallows publish failures** (`blocks.ts:92`): a KVS
  outage — the thing that desynchronises the edge from the rules — returns 200 with
  no log and no metric. `mask` in that response is always `undefined` because
  `republish` returns `void`.
- **`move` never republishes or bumps `version`**, so the staleness signal never
  trips for reorders. More broadly there is **no cache invalidation at all** — no
  `CreateInvalidation`, and the KVS policy grants only `PutKey`/`DeleteKey`. For a
  profile with no rules there is no mask and no version signal, so an edit takes up
  to an hour to appear.
- **Click writes on the redirect path are dropped.** `public.ts:18` guards
  `c.executionCtx?.waitUntil`, but `hono/aws-lambda` provides no `executionCtx`, so
  it always lands in the `catch` and the write is unawaited. Lambda freezes on
  handler resolution. Move it to SQS/Firehose or await it.
- **Env config is unvalidated.** `env.ts` is 12 lines of `?? default`;
  `Number(process.env.MAX_BLOCKS ?? 200)` is `NaN` on a typo, and `length >= NaN`
  is always false — the limit silently disappears. Zod is already a dependency.
- **Error handling is inconsistent.** Repo errors are mapped only where a route
  remembers (`profiles.patch` and `republish` both leak `NotFoundError` as 500);
  the 404 handler returns `application/json` while everything else returns
  `problem+json`; `requestId` is generated and never surfaced in the body or a
  header, so a user-reported error cannot be correlated to a log line.
- **No observability.** No structured logs, metrics, tracing, alarms, DLQ, log
  retention or reserved concurrency. The three places a failure is deliberately
  hidden are exactly the three that need counters. The DynamoDB stream is enabled
  with no consumer.
- **Origin Shield is not enabled**, despite the README prescribing it and the
  architecture deliberately aligning every edge location's TTL to the same boundary.
  The comment describing it is attached to `enableLogging: true` in `stack.ts:140`.
- **Worth verifying against a live deploy:** the `/v1/*` behaviour uses
  `ALL_VIEWER_EXCEPT_HOST_HEADER` (forwarding `Authorization`) against an OAC
  origin with `AWS_IAM` auth, which signs using that same header. Check this before
  concluding a 401 is an application bug.
- **`deleteProfile` orphans the analytics partition** — no erasure path, and those
  items never set the TTL attribute the table is configured with.
- **Dead code:** `edge/normalize.js:48` reads `hot:<handle>/<slug>`; nothing in
  `src/` ever writes a `hot:` key. `dueForRefresh` has no caller and no refresher
  Lambda. `K.user` and `K.stat` are never called. `tombstone.redirectTo` is never
  read, so the documented 301 grace period does not exist.
- **Analytics are bucketed by UTC day** (`analytics.ts:31`), so a creator in UTC+13
  sees their day split — in a codebase that already has excellent timezone
  primitives.
- `MAX_RULES` is enforced twice, once from env and once hardcoded at
  `schema.ts:73`; a `MAX_RULES=50` deployment still rejects at 21.
- `GET /:id/handle/available` sits under the ownership middleware, so it cannot be
  called before a profile exists — which is its stated purpose.
- `errors.ts:29` ships `https://errors.example/` in the public error contract.
- No request body size limit; `hono/body-limit` is not installed.

### Frontend

- **`web/src/lib/rules/schema.ts` does not mirror the backend**, despite its header
  saying so. They share no vocabulary: `{dimension, op, values}` vs `{dim, in}`;
  `country` ISO-2 vs `geo` 6-bucket; `referrer` free-text vs an 8-value enum; web
  has `os`/`region` the backend lacks, the backend has `webview` the web lacks;
  `effect: show/hide/rewrite/promote` vs `then: redirect/hide`; rules on the profile
  vs embedded in blocks. The file's own warning — *"a copy that drifts is worse
  than no client validation at all"* — describes the current state. Extract
  `@linkctx/schemas`.
- **Handle rules drift too.** `handles.ts:39` allows `.`, the backend does not.
  `pure.test.ts:214` *asserts* `giorgi.official` is valid, locking in the drift.
  The reserved sets differ in both directions; neither is a superset.
- **"The visitor's own timezone" cannot be saved.** `rule-builder.tsx:417` offers
  it and explains its cache cost, but `schema.ts:15` requires a valid IANA zone and
  `isValidTimezone("viewer")` is false. It fails *silently* — the issue path is
  `conditions.N.window.timezone` and `WindowEditor` gets no `error` prop, so
  "Add rule" does nothing with no message. This also dead-ends `needsZoneBucket`,
  which `pure.test.ts:162` tests.
- **`eventAt` shifts by the UTC offset on every round trip.**
  `settings-form.tsx:88` feeds `.slice(0,16)` of an ISO/UTC string into a
  `datetime-local` input, then reads it back as local. Set 20:00 in UTC+4, reopen at
  16:00, save again, get 12:00. `simulator.tsx:220` has the correct `toLocalInput`
  helper; settings does not use it.
- **The DST advisory misses gaps that cross local midnight.** `dst.ts:118` requires
  `to > from`, but a midnight spring-forward gives `from = 1440, to = 60`. Executed
  against real Intl data: `America/Santiago` and `America/Havana` 2026 emit nothing;
  `America/New_York` emits correctly. A 00:00–01:00 Havana window gets no warning.
- **`rankBetween(null, key)` can return a rank above its bound.** Executed:
  `rankBetween(null, "0") = "0U"`, which is not below `"0"`. Unreachable from client
  code today, but ranks are server-minted and `api/src/rank.ts` is a separate
  implementation.
- **`initialRanks` produces duplicates** — for `count = 80`, 19 keys all clamp to
  `"z"`, and `byRank` then gives an unstable order.
- **`cacheControlFor` can emit `s-maxage=NaN`** — `visitor.ts:88`,
  `Number(MAX_S_MAXAGE)` on a non-numeric value, and `Math.min(x, NaN)` passes the
  `s === 0` guard. A malformed directive is dropped, so every profile silently
  falls back to the CDN default. No API response is runtime-validated anywhere
  (`client.ts:73` is a bare `payload as T`).
- **The variant fingerprint is unique per request.** `[handle]/route.ts:90` maps
  `tz-bucket` to `context.at`, which is `now.toISOString()` — millisecond precision.
  Bucket the offset instead. Separately `varyHeader` has no `tz-bucket` entry, so
  `.filter(Boolean)` drops the one dimension that actually varies the page.
- **The `If-Match` version is read from a ref that only refreshes on render**
  (`profile-store.tsx:153`, itself an impurity under concurrent rendering). Two
  writes in one async continuation both send the stale version —
  `block-sheet.tsx:44` does exactly that. Keep the authoritative version in a
  mutable ref written by the dispatching code.
- **`Sheet` has no focus management.** `primitives.tsx:189` puts `onKeyDown` on a
  non-focusable `div` and relies on bubbling, but focus is never moved in and the
  trigger lives outside the sheet — so Escape does nothing. No focus trap, no
  restore on close, no `aria-modal`, background not `inert`. A keyboard user must
  tab the whole list behind the overlay.
- **The drag has no visible payload** — `globals.css:74` sets `opacity: 0` on the
  dragged element itself and there is no `DragOverlay`, so the thing following the
  pointer renders empty.
- `Field label=""` at `rule-builder.tsx:330` and `settings-form.tsx:216` produces an
  empty `<label>`.
- `identity.json/route.ts:24` skips the `isReserved`/`isValidHandle` guard the sibling
  route applies, and omits `nosniff`. `[handle]/route.ts:27` validates
  `handle.toLowerCase()` but resolves the original case.
- `redirect()` inside `try`/`catch` (`app/page.tsx:12`, `app/new/page.tsx:15`) works
  only because both rethrow unconditionally; any non-rethrowing branch swallows
  `NEXT_REDIRECT`.
- `NEXT_PUBLIC_BEACON_URL` defaults to `/v1/beacon`, a same-origin path with no
  route handler — beacons 404 unless the env var is set.
- **TypeScript is strict** (including `noUncheckedIndexedAccess`) with no literal
  `any`. The escapes are `undefined as T` / `payload as T` in `client.ts`, a run of
  `block!` / `draft.id!` in `block-sheet.tsx` and `rules-library.tsx`, and
  `e.target.value as Theme[...]` casts throughout the forms.
- **Component sizes** — `rule-builder.tsx` is 559 lines holding five components,
  `profile-store.tsx` is 364 lines of reducer plus ten ops. Both are cohesive;
  split when they next change. Server/client boundaries are correct throughout.

### Tests

94 tests, all green, and they cover the genuinely hard parts — DST inversion,
boundary TTLs, rank subdivision to 200 levels, SSRF rejection, cross-user 403s.
The structural gap is that they run against `MemoryRepo`, which does not match
production (4.5), and against `esc` in isolation rather than `renderProfile` as a
whole — which is why 3.3 was never caught. Nothing covers the reducer, any
rollback or 409 path, the proxy route, `ruleInputSchema`, `edge/normalize.js`,
concurrency, or any component. `pure.test.ts:111` mutates `process.env` without
restoring it.

---

## Part 7 — Suggested order

1. **Decide the API contract** and write it down — OpenAPI or a shared package.
   Nothing else can be integration-tested until web and api agree.
2. **Fix `x-ctx`** (3.2) and unit-test `normalize.js` → `decodeCtx` across all 31 masks.
3. **Fix the XSS chain** (3.3) — scheme allowlist at render *and* input, CSP hashes
   instead of `'unsafe-inline'`.
4. **Fix `recordEvents`** (3.4) — one item per `(day, block)` with a top-level
   `ADD clicks :n`; delete the recursive fallback; write the `STAT#` rows.
5. **Build the repo conformance suite** (4.5) and settle the tombstone semantics in
   one direction.
6. **Fix the store's conflict and 204 handling** (4.1, 4.2, 4.3).
7. **Auth hardening** — stack env vars (3.5), require `exp`/issuer/audience,
   `algorithms` allowlist, gate `DEV_JWT_SECRET` on `NODE_ENV`, zod-validate `env.ts`.
8. **Rate-limit and authorise `/v1/events`**; validate `blockId` against the profile.
9. **Conditional writes for rank assignment** plus a rebalance path (4.4).
10. **Extract `@linkctx/schemas`** — rules, handles, URL validation, one source.
11. **Origin Shield, alarms, structured logs, log retention.**
12. **Sheet focus management** and the smaller a11y items.
