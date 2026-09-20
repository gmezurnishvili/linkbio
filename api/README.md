# linkbio-api

Backend for a link-in-bio service with context-aware routing. TypeScript, Hono, DynamoDB single-table, deployed as one Lambda behind CloudFront.

## Running it

```bash
npm install
DB_DRIVER=memory AUTH_SECRET=a-secret-of-at-least-32-bytes-long npm run dev
npm test          # 331 tests, no AWS account needed
npm run typecheck
```

`DB_DRIVER=memory` swaps the DynamoDB repository for an in-memory one, and
`test/conformance.test.ts` runs one suite of cases against both to keep them
honest. They are required to behave identically and for a long time did not —
handle tombstones, analytics totals, event recording, returned shapes and the
refresh index all differed, so a green suite certified behaviour production did
not have and one test asserted the opposite of it.

Configuration is parsed and validated at module load (`src/env.ts`), so a bad
value stops the process rather than silently becoming `NaN`. You need
`AUTH_SECRET` (32 bytes or more) unless an external issuer owns identity, in
which case set `JWKS_URL` and `JWT_AUDIENCE`.

## Endpoints

### Public (cached at the edge)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/r/:handle/:blockId` | Evaluates rules, 302s, sets `s-maxage` to the next rule boundary |
| `GET` | `/p/:handle` | Render payload; hidden and expired blocks filtered server-side |
| `POST` | `/v1/events` | Click beacon, unauthenticated, append-only, 50 events max |
| `POST` | `/v1/public/:handle/resolve` | Resolution for a caller-supplied visitor context |
| `GET` | `/health` | |

A profile with `publishedVersion: null` is a draft, and all three public routes
404 for it.

### Control plane (bearer JWT)

| Method | Path | Notes |
|---|---|---|
| `GET POST` | `/v1/profiles` | |
| `GET PATCH DELETE` | `/v1/profiles/:id` | |
| `PUT` | `/v1/profiles/:id/handle` | Transactional rename, old handle tombstoned for 90 days |
| `POST` | `/v1/profiles/:id/publish` | Records the version that is live |
| `POST` | `/v1/profiles/:id/preview` | Draft resolution with the decision trace |
| `GET` | `/v1/profiles/:id/handle/available` | |
| `GET POST` | `/v1/profiles/:id/blocks` | |
| `PATCH DELETE` | `/v1/profiles/:id/blocks/:blockId` | |
| `PUT` | `/v1/profiles/:id/blocks/:blockId/rules` | |
| `POST` | `/v1/profiles/:id/blocks/:blockId/move` | Single-row reorder |
| `GET` | `/v1/profiles/:id/analytics` | `?from=&to=` |

### Identity (no auth)

| Method | Path | Notes |
|---|---|---|
| `POST` | `/v1/auth/register` | scrypt, 409 if the email is taken |
| `POST` | `/v1/auth/token` | |
| `POST` | `/v1/auth/refresh` | Rotates; reusing a spent token revokes every session |
| `GET` | `/v1/handles/:handle` | `free` / `taken` / `reserved` / `invalid` / `tombstoned` |

`GET /v1/me` returns the signed-in user and their profiles.

Errors are RFC 9457 problem+json with a per-field `errors` array and a
`requestId`. The two 409s are distinguishable by `title`: `version_conflict`
(a stale `If-Match`, carrying the `current` version) means reload, `conflict`
(a taken handle, the block limit) means the value is unusable.

### Concurrency

Every mutation accepts `If-Match: <profile version>` and answers
`{ data, version, cacheDimensions }`. The version bump is a conditional write
that happens *before* anything else in the request, which is the serialization
point for the whole profile — two concurrent block creates cannot both read the
same tail rank and write it twice.

## How a request flows

1. `edge/normalize.js` runs on viewer request. It checks `hot:<handle>/<slug>` for a fully static link, then reads `mask:<handle>` to learn which viewer signals this profile actually varies on, and writes them into an `x-ctx` header as **five fixed slots** (`v<version>|geo.device.referrer.lang.webview`) with `-` for any dimension the mask does not cover.
2. `x-ctx` is the sole header in the cache policy, so cache cardinality stays bounded — an uncovered slot is the constant `-`, so a profile with no rules still has exactly one key per path. The header is overwritten unconditionally, including for maskless profiles: leaving a viewer-supplied one in place hands any client an unlimited supply of cache keys.
3. On a miss, the origin evaluates the rule set, picks a destination, and computes `s-maxage` as the seconds until the decision actually changes.

## Things that will bite you

