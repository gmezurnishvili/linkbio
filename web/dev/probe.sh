#!/usr/bin/env bash
#
# Probe the public page as different visitors.
#
#   dev/probe.sh [handle] [origin]
#
# Visitor context is derived entirely from request headers, so curl can be any
# visitor you like without a VPN, a device lab, or waiting until Saturday
# night. That is the whole reason the derivation lives in
# lib/context/visitor.ts and not in the browser.
#
# What to watch:
#   s-maxage        should equal the next instant a decision changes, so it
#                   moves as you cross a time window, and sits at the ceiling
#                   when no time rule applies
#   vary            should list only the dimensions the rules actually read
#   blocks          should differ between rows that differ by context
#
# Note that nothing caches locally. This shows what CloudFront would be told,
# not what it would do. For that, deploy or point a caching proxy at :3000.

set -euo pipefail

HANDLE="${1:-giorgi}"
ORIGIN="${2:-http://localhost:3000}"
URL="$ORIGIN/$HANDLE"

probe() {
  local label="$1"; shift
  local headers_file body_file
  headers_file=$(mktemp)
  body_file=$(mktemp)

  curl -sS -m 10 -D "$headers_file" -o "$body_file" "$@" "$URL"

  local status s_maxage vary blocks
  status=$(head -1 "$headers_file" | awk '{print $2}')
  s_maxage=$(grep -io 's-maxage=[0-9]*' "$headers_file" | head -1 | cut -d= -f2 || true)
  vary=$(grep -i '^vary:' "$headers_file" | grep -iv 'rsc' | cut -d' ' -f2- | tr -d '\r' || true)
  # Labels alone hide the two most interesting effects: a rewritten
  # destination and a feed that only some visitors get. Pull hosts and feed
  # titles too.
  blocks=$(grep -oE 'class="(block-label|block-meta|feed-title)">[^<]*' "$body_file" \
    | sed -e 's/class="feed-title">/feed:/' \
          -e 's/class="block-meta">/ -> /' \
          -e 's/class="block-label">//' \
    | tr '\n' ' ' | sed 's/  */ /g; s/^ //; s/ $//' || true)

  printf '%-26s %s  s-maxage=%-6s %s\n' "$label" "$status" "${s_maxage:-—}" "${blocks:-no blocks}"
  if [ -n "$vary" ]; then
    printf '%-26s %s\n' "" "vary: $vary"
  fi

  rm -f "$headers_file" "$body_file"
}

echo "probing $URL"
echo

probe "no context" \
  -H 'user-agent: curl/8'

probe "US · iPhone" \
  -H 'cloudfront-viewer-country: US' \
  -H 'cloudfront-is-mobile-viewer: true' \
  -H 'user-agent: Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'

probe "US · Android" \
  -H 'cloudfront-viewer-country: US' \
  -H 'cloudfront-is-mobile-viewer: true' \
  -H 'user-agent: Mozilla/5.0 (Linux; Android 14) Chrome/120'

probe "DE · desktop" \
  -H 'cloudfront-viewer-country: DE' \
  -H 'cloudfront-is-desktop-viewer: true' \
  -H 'accept-language: de-DE,de;q=0.9' \
  -H 'user-agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'

probe "GE · from Instagram" \
  -H 'cloudfront-viewer-country: GE' \
  -H 'cloudfront-is-mobile-viewer: true' \
  -H 'referer: https://www.instagram.com/' \
  -H 'user-agent: Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Instagram 300.0'

echo
echo "handles that must not resolve to a creator page:"
# /app and /login are real routes, so they answer 200 or redirect. Everything
# else in this list is either reserved or malformed and must 404.
for path in admin _next "bad..handle" "giorgi." "-giorgi" "x"; do
  printf '  %-16s %s\n' "$path" "$(curl -sS -m 10 -o /dev/null -w '%{http_code}' "$ORIGIN/$path")"
done
printf '  %-16s %s (redirects to sign-in, as it should)\n' "app" \
  "$(curl -sS -m 10 -o /dev/null -w '%{http_code}' "$ORIGIN/app")"

echo
echo "agent identity:"
curl -sS -m 10 "$URL/identity.json" | head -c 400
echo
