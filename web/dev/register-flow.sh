#!/usr/bin/env bash
#
# Walk registration end to end over HTTP, without a browser.
#
#   dev/register-flow.sh [email] [handle]
#
# Useful for checking the backend side of the flow in isolation: the signup
# form and the onboarding screen are thin wrappers over exactly these calls.
# Registration goes straight to the API because it happens in a server action
# before any cookie exists; everything after it goes through /api/proxy, the
# way the browser would.
#
# Every proxied write carries an Origin header. The proxy refuses a write
# without one (app/api/proxy/[...path]/route.ts, isSameOrigin) because the
# session cookie is SameSite=Lax and still rides along on a top-level
# cross-site POST — Origin is the one header an attacker's page cannot forge.
# curl sends none by default, so without this every write here is a 403.

set -euo pipefail

EMAIL="${1:-someone+$(date +%s)@studio.com}"
HANDLE="${2:-newpage$(date +%s | tail -c 5)}"
API="${API:-http://localhost:8787}"
WEB="${WEB:-http://localhost:3000}"

json() { python3 -c "import sys,json;print(json.load(sys.stdin)$1)"; }

# The cookie the proxy reads, and the origin it checks writes against.
auth() { printf '%s' "-b lc_at=$TOKEN"; }
ORIGIN_HEADER="origin: $WEB"

echo "registering $EMAIL"
REGISTER=$(curl -sS -m 10 -X POST -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"averylongpassword\"}" \
  "$API/v1/auth/register")
TOKEN=$(printf '%s' "$REGISTER" | json "['accessToken']")
REFRESH=$(printf '%s' "$REGISTER" | json "['refreshToken']")

echo "session:      $(curl -sS -m 10 $(auth) "$WEB/api/proxy/v1/me")"

echo "handle check: $(curl -sS -m 10 $(auth) "$WEB/api/proxy/v1/handles/$HANDLE")"

# `title`, not `displayName`: ProfileCreate names the field title.
PROFILE=$(curl -sS -m 10 $(auth) -X POST -H 'content-type: application/json' -H "$ORIGIN_HEADER" \
  -d "{\"handle\":\"$HANDLE\",\"title\":\"Test page\"}" \
  "$WEB/api/proxy/v1/profiles" | json "['data']['id']")
echo "created:      $PROFILE at /$HANDLE (draft — publishedVersion is null)"

echo "claim again:  $(curl -sS -m 10 $(auth) -X POST \
  -H 'content-type: application/json' -H "$ORIGIN_HEADER" \
  -d "{\"handle\":\"$HANDLE\",\"title\":\"Someone else\"}" \
  -o /dev/null -w '%{http_code} (409 conflict, not version_conflict — the claim is transactional)' \
  "$WEB/api/proxy/v1/profiles")"

# A link block has to arrive with a target: checkBlockShape refuses one without.
BLOCK=$(curl -sS -m 10 $(auth) -X POST -H 'content-type: application/json' -H "$ORIGIN_HEADER" \
  -H 'if-match: 1' -d '{"kind":"link","label":"My album","target":"https://example.com/album"}' \
  "$WEB/api/proxy/v1/profiles/$PROFILE/blocks")
BLOCK_ID=$(printf '%s' "$BLOCK" | json "['data']['id']")
VERSION=$(printf '%s' "$BLOCK" | json "['version']")
echo "added a link: $BLOCK_ID, profile now at v$VERSION"

# The whole rule set at once. There is no per-rule endpoint.
VERSION=$(curl -sS -m 10 $(auth) -X PUT -H 'content-type: application/json' -H "$ORIGIN_HEADER" \
  -H "if-match: $VERSION" \
  -d '[{"id":"r_eu","priority":10,"when":[{"dim":"geo","in":["eu"]}],"then":{"kind":"redirect","target":"https://example.com/eu","status":302}}]' \
  "$WEB/api/proxy/v1/profiles/$PROFILE/blocks/$BLOCK_ID/rules" | json "['version']")
echo "added a rule: profile now at v$VERSION"

echo "stale write:  $(curl -sS -m 10 $(auth) -X PATCH \
  -H 'content-type: application/json' -H "$ORIGIN_HEADER" -H 'if-match: 1' \
  -d '{"title":"Stale"}' -o /dev/null -w '%{http_code} (409 version_conflict — If-Match is enforced)' \
  "$WEB/api/proxy/v1/profiles/$PROFILE")"

echo "before publish, /$HANDLE: $(curl -sS -m 10 -o /dev/null -w '%{http_code} (404 — a draft is not a page)' "$WEB/$HANDLE")"

VERSION=$(curl -sS -m 10 $(auth) -X POST -H "$ORIGIN_HEADER" -H "if-match: $VERSION" \
  "$WEB/api/proxy/v1/profiles/$PROFILE/publish" | json "['version']")
echo "published:    now at v$VERSION"

# Rotation: the token that was just used is spent, and using it twice revokes
# every session for the account.
echo "refresh:      $(curl -sS -m 10 -X POST -H 'content-type: application/json' \
  -d "{\"refreshToken\":\"$REFRESH\"}" -o /dev/null -w '%{http_code} (rotates — the response carries a new refresh token)' \
  "$API/v1/auth/refresh")"
echo "reuse it:     $(curl -sS -m 10 -X POST -H 'content-type: application/json' \
  -d "{\"refreshToken\":\"$REFRESH\"}" -o /dev/null -w '%{http_code} (401 — reuse revokes the session)' \
  "$API/v1/auth/refresh")"

echo
echo "public page at $WEB/$HANDLE:"
curl -sS -m 10 "$WEB/$HANDLE" \
  | grep -oE 'class="(name|block-label|block-meta)">[^<]*' \
  | sed 's/class="/  /;s/">/: /'