- **The `x-ctx` slots are positional, so they have to be fixed-width.** Emitting only the masked dimensions — which is what the first version did — puts the device token in the geo slot for a device-only mask. The rule then never matches, and the wrong answer is still returned as cacheable and replayed to everyone sharing the key. `test/edge.test.ts` pins the round trip for all 32 masks.
- **The origin's coverage check must read the dimensions the edge sent**, not the ones derived from the current rules. Derived from the database it is complete by construction and can only ever pass.
- **`maxTtl` on the cache policy silently clamps `s-maxage`.** Keep it above the API's `MAX_S_MAXAGE` or every computed TTL is quietly truncated.
- **Never 301.** The schema only permits 302 and 307 for rule-driven redirects. A browser-cached permanent redirect outlives every TTL this service computes.
- **Boundaries cause synchronised stampedes.** Every edge location's TTL expires at the same instant. Turn on Origin Shield; add jitter only *after* the boundary, never before.
- **Don't put the Lambda in a VPC.** Nothing it talks to requires one, and a NAT gateway costs ~$33/month before serving a request.
- **A hot link is a promise that the origin would have said the same thing.** The edge answers `hot:<handle>/<id>` without evaluating anything, so a block only qualifies while it has no rules, no activity window, an http(s) target, and sits on a published profile. The moment any of that stops being true the key has to go, which is why `publishRouting` sends deletes alongside every publish — and why a deleted block's id is passed in explicitly, since it is gone from `listBlocks` by then.
- **Hot links are not counted server-side.** A redirect answered at the edge never reaches `/r/`, so `recordEvents` never sees it. The public page's own beacon still fires; a visitor with JavaScript off does not. `HOT_LINKS=off` puts every redirect back on the origin path.
- **A rename has to move the edge routing with it.** `mask:<handle>` and every `hot:<handle>/…` are keyed by name, and a handle that changes hands carries them to the next owner — a cache-key mask derived from someone else's rules. `publishRouting` takes `previousHandle` for exactly this.
- **Feeds are pulled on a schedule, never on the render path.** A cache miss is already the slowest thing a visitor can do; putting YouTube in that path turns a third party's outage into a creator's page timing out. The cost is that a new feed block is empty for a few minutes, which the editor says out loud.
- **A failing feed backs off, and the backoff reads the attempt, not the success.** `nextFeedDueAt` doubles the interval per consecutive failure to a 16× ceiling. Keying the index off `feedRefreshedAt` alone leaves a broken feed permanently due and retried on every single run.
- **KeyValueStore is 5 MB total, 1 KB per value.** It holds masks and hot links, not data. This design runs out of room around 50–80k profiles using context routing; the exit is Lambda@Edge plus DynamoDB Global Tables on the miss path.

## Layout

```
src/
  app.ts              Hono app, middleware, route mounting
  auth.ts             JWT verification, viewer-context normalization
  rank.ts             Fractional indexing for block order
  publish.ts          Mask + hot-link derivation, KeyValueStore publishing
  refresher.ts        Scheduled Lambda: fills feed blocks whose TTL elapsed
  domain/schema.ts    Zod schemas — the API contract
  domain/types.ts     Entities and single-table key builders
  db/repo.ts          Repository interface
  db/dynamo.ts        Production implementation
  db/memory.ts        Test implementation, same semantics
  routes/             profiles, blocks, public, analytics
  rules/              Rule evaluator and DST-correct boundary math
  feeds/              Feed adapters, SSRF-safe fetcher, refresh scheduling
edge/normalize.js     CloudFront viewer-request function
infra/stack.ts        CDK stack
```

## Deploying

```bash
npm run build         # or build:slim to externalize the SDK (1.5MB -> 300KB)
npx cdk deploy
```

`npm run build` produces two bundles: `dist/` for the API and `dist-refresher/`
for the feed refresher, which the stack schedules every five minutes with
`reservedConcurrentExecutions: 1`. Two overlapping runs would be harmless — the
work list is a due-time index and each refresh pushes that time forward before
anything else — but they would double the rate-limit pressure on YouTube and
GitHub for nothing.

To see what the refresher would do, without waiting for the schedule:

```bash
DB_DRIVER=dynamo TABLE_NAME=linkbio npm run refresh:once
```

`build:slim` relies on the AWS SDK present in the Node 22 Lambda runtime. It cuts cold start noticeably but gives up version pinning — if the runtime's SDK drifts, you find out in production. Bundle fully unless cold start is measurably hurting.

The stack sets the Lambda's environment itself, including a generated
`AUTH_SECRET` in Secrets Manager. It previously set neither that nor `JWKS_URL`,
which meant `cdk deploy` produced a stack whose entire control plane answered
401. `src/env.ts` now refuses to boot rather than serve one.

Required environment: `TABLE_NAME`, `KVS_ARN`, and either `AUTH_SECRET` (32+
bytes, for tokens this API issues) or `JWKS_URL` plus `JWT_AUDIENCE` (for an
external issuer). `DEV_JWT_SECRET` is rejected outright when
`NODE_ENV=production`.

## Where the layout changed

```
src/
  env.ts              Parsed and validated at load; throws on a bad value
  resolve.ts          The one place a profile turns into a rendered page
  routes/auth.ts      register / token / refresh
  routes/me.ts        The signed-in user and their profiles
  routes/handles.ts   Availability, unauthenticated and not under a profile id
  routes/mutation.ts  If-Match, the response envelope, the version gate
test/
  conformance.test.ts One suite, both repositories
  edge.test.ts        The x-ctx encode/decode contract, all 32 masks
  rank.test.ts        Bound invariants and the rebalance escape hatch
  routes.test.ts      Auth, publish gating, the two 409s, the beacon's limits
```

`routes/blocks.ts` is mounted as a child of `routes/profiles.ts` rather than at
the top level, so `requireAuth` and the ownership check run once per request
instead of twice.
