# linkbio-api

Backend for a link-in-bio service with context-aware routing. TypeScript, Hono, DynamoDB single-table, deployed as one Lambda behind CloudFront.

## Running it

```bash
npm install
DB_DRIVER=memory DEV_JWT_SECRET=a-secret-at-least-32-bytes-long npm run dev
npm test          # 66 tests, no AWS account needed
npm run typecheck
```

`DB_DRIVER=memory` swaps the DynamoDB repository for an in-memory one with identical semantics, so the whole suite and local development run without provisioning anything.

## Endpoints

### Public (cached at the edge)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/r/:handle/:blockId` | Evaluates rules, 302s, sets `s-maxage` to the next rule boundary |
| `GET` | `/p/:handle` | Render payload; hidden and expired blocks filtered server-side |
| `POST` | `/v1/events` | Click beacon, unauthenticated, append-only, 50 events max |
| `GET` | `/health` | |

### Control plane (bearer JWT)

| Method | Path | Notes |
|---|---|---|
| `GET POST` | `/v1/profiles` | |
| `GET PATCH DELETE` | `/v1/profiles/:id` | |
| `PUT` | `/v1/profiles/:id/handle` | Transactional rename, old handle tombstoned for 90 days |
| `GET` | `/v1/profiles/:id/handle/available` | |
| `GET POST` | `/v1/profiles/:id/blocks` | |
| `PATCH DELETE` | `/v1/profiles/:id/blocks/:blockId` | |
| `PUT` | `/v1/profiles/:id/blocks/:blockId/rules` | |
| `POST` | `/v1/profiles/:id/blocks/:blockId/move` | Single-row reorder |
| `GET` | `/v1/profiles/:id/analytics` | `?from=&to=` |

Errors are RFC 9457 problem+json with a per-field `errors` array.

## How a request flows

1. `edge/normalize.js` runs on viewer request. It checks `hot:<handle>/<slug>` for a fully static link, then reads `mask:<handle>` to learn which viewer signals this profile actually varies on, and folds only those into an `x-ctx` header.
2. `x-ctx` is the sole header in the cache policy, so cache cardinality stays bounded. A profile with no rules has no mask entry and caches on path alone.
3. On a miss, the origin evaluates the rule set, picks a destination, and computes `s-maxage` as the seconds until the decision actually changes.

## Things that will bite you

- **`maxTtl` on the cache policy silently clamps `s-maxage`.** Keep it above the API's `MAX_S_MAXAGE` or every computed TTL is quietly truncated.
- **Never 301.** The schema only permits 302 and 307 for rule-driven redirects. A browser-cached permanent redirect outlives every TTL this service computes.
- **Boundaries cause synchronised stampedes.** Every edge location's TTL expires at the same instant. Turn on Origin Shield; add jitter only *after* the boundary, never before.
- **Don't put the Lambda in a VPC.** Nothing it talks to requires one, and a NAT gateway costs ~$33/month before serving a request.
- **KeyValueStore is 5 MB total, 1 KB per value.** It holds masks and hot links, not data. This design runs out of room around 50–80k profiles using context routing; the exit is Lambda@Edge plus DynamoDB Global Tables on the miss path.

## Layout

```
src/
  app.ts              Hono app, middleware, route mounting
  auth.ts             JWT verification, viewer-context normalization
  rank.ts             Fractional indexing for block order
  publish.ts          Mask derivation and KeyValueStore publishing
  domain/schema.ts    Zod schemas — the API contract
  domain/types.ts     Entities and single-table key builders
  db/repo.ts          Repository interface
  db/dynamo.ts        Production implementation
  db/memory.ts        Test implementation, same semantics
  routes/             profiles, blocks, public, analytics
  rules/              Rule evaluator and DST-correct boundary math
edge/normalize.js     CloudFront viewer-request function
infra/stack.ts        CDK stack
```

## Deploying

```bash
npm run build         # or build:slim to externalize the SDK (1.5MB -> 300KB)
npx cdk deploy
```

`build:slim` relies on the AWS SDK present in the Node 22 Lambda runtime. It cuts cold start noticeably but gives up version pinning — if the runtime's SDK drifts, you find out in production. Bundle fully unless cold start is measurably hurting.

Required environment: `TABLE_NAME`, `KVS_ARN`, and either `JWKS_URL` (plus optional `JWT_ISSUER` / `JWT_AUDIENCE`) or `DEV_JWT_SECRET`.
