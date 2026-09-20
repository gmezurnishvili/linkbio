# Running linkbio locally

> Deploying to AWS is a different document: **`DEPLOYING.md`**. This one is the
> local loop.

Your machine: Node v22.23.2, npm 10.9.8, Windows. Both are fine — nothing below
needs a version bump.

---

## One-time setup

```powershell
cd C:\Users\gmezu\OneDrive\Desktop\linkbio

cd api
npm install                 # required — I added aws-cdk-lib, constructs, aws-cdk
copy .env.example .env

cd ..\web
npm install                 # no new dependencies, but harmless
copy .env.example .env.local
```

`web\.env.local` is now correct — it used to point the click beacon at
`/v1/beacon`, a path that has never existed on the backend, and since Next gives
`.env.local` precedence over `.env` that was the value the browser got. Nothing
to do by hand.

---

## Running it

Two terminals.

```powershell
# terminal 1 — the API
cd C:\Users\gmezu\OneDrive\Desktop\linkbio\api
npm run dev
# listening on http://localhost:8787 (driver=memory)
```

```powershell
# terminal 2 — the dashboard and public pages
cd C:\Users\gmezu\OneDrive\Desktop\linkbio\web
npm run dev
# http://localhost:3000
```

`npm run dev` loads `.env` itself now, so there is nothing to export and the
same command works in PowerShell, cmd and bash. Previously the README told you
to write `DB_DRIVER=memory AUTH_SECRET=... npm run dev`, which is bash syntax
and silently does nothing useful in PowerShell.

If `.env` is missing or wrong the API refuses to start and names the key:

```
Error: invalid configuration
  AUTH_SECRET: Set AUTH_SECRET (or JWKS_URL, or DEV_JWT_SECRET outside production).
```

Data lives in memory, so restarting the API wipes every account and page. That
is what `DB_DRIVER=memory` means; there is no database to install.

With `DB_DRIVER=memory` the API also runs the feed refresher in-process, once a
minute. In production that is a separate Lambda on a schedule reading the same
DynamoDB rows; against memory there is no shared table, so a separate process
would scan its own empty heap and a feed block could never fill. Set
`FEED_REFRESH_INTERVAL_MS=0` to turn it off.

---

## A page to look at

```powershell
cd api
npm run seed
```

Registers `demo@linkbio.local` / `demo-password-1234`, builds `/giorgi` with
four blocks and four rules — one geo, one device, one time window, one RSS feed
— and publishes it. Re-running it signs in rather than re-registering and leaves
existing blocks alone.

This exists so the real backend is demoable. The seeded page inside
`web/dev/mock-api.mjs` used to be the only one in the repository, which made the
mock the easiest way to evaluate the product on the one path whose rule
evaluation is a documented approximation.

---

## Then, in the browser

1. `http://localhost:3000/signup` — any email and a password of 8+ characters.
2. `/app/new` — pick a handle. Availability is checked as you type.
3. `/app/<id>` — add a block or two, open one and add a rule. A block also
   carries an icon, a visibility toggle and a "when it's up" window; a feed
   block has a **Fetch now** button rather than waiting on the schedule.
4. **Publish.** This matters now: a page with `publishedVersion: null` is a
   draft and `/<handle>` returns 404 until you publish it. The editor says so.
5. `/<handle>` — the public page, or "View live" in the header. Every link on
   it goes through `/r/<handle>/<blockId>`, which evaluates the rules for that
   visitor and 302s. In production CloudFront routes `/r/*` to the API origin
   directly; the Next route handler is what makes it work anywhere else.
6. The handle in the top-left is a switcher: it lists every page on the account
   and carries **+ New page**. Sign out is next to Publish, and Settings holds
   unpublish, sign-out-everywhere and delete.

---

## Against the mock instead

```powershell
cd web
npm run dev:mock        # mock API on 8787, Next on 3000
```

Sign in there with `you@studio.com` and any password to get its seeded profile.

Prefer the real backend with `npm run seed` now. The mock implements the
contract closely but its rule evaluation is an approximation that errs
optimistic — see the header of `dev/mock-api.mjs` — and it has not grown the
newer routes, so sign-out, unpublish, delete and "fetch now" 404 against it.

---

## Checking it without a browser

```bash
# in web/, from Git Bash or WSL
bash dev/register-flow.sh
```

Runs signup → handle claim → block → rule → stale-write → publish → public page
and prints what each step returned. Against the real backend it looks like this:

```
created:      prof_… at /newpage8846 (draft — publishedVersion is null)
claim again:  409 (conflict, not version_conflict — the claim is transactional)
added a link: blk_…, profile now at v2
added a rule: profile now at v3
stale write:  409 (version_conflict — If-Match is enforced)
before publish, /newpage8846: 404 (a draft is not a page)
published:    now at v4
refresh:      200 (rotates — the response carries a new refresh token)
reuse it:     401 (reuse revokes the session)
```

`bash dev/probe.sh` sends the same page through six visitor contexts and prints
the `s-maxage` and destination each one gets. It expects a published profile at
`/giorgi`, so run it against the mock, or create that handle yourself first.

---

## Tests and checks

```powershell
cd api
npm test            # 413 tests
npm run typecheck   # covers src/, test/ and infra/
npx cdk synth       # the stack actually synthesizes now

cd ..\web
npm test            # vitest; needs a node_modules installed for this OS
npm run typecheck
```

All of these pass as of now. None of them need AWS or the network.

---

## If something goes wrong

**`npm run dev` in api exits immediately with "invalid configuration".** You
have no `.env`, or a value in it is wrong. The message names the key.

**Port 8787 or 3000 already in use.** A previous run is still alive:
`netstat -ano | findstr :8787` then `taskkill /PID <pid> /F`.

**The dashboard loads but every action fails with 401.** The API restarted and
took the in-memory accounts with it. Sign up again.

**`/<handle>` returns 404 for a page you can see in the editor.** It is a draft.
Publish it.

**Next crashes on startup complaining about `@next/swc`.** That happens if
`node_modules` was installed on a different OS. Delete `web\node_modules` and
`npm install` again. Your current install is Windows-native and correct — this
only bites if you move the folder to WSL, a container or CI.

**`next build` fails on fonts.** I could not verify a production build; it fails
in my sandbox fetching Google Fonts, which has no egress there. `next dev`
renders every route and typecheck is clean, but run `npm run build` yourself
before you ship anything.
