# Deploying

`RUNNING.md` is the local setup. This is the deployed one: what the stack
builds, how to get it up, and how to tell whether it worked.

Nothing here has been run against a real AWS account yet. Everything that
*can* be checked without one has been — see [What is verified](#what-is-verified)
at the end, which is specific about where the line falls.

---

## What gets built

One CloudFront distribution, two Lambdas, one table, one edge key-value store.

```
                      ┌──────────────────── CloudFront ────────────────────┐
                      │  WAF: rate limit on /v1/*, AWS common rule set     │
  visitor ──────────▶ │                                                    │
                      │  /_next/static/*  ──▶ web Lambda   (immutable)     │
                      │  /_next/*         ──▶ web Lambda   (no cache)      │
                      │  /app, /app/*     ──▶ web Lambda   (no cache)      │
                      │  /login /signup /logout                            │
                      │  /api/proxy/*     ──▶ web Lambda   (no cache)      │
                      │  /r/*  /p/*       ──▶ API Lambda   (keyed x-ctx)   │
                      │  /v1/*            ──▶ API Lambda   (no cache)      │
                      │  /health          ──▶ API Lambda                   │
                      │  *  (default)     ──▶ web Lambda   (keyed x-ctx)   │
                      └────────────────────────────────────────────────────┘
                                    │                       │
                          web Lambda│                       │API Lambda
                        (Next 15,   │                       │(Hono)
                         standalone)└──── SigV4, direct ────▶│
                                                            │
                                            DynamoDB ◀──────┤──────▶ KeyValueStore
                                                            │        (masks, hot links)
                                        feed refresher ─────┘
                                        (EventBridge, 5 min)
```

The default behaviour is the web app because the public page is `/<handle>` at
the root; the dashboard lives under known prefixes, which is what makes the
split expressible as CloudFront path patterns at all.

Three consequences worth stating plainly, because they are the point of this
arrangement:

- **A click never wakes the Next Lambda.** `/r/*` is a behaviour on the API,
  with the edge function in front of it, so `HOT_LINKS` and the hot-link
  short-circuit in `api/edge/normalize.js` are reachable for the first time.
  The route handler at `web/src/app/r/[handle]/[blockId]/route.ts` still exists
  and still works — it is what makes clicks work locally and in any
  single-origin deployment — but in this topology nothing routes to it.
- **The beacon is same-origin.** `/v1/events` is a path on the distribution, so
  the click beacon needs no CORS and no second hostname.
- **The public page is edge-keyed like the API's routes are.** `api/edge/page.js`
  writes the same `x-ctx` header for `/<handle>` that `normalize.js` writes for
  `/r/` and `/p/`, and the page resolves against that header rather than
  re-deriving context from raw viewer headers. An answer is therefore a function
  of the cache key it will be stored under, which is the property the whole
  design rests on.

### Why the function URLs are `authType: NONE`

Because Origin Access Control cannot front a URL that browsers post to, and
this is worth knowing before anyone tries to "fix" it.

OAC signs each origin request with SigV4. A signed request to a Lambda function
URL has to carry the SHA-256 of its own body in `x-amz-content-sha256`, and
CloudFront does not hash the body for you — [AWS's own
documentation](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html)
says the *viewer* must compute it, and that "Lambda doesn't support unsigned
payloads". A browser will never do that. Under OAC, every form post, every
Server Action and every click beacon is a 403. GETs are fine, which is what
makes it look like it works.

So both function URLs are open, and what keeps them from being a way around the
WAF is `-c originSecret=…`: CloudFront sends it to both origins as a custom
origin header, which **overwrites** any header of that name from the viewer, and
both Lambdas refuse a request without it (`api/src/app.ts`,
`web/lambda/handler.mjs`). The web app presents the same secret on its direct
calls to the API (`web/src/lib/api/origin-fetch.ts`).

Deploying without it works. The app's own bearer and cookie auth still applies —
what you lose is the WAF's rate limit and managed rules for anyone who learns
the function URL. Generate one with `openssl rand -hex 32`.

Calls from the web Lambda to the API go direct rather than back through the CDN:
the loop would need the distribution's own domain in the Lambda's environment,
and the distribution already names that Lambda as an origin, so CloudFormation
refuses the cycle. It would also bill a CDN request per dashboard call.

That same cycle is why `NEXT_PUBLIC_SITE_ORIGIN` is optional. Without it the app
reads the viewer's host from `x-forwarded-host`, which `api/edge/page.js` writes
— CloudFront sends a function URL origin its *own* hostname, so `request.url` is
a name no visitor typed. `web/src/lib/site/public-origin.ts` is the one place
that resolves it, and both the canonical URL and the same-origin check on every
write go through it.

---

## Prerequisites

- An AWS account, and credentials in the shell you deploy from.
- Node 22. The API source is run with type stripping and esbuild targets
  `node22`; the Lambdas are `nodejs22.x`.
- Region: **us-east-1**. Not a preference — CloudFront WebACLs and the
  CloudFront KeyValueStore exist only there, and the stack creates both.
- One-time per account/region:

  ```bash
  npx cdk bootstrap aws://<account-id>/us-east-1
  ```

- **Check the account's Lambda concurrency limit.** A new AWS account gets 10
  concurrent executions for everything, which is enough to deploy and click
  around and not enough to serve anyone: the web Lambda, the API and the feed
  refresher share it, and past ten simultaneous requests CloudFront starts
  returning 503s that the `ApiThrottles` and `WebThrottles` alarms will report.

  ```bash
  aws service-quotas get-service-quota --service-code lambda \
    --quota-code L-B99A9384 --query 'Quota.Value'
  ```

  If that says 10, request an increase before doing anything that matters. It is
  also what stops the feed refresher from reserving concurrency — see
  `refresherReservedConcurrency` below.

---

## Deploy

Order matters: both Lambdas are uploaded as directory assets, and CDK resolves
them at synth time. A stack synthesized before the builds have run uploads
whatever was in `dist/` last time, or fails.

**PowerShell** (Windows):

```powershell
cd api
$env:SITE_ORIGIN         = "https://<your-distribution>.cloudfront.net"
$env:LINKBIO_ORIGIN_SECRET = "<32+ random hex characters>"
npm run deploy
```

**bash:**

```bash
cd api
export SITE_ORIGIN=https://<your-distribution>.cloudfront.net
export LINKBIO_ORIGIN_SECRET=$(openssl rand -hex 32)
npm run deploy
```

Both settings are environment variables rather than `--context` arguments, for
two reasons. A secret on the command line ends up in shell history and in the
process list. And `npm run x -- -c foo` does not survive Windows PowerShell 5.1,
which strips the `--` before npm sees it — npm then reads `-c` as its own
`--call` flag and fails with an `npm exec` usage error that says nothing about
what went wrong. `-c originSecret=…` still works where the shell passes it
through.

That builds the web app, then the API and the refresher, then deploys — in that
order, because both Lambdas are uploaded as **directory assets** that CDK
resolves from disk at synth time. Nothing about `cdk deploy` knows that
`web/dist` predates the source it is meant to contain, so running it on its own
after an edit ships the previous build: a successful deploy of the wrong code,
whose symptoms look like infrastructure faults. `api/infra/freshness.ts` refuses
to synthesize when that is the case; `-c skipStaleCheck=true` overrides it.

The long way, if you want the steps separately:

```bash
cd web && npm ci && npm run build:lambda
cd ../api && npm ci && npm run build
npx cdk deploy -c originSecret=$(openssl rand -hex 32)
```

Keep that secret and reuse it. Passing none turns the check off, with a warning
at synth. Changing it is allowed but not free: CloudFront takes a few minutes to
propagate a new custom origin header, and during that window the edge and the
Lambdas disagree and requests 403.

`SITE_ORIGIN` is a build-time value — it is baked into the bundle, which is why
it belongs to the build half of `npm run deploy` rather than the stack. Setting
it makes the canonical URL and the same-origin check deterministic instead of
inferred from forwarded headers; it can only be set once the distribution
exists, so the very first deploy goes without it.

`npx cdk diff` first is worth the thirty seconds on anything but the first
deploy — the distribution's behaviour list is the part where a mistake is both
easy and invisible until a page 404s.

### If a deploy fails

**The stack must be deleted before you retry.** A failed *first* deploy leaves
it in `ROLLBACK_COMPLETE`, which CloudFormation will not update — `npx cdk
destroy`, or delete it in the console, then deploy again. The DynamoDB table is
`RETAIN`, so it survives; it has a generated name, so it will not clash.

Three failures worth naming, because the message does not point at the cause:

| Message | Cause |
| --- | --- |
| `Limit exceeded … 'AWS::CloudFront::OriginRequestPolicy' … more headers than are allowed` | An origin request policy with more than 10 headers. The quota is adjustable, but the managed `ALL_VIEWER_EXCEPT_HOST_HEADER` policy has no such limit and is what the app behaviours use. |
| `ReservedConcurrentExecutions … decreases account's UnreservedConcurrentExecution below its minimum value of [10]` | The account's Lambda concurrency limit is too low for *any* reservation — a new AWS account's entire limit is 10. Nothing reserves concurrency by default any more, so a current checkout does not hit this; an older one clears it with `-c refresherReservedConcurrency=0`. |
| 403 on every POST, GETs fine | Origin Access Control in front of a function URL. See above — it cannot be configured around. |
| `Refusing to synthesize against a stale bundle` | Exactly what it says: `web/dist` or `api/dist` is older than its source. `npm run deploy` from `api/` does the builds in order. |
| `npm error code EUSAGE` … `npm exec` usage | Windows PowerShell 5.1 stripped the `--` from `npm run deploy -- -c …`, so npm read `-c` as `--call`. Use the environment variables above instead. |
| `Refusing to synthesize` immediately after a successful build | The build half did not run, or the staleness check is reading the wrong thing. `cat web/dist/.build-stamp` says when the bundle was actually built; the check reads `builtAtMs` from it rather than a file mtime, because `fs.cp` on Windows preserves the *source* timestamp and copied files in `dist` can look years old. |

### After a deploy: "Cross-origin request refused" on every write

That message comes from one place — the CSRF check in `web/src/app/api/proxy`.
The cause, every time so far, has been a **stale `web/dist`**: a bundle built
before the same-origin fix compares the browser's `Origin` against
`request.url`, which behind a function URL is the Lambda's own hostname and
never matches. The freshness check above exists to make this impossible; if you
are on an older checkout, rebuild and redeploy.

Once it is deployed, `isSameOrigin` prefers `Sec-Fetch-Site`, which browsers
compute themselves and scripts cannot set, so the check no longer depends on
the app knowing its own public origin.

### If the build says `server.js is not at the root of .next/standalone`

Next infers its file-tracing root by walking up looking for lockfiles and
`package.json` files, and it happily walks past the repo — a stray
`package.json` in your home directory is enough to make your home directory the
root. The standalone output then goes to `.next/standalone/<path-from-root>/`,
so `server.js` lands somewhere like
`.next/standalone/OneDrive/Desktop/linkbio/web/server.js`.

`outputFileTracingRoot` in `next.config.ts` pins it to `web/`, which is what
makes the layout identical on every machine. If you see this error anyway, that
setting is not resolving to `web/` — check that the build is running with `web/`
as its working directory, which `npm run build:lambda` does.

### Build-time versus run-time configuration

This trips people up once, so it is worth being explicit.

Next inlines every `process.env.NEXT_PUBLIC_*` reference as a literal at build
time — in server code as well as client code. A Lambda environment variable
cannot change one afterwards. `.env.local`, which every developer has and which
points at `localhost:8787`, is loaded by `next build` unless something has
already set the variable, so a deploy built on a developer's machine would
otherwise ship a click beacon aimed at their own laptop.

`npm run build:lambda` sets them explicitly for that reason
(`web/scripts/package-lambda.mjs`). In this topology they are all relative
paths, so nothing needs a hostname baked in:

| Value | Set at | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_API_BASE` | build (`/api/proxy`) | The browser never calls the API directly. |
| `NEXT_PUBLIC_BEACON_URL` | build (`/v1/events`) | Same origin, so no CORS. |
| `NEXT_PUBLIC_SITE_ORIGIN` | build, optional | Pass `SITE_ORIGIN=https://…`. Empty means the page falls back to the forwarded viewer host, so canonical URLs are the `*.cloudfront.net` name until there is a domain. **Worth setting once the distribution exists** — `SITE_ORIGIN=$SITE npm run build:lambda` — because it makes the canonical URL and the CSRF fallback deterministic instead of dependent on header forwarding. |
| `API_ORIGIN` | run (stack) | The API function URL's host. |
| `API_AUTH_MODE` | run (stack, `sigv4`) | Signing on. Unset locally. |
| `MAX_S_MAXAGE` | run (stack, `3600`) | Must not exceed the cache policy's 24h `maxTtl`. |

### Stack options

Passed as CDK context, e.g. `npx cdk deploy -c corsOrigins=https://example.com`.

| Context | Effect |
| --- | --- |
| `originSecret` | The shared secret CloudFront presents to both origins. Prefer the `LINKBIO_ORIGIN_SECRET` environment variable; this context key exists for CI systems that only pass arguments. Omitted, the function URLs answer anyone who finds them, and synth says so. |
| `refresherReservedConcurrency` | Concurrent executions reserved for the feed refresher. Off by default, because a reservation must leave 10 unreserved in the account and a new account's whole limit is 10. Set it to `1` once that has been raised, to stop two refresher runs overlapping. |
| `corsOrigins` | Comma-separated exact browser origins allowed to call the API cross-origin. The dashboard is same-origin and needs nothing here; the beacon is a simple request that never preflights. Usually empty. |
| `jwksUrl`, `jwtIssuer`, `jwtAudience` | Hand identity to an external issuer instead of the API's own tokens. `jwtAudience` is required with `jwksUrl` — without it, every token that issuer has ever minted is accepted. |

Set directly on `LinkbioStack` if you need them: `spotifySecretArn`,
`twitchSecretArn`, `githubTokenSecretArn` (Secrets Manager ARNs; omitting one
leaves that feed source reporting itself unconfigured rather than failing the
deploy), `refreshRate`, `webMemorySize`, `webAssetPath`.

### Secrets

`AuthSecret` is generated by CloudFormation — 64 bytes, never in source, never
in a template parameter — and injected into both the API and the refresher. The
refresher does not verify tokens, but `env.ts` parses one schema for the whole
codebase and refuses to boot without a signing secret.

Feed credentials are the only secrets you supply, and only for the two sources
with no anonymous read path:

```bash
aws secretsmanager create-secret --name linkbio/spotify \
  --secret-string '{"clientId":"…","clientSecret":"…"}'
aws secretsmanager create-secret --name linkbio/github \
  --secret-string '{"token":"ghp_…"}'
```

YouTube and RSS need nothing. GitHub works unauthenticated at 60 requests an
hour **per IP, shared across every block in the fleet** — fine for a demo, not
for real traffic.

---

## Verify

`SiteUrl` is a stack output. Everything below is against it.

```bash
SITE=$(aws cloudformation describe-stacks --stack-name Linkbio \
  --query 'Stacks[0].Outputs[?OutputKey==`SiteUrl`].OutputValue' --output text)
```

1. **The API is up.**
   ```bash
   curl -sS "$SITE/health"          # {"ok":true,"ts":…}
   ```

2. **The dashboard is served, and is not cached.**
   ```bash
   curl -sSI "$SITE/login" | grep -i '^cache-control'
   # private, no-store  — if this says anything cacheable, /login matched the
   # default behaviour instead of its own, and sessions will cross-contaminate.
   ```

3. **A static chunk comes from the right behaviour.**
   ```bash
   curl -sSI "$SITE/_next/static/chunks/…js" | grep -i '^x-cache'
   # Miss once, then "Hit from cloudfront".
   ```

4. **Seed a page and click a link.** With `API_ORIGIN` pointed at `$SITE`:
   ```bash
   cd api && API_ORIGIN=$SITE npm run seed
   curl -sSI "$SITE/giorgi"         | grep -iE '^(cache-control|x-route-boundary)'
   curl -sSI "$SITE/r/giorgi/<blockId>" | grep -iE '^(location|cache-control|x-rule-id)'
   ```
   The redirect must be 302 or 307 with an `s-maxage` running to the next rule
   boundary — never 301, which a browser would cache past every TTL this
   endpoint computes.

5. **The edge is actually doing its job.** This is the one thing that has never
   run anywhere, so check it deliberately:
   ```bash
   # a rule-free link: answered at the edge, so no origin request at all
   curl -sSI "$SITE/r/giorgi/<ruleFreeBlockId>" | grep -i '^x-cache'
   # "FunctionGeneratedResponse from cloudfront" means the hot link fired.

   # a geo rule: two different countries must give two different destinations
   curl -sSI -H 'CloudFront-Viewer-Country: DE' "$SITE/r/giorgi/<blockId>"
   ```
   Then confirm the store has what it should:
   ```bash
   aws cloudfront-keyvaluestore list-keys --kvs-arn "$(aws cloudformation \
     describe-stacks --stack-name Linkbio --query \
     'Stacks[0].Outputs[?OutputKey==`KvsArn`].OutputValue' --output text)"
   # mask:giorgi → v<n>|g…   and  hot:giorgi/<blockId> → 302|https://…
   ```

6. **Unpublish, and the page is gone.** `POST /v1/profiles/:id/unpublish`, then
   `/giorgi` should 404 and the `mask:`/`hot:` keys should be gone.

If something is wrong, the Lambda log groups are `ApiLogs`, `WebLogs` and
`FeedRefresherLogs`, all retained a month. Unhandled API errors are logged with
a `requestId` that the response also carries in `x-request-id`.

---

## Alarms

Six, all on the places the code deliberately keeps going after a failure —
which are exactly the places nothing else would ever tell you:

| Alarm | Means |
| --- | --- |
| `ApiErrors` | The API is throwing. |
| `ApiThrottles` | Concurrency limit reached; requests rejected before they run. |
| `Api5xx` | CloudFront serving 5xx for >1% of requests. |
| `WebErrors` | The web app is throwing — a creator page or a dashboard route, not a click. |
| `WebThrottles` | Same, for the web Lambda. |
| `FeedRefresherErrors` | The refresh *loop* is broken. Individual feed failures are backed off per block and logged, not thrown, so this is not "a feed is down". |

None of them notify anywhere. Attach an SNS topic before you rely on them.

---

## Rollback

`npx cdk deploy` is a CloudFormation update and rolls itself back on failure.
For a bad deploy that succeeded, redeploy the previous commit — both Lambdas are
directory assets, so checking out the old tree and rebuilding reproduces the old
functions.

Two things do **not** roll back with the stack and need saying:

- **The table is `RETAIN`.** Destroying the stack leaves it, deliberately. A
  later deploy of the same stack will not adopt it — you get a name clash.
- **The KeyValueStore is rebuilt by publishing, not by CloudFormation.** After a
  rollback that changes the mask format, republish each profile so the edge and
  the rules agree again. Until they do, the origin's staleness check answers
  `no-store`, which is correct but uncached.

---

## What is verified

Run on a clean Linux checkout with fresh installs:

- `api`: typecheck, 418 tests, esbuild bundle.
- `web`: typecheck, 131 unit tests, `next build`, and 13 tests that invoke the
  real `web/dist` bundle through synthetic Lambda Function URL events — page
  rendering, the edge-context contract, the stale-mask refusal, static chunks,
  `Set-Cookie` splitting, and the origin-secret gate.
- `cdk synth`, with the emitted template inspected: behaviour order and
  precedence, origin per behaviour, the IAM grant that lets the web Lambda
  invoke the API's function URL, and the absence of a CloudFormation cycle.

Not verified, because it needs an account:

- Anything CloudFront actually does. The behaviour list is checked as a
  template, not as routing.
- That CloudFront's custom origin header reaches both origins, and that a
  direct hit on a function URL without it is refused. Both sides of the check
  are tested; the header's delivery is not.
- That headers a CloudFront Function adds (`x-ctx`, `x-forwarded-host`) are
  forwarded by the managed all-viewer policy. Standard behaviour, untested here.
- The edge functions running. All 32 masks are unit-tested in
  `api/test/edge.test.ts` and have still never met CloudFront.
- Cold-start times, and therefore whether 1769 MB is the right size for the web
  Lambda.
- The `__Host-` cookie strategy against a real HTTPS hostname.
