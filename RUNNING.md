# Running linkbio locally

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

**Do the `copy .env.example .env.local` step even though `web\.env.local`
already exists.** The existing one still points the click beacon at
`/v1/beacon`, a path that has never existed on the backend, so every beacon
404s. I fixed `.env.example` and the in-code default but the file tooling
refuses to write `.env.local`, so that one line is yours. Overwrite the file, or
just change the one line to:

```
NEXT_PUBLIC_BEACON_URL=http://localhost:8787/v1/events
```

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

---

## Then, in the browser

1. `http://localhost:3000/signup` — any email and a password of 8+ characters.
2. `/app/new` — pick a handle. Availability is checked as you type.
3. `/app/<id>` — add a block or two, open one and add a rule.
4. **Publish.** This matters now: a page with `publishedVersion: null` is a
   draft and `/<handle>` returns 404 until you publish it. The editor says so.
5. `/<handle>` — the public page, or "View live" in the header.

---

## Against the mock instead

```powershell
cd web
npm run dev:mock        # mock API on 8787, Next on 3000
```

The mock now implements the same contract as the real backend — same paths, same
`{ data, version, cacheDimensions }` envelope, same two flavours of 409, same
refresh-token rotation. The two are interchangeable. It also ships a seeded
`/giorgi` profile with rules already set up, which the real backend does not,
so it is the faster way to see the simulator do something.

Sign in there with `you@studio.com` and any password to get the seeded profile.

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
npm test            # 331 tests
npm run typecheck   # covers src/, test/ and infra/
npx cdk synth       # the stack actually synthesizes now

cd ..\web
npm test            # 86 tests
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
