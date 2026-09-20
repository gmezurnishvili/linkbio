# linkbio — what is mocked, what is missing

Second audit, September 2026, written after closing the first one's Tranche 0
and most of Tranche 1. Analytics is out of scope by request: the beacon,
`recordEvents`, the daily rollups and `GET /v1/profiles/:id/analytics` all exist
and nothing reads them. That is a known and accepted hole.

Gates: api `npm test` **418 passing**, `tsc --noEmit` clean. web `tsc --noEmit`
clean, `vitest` **131 passing**, `next build` clean, `cdk synth` clean. All five
now run on a clean Linux checkout with fresh installs, and on CI — the earlier
note that `vitest` and `next build` could not be run from this side was an
artefact of sharing a Windows `node_modules`, not a code defect, and is gone.

The short version has changed twice. The happy path became real last round: a
stranger can sign up, build a page, publish it, and every link on it resolves.
This round the production topology was decided and built (3.1), so the repo is
deployable — see `DEPLOYING.md`. What is left is the account subsystem, a
domain, and actually running `cdk deploy`.

---

## Part 1 — What was closed

### The four blockers from the first audit

- **Every published link 404ed.** `resolveProfile` emits
  `href: /r/<handle>/<blockId>` and nothing served that path. There is now a
  Next route handler at `web/src/app/r/[handle]/[blockId]/route.ts` that
  forwards the viewer signals `viewerCtx` reads, calls the API redirector with
  `redirect: "manual"`, and passes the status, `Location` and computed
  `cache-control` straight through. **This is a working shim, not the intended
  production topology** — see 3.1.
- **The click beacon 404ed locally.** `web/.env.local` pointed at `/v1/beacon`.
  Fixed to `/v1/events`.
- **Feed blocks could never fill.** Two things: `POST
  /v1/profiles/:id/blocks/:blockId/refresh` calls the same `refreshBlock` the
  scheduler calls and returns the outcome with the block, wired to a **Fetch
  now** button; and `src/local.ts` runs the refresher in-process, once a minute,
  when `DB_DRIVER=memory` (`FEED_REFRESH_INTERVAL_MS=0` disables it). The
  editor's feed panel also shows `feedError` and `feedFailures`, which the
  client adapter was dropping on the floor.
- **No way to sign out.** `POST /v1/auth/logout` consumes the presented refresh
  token; `POST /v1/auth/logout/all` is authenticated and calls the
  `revokeRefreshTokens` that had no route. On the web side `/logout` is a route
  handler, because the refresh token is httpOnly and no browser script can read
  it; it answers 303 rather than Next's 307, which would re-POST to `/login`.

### Surfaces that existed everywhere except the UI

| Was | Now |
|---|---|
| `avatarUrl` validated, rendered, `og:image`, JSON-LD — no control | URL field in Settings with a preview. Not an upload: there is no object store and nothing issues a signed PUT, so an upload button would be one that cannot work |
| Block `icon` returned by the resolver, never printed | Field in the block sheet, rendered as `.block-icon` on the public page and beside the label in the editor, `aria-hidden` in both |
| `activeFrom`/`activeUntil` evaluated, TTL runs to the boundary, 69 tests — no control | "When it's up" in the block sheet. Both bounds are now nullable on the wire, so a window can be cleared as well as set |
| Page mode: 3 buttons, 1 worked | `mode` is a real column. Drop is distinguishable from Event, and Standard sends `eventAt: null` |
| `DELETE /v1/profiles/:id` worked, our own proxy 404ed it | In the allowlist, with a type-the-handle confirmation in Settings |
| `retractRouting` only reachable by deleting the page | `POST /v1/profiles/:id/unpublish`. Retracts the edge first, then nulls `publishedVersion`; the draft survives |
| One page per user, forever | `/app/new` no longer redirects away, and the handle in the publish bar is a switcher carrying **+ New page** |
| No seed data outside the mock | `npm run seed` in `api/` builds `/giorgi` — four blocks, four rules across geo, device and time, one RSS feed — against the real API over HTTP |

Also: `robots.txt` and a favicon, the 404 page links to `/signup`, the signup
form's password minimum is 8 to match `Credentials` and the docs, and `/login`
acknowledges a completed sign-out.

