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

set -euo pipefail

EMAIL="${1:-someone+$(date +%s)@studio.com}"
HANDLE="${2:-newpage$(date +%s | tail -c 5)}"
API="${API:-http://localhost:8787}"
WEB="${WEB:-http://localhost:3000}"

json() { python3 -c "import sys,json;print(json.load(sys.stdin)$1)"; }

echo "registering $EMAIL"
TOKEN=$(curl -sS -m 10 -X POST -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"averylongpassword\"}" \
  "$API/v1/auth/register" | json "['accessToken']")

echo "session:      $(curl -sS -m 10 -b "lc_at=$TOKEN" "$WEB/api/proxy/v1/me")"

echo "handle check: $(curl -sS -m 10 -b "lc_at=$TOKEN" "$WEB/api/proxy/v1/handles/$HANDLE")"

PROFILE=$(curl -sS -m 10 -b "lc_at=$TOKEN" -X POST -H 'content-type: application/json' \
  -d "{\"handle\":\"$HANDLE\",\"displayName\":\"Test page\"}" \
  "$WEB/api/proxy/v1/profiles" | json "['id']")
echo "created:      $PROFILE at /$HANDLE"

echo "claim again:  $(curl -sS -m 10 -b "lc_at=$TOKEN" -X POST \
  -H 'content-type: application/json' \
  -d "{\"handle\":\"$HANDLE\",\"displayName\":\"Someone else\"}" \
  -o /dev/null -w '%{http_code} (409 means the claim is transactional)' \
  "$WEB/api/proxy/v1/profiles")"

curl -sS -m 10 -b "lc_at=$TOKEN" -X POST -H 'content-type: application/json' \
  -H 'if-match: 1' -d '{"kind":"link","label":"My album","url":"https://example.com/album"}' \
  -o /dev/null "$WEB/api/proxy/v1/profiles/$PROFILE/blocks"
echo "added a link"

echo
echo "public page at $WEB/$HANDLE:"
curl -sS -m 10 "$WEB/$HANDLE" \
  | grep -oE 'class="(name|block-label|block-meta)">[^<]*' \
  | sed 's/class="/  /;s/">/: /'