---

## Part 2 — Still mocked or inert

### 2.1 `dev/mock-api.mjs` — a second backend, 830 lines

Unchanged, and now further behind: it has none of the routes added above, so
sign-out, unpublish, delete and "fetch now" 404 against it. Its three
divergences all lean optimistic (`cacheable` always true, `sMaxAge` found by
minute-scanning, DST ambiguity left to `Intl`).

With `npm run seed` there is no longer a reason to evaluate the product on it.
**Recommendation: delete it.** It is 830 lines of second implementation whose
only remaining advantage — running the frontend with no backend — is worth less
than the risk of someone judging cache behaviour on it.

### 2.2 The edge is real code that has never run

`publishRouting` returns early whenever `KVS_ARN` is empty, which is still every
environment that exists. `edge/normalize.js`, the mask contract and all 32 masks
in `test/edge.test.ts` are unit-tested and have never met CloudFront. The first
`cdk deploy` is where you find out whether the KeyValueStore ETag handling and
the `x-authorization` copy work together.

### 2.3 `estimateVariants`

An upper bound by construction — named values plus a fallthrough bucket —
labelled "up to N cached copies". Honest, and it cannot become a measurement
until there is traffic.

---

## Part 3 — Still missing

### 3.1 The production topology — decided and built

**Closed.** The web app is now the distribution's default origin, with `/r/*`,
`/p/*`, `/v1/*` and `/health` as behaviours on the API. A click no longer
touches the Next Lambda, so `HOT_LINKS` and the edge function's `/r/` branch are
reachable for the first time. `DEPLOYING.md` has the behaviour table and the
reasoning; the pieces that did not exist before are:

- `web/lambda/handler.mjs` — Function URL events to the Next standalone server,
  in place of the AWS Lambda Web Adapter layer. Sixty lines, no region-pinned
  layer ARN, no `run.sh` needing an exec bit that a Windows checkout would drop,
  and exercised against the real bundle in `web/test/lambda-handler.test.mjs`.
- `web/scripts/package-lambda.mjs` — builds with the `NEXT_PUBLIC_*` values
  pinned, so an artifact does not inherit whoever's `.env.local` built it, and
  assembles `web/dist`. `next.config.ts` also pins `outputFileTracingRoot`:
  without it Next walks up past the repo looking for lockfiles — a stray
  `package.json` in a home directory is enough — and writes `server.js` to
  `.next/standalone/<path-from-root>/`, where nothing that consumes it looks.
- `api/edge/page.js` — the root-path twin of `normalize.js`. `/<handle>` is one
  path segment, which `normalize.js` returns early on, so the public page would
  otherwise have been cached on path alone while the origin varied by viewer.
  It also copies the viewer's Host into `x-forwarded-host`, because a function
  URL origin never sees it.
- `web/src/lib/context/edge-ctx.ts` — the page resolves against `x-ctx` rather
  than re-deriving context from raw headers, and refuses to be cached under a
  key built from a mask older than the profile. Both are what
  `api/src/routes/public.ts` already did for its two routes.
- `web/src/lib/site/public-origin.ts` — behind a function URL `request.url` is
  a hostname no visitor typed, so the canonical URL named the wrong host and,
  worse, the same-origin check on every write compared against it and would have
  refused every save in the dashboard. One helper resolves the real origin from
  the forwarded viewer host; both callers use it.
- **Origin access is a shared secret, not OAC.** Origin Access Control cannot
  front a function URL that browsers post to: a signed request must carry its
  own body hash in `x-amz-content-sha256`, computed by the viewer, and Lambda
  refuses `UNSIGNED-PAYLOAD`, so every form post and every beacon is a 403 while
  GETs look fine. The first deploy found this. Both function URLs are now
  `authType: NONE` with a CloudFront custom origin header both Lambdas require
  (`-c originSecret=…`); a SigV4 signer written for the IAM path was deleted
  with it.

Still dead: `linkBlock`'s fallback `href` of `/<handle>/l/<slug>`. No
route, nothing sets `slug`, and it only fires when `href` is absent — which it
never is.

### 3.2 The account subsystem

Deferred by decision this round: own auth, email later. What that leaves open:

- **Password reset.** Nothing. No token table, no route, and no email transport
  anywhere in the stack — verified: no SES, nodemailer, resend, sendgrid or
  postmark. A user who forgets their password has no recovery path.
- **Email verification.** Same dependency. Anyone can register any address.
- **Change password / change email.** No routes.
- **Account deletion.** Page delete exists; user delete does not. `GET /v1/me`
  already handles the "token for a deleted user" case, so half the thinking is
  done.
- **Session list.** "Sign out everywhere" now exists, which is the whole of the
  recovery story for a leaked token; there is still no list to revoke *from*.

Worth deciding before building any of it whether you own identity at all.
`env.ts` already carries the `JWKS_URL` / `JWT_ISSUER` / `JWT_AUDIENCE` path for
an external issuer, and taking it deletes most of this section.

### 3.3 Pages

- **No revert.** `publishedVersion` records what is live; there is no way to
  discard a draft and go back to it. Unpublish is not the same thing.
- **No shareable draft preview.** The simulator is in-dashboard only.

### 3.4 Public page polish

- No sitemap. `robots.txt` exists now and allows profile pages.
- No OG image generation. With an avatar set there is an `og:image`; without
  one a shared link is still a bare text card, and `twitter:card` is `summary`.
- No dark mode for the dashboard. The public themes have it.

### 3.5 Delivery and operations

- ~~**The web app has no deployment.**~~ **Closed** — see 3.1. CDK now covers
  the web Lambda, its function URL with OAC, a third CloudFront Function, three
  more origin request policies, the behaviour split and two more alarms.
- **No domain.** No ACM certificate, no Route 53, no alternate domain name. The
  `__Host-` cookie strategy and the "same apex serves creator content" threat
  model in `session.ts` are both untested against a real hostname.
- ~~**No CI.**~~ **Closed.** `.github/workflows/ci.yml` runs both typechecks,
  both suites, both bundles, the Lambda handler tests against the real build,
  and `cdk synth`, on every push and pull request.
- ~~**`next build` unverified.**~~ **Closed** — it passes, and CI runs it.
- **Static assets are served by the web Lambda**, cached at the edge behind
  `/_next/static/*` with the managed optimized policy. Correct and simple, but
  an S3 origin for that behaviour is the obvious next optimisation and was left
  out deliberately: an empty bucket fails as a silently broken dashboard, and
  nothing here can be deploy-tested yet.
- **The account's Lambda concurrency limit.** A new AWS account allows 10
  concurrent executions in total, shared by the web Lambda, the API and the
  refresher. Enough to deploy and try; not enough to serve traffic, and it is
  why nothing in the stack reserves concurrency by default.
- **No hermetic local environment.** No Dockerfile, no compose file, no DynamoDB
  Local, so the `dynamo` driver cannot be exercised without an AWS account and
  `memory` loses every account on restart.
- **No tracing or error reporting.** Structured `console` JSON and three
  CloudWatch alarms. No X-Ray, no Sentry, no correlation past `requestId`.
- **Feed credentials unset.** `SPOTIFY_*` and `TWITCH_*` are absent, so those
  two adapters report `unconfigured` by design — the refresh route surfaces that
  as an operator problem rather than blaming the creator. `youtube` and `rss`
  need nothing; `github` works unauthenticated at 60 req/hour per IP shared
  across the fleet, which is a development-only rate.

---

## Part 4 — Suggested order from here

**Next.** `cdk bootstrap`, then `cdk deploy`, then work down the verification
list in `DEPLOYING.md`. That is the step that turns unit-tested edge code into
working edge code, and it is the only way to learn whether OAC, the SigV4 call
and the KeyValueStore ETag handling behave — none of which can be checked from
here.

**Then, pick one:**

1. **A domain and a certificate.** The `__Host-` cookie strategy and the "same
   apex serves creator content" threat model in `session.ts` are both untested
   against a real hostname, and canonical URLs are the `*.cloudfront.net` name
   until this exists.
2. **The account subsystem.** Decide own-identity versus Cognito first; the
   answer changes the size of this from "a week" to "an afternoon".

**Deferred by decision:** analytics, custom domains, OG image generation, dark
mode for the dashboard, revert.
