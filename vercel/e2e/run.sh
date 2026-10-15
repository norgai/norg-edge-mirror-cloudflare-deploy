#!/usr/bin/env bash
# End-to-end: the packed package inside a real Next.js app.
#
# Packs vercel/ exactly as npm would publish it, installs the tarball into the
# fixture app (e2e/app), runs `next build` and `next start` against a mock
# NORG, and asserts on real HTTP responses: people and search engines are
# untouched and the app's own middleware still runs; a verified agent gets the
# render, or the stripped page on a miss; an unverified agent is untouched;
# llms.txt and the health probe are answered; a heartbeat reaches NORG.
#
# VERCEL=1 makes the package trust x-real-ip as it would on a Vercel
# deployment, so curl can present a verified (or unverified) agent address.
#
# Usage: bash vercel/e2e/run.sh   (needs node, pnpm, curl)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="$(dirname "$HERE")"
WORK="$(mktemp -d)"
APP_PORT=3917
NORG_PORT=3918
LOG="$WORK/norg.log"
PIDS=()
# Each server runs in its own process group (setsid): `next start` forks a
# next-server child that outlives a plain kill of its parent and holds the port.
cleanup() { for p in "${PIDS[@]}"; do kill -- "-$p" 2>/dev/null || kill "$p" 2>/dev/null || true; done; rm -rf "$WORK"; }
trap cleanup EXIT

FAILS=0
check() { # name, expected, actual
  if [[ "$3" == "$2" ]]; then echo "ok   $1"; else echo "FAIL $1: expected [$2] got [$3]"; FAILS=$((FAILS + 1)); fi
}
header() { # url, header, curl args...
  local url="$1" name="$2"; shift 2
  curl -s -o /dev/null -D - "$@" "$url" | tr -d '\r' | awk -v h="$name" 'tolower($1)==tolower(h)":" {print $2}'
}

CHROME="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36"
GPTBOT="Mozilla/5.0 (compatible; GPTBot/1.1; +https://openai.com/gptbot)"
GOOGLE="Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"
BASE="http://127.0.0.1:$APP_PORT"

echo "== pack"
(cd "$PKG" && npm pack --silent --pack-destination "$WORK" >/dev/null)
TARBALL="$(ls "$WORK"/norg-ai-edge-router-vercel-*.tgz)"

echo "== install + build"
cp -r "$HERE/app" "$WORK/app"
cd "$WORK/app"
pnpm add "$TARBALL" --silent >/dev/null
NEXT_TELEMETRY_DISABLED=1 pnpm build >"$WORK/build.log" 2>&1 || { tail -40 "$WORK/build.log"; exit 1; }

echo "== start"
setsid node "$HERE/mock-norg.mjs" "$NORG_PORT" "$LOG" & PIDS+=($!)
VERCEL=1 NORG_SITE_ID=e2e-site NORG_SITE_KEY=nek_live_e2e NORG_EDGE_ENV=test \
  NORG_API_URL="http://127.0.0.1:$NORG_PORT" NORG_CONTENT_BASE="http://127.0.0.1:$NORG_PORT" \
  NEXT_TELEMETRY_DISABLED=1 setsid ./node_modules/.bin/next start -p "$APP_PORT" >"$WORK/app.log" 2>&1 & PIDS+=($!)
for _ in $(seq 1 60); do curl -s -o /dev/null "$BASE/" && break; sleep 0.5; done

echo "== assertions"
check "person: no NORG header" "" "$(header "$BASE/products/widget" x-norg-edge -A "$CHROME")"
check "person: app middleware still runs" "1" "$(header "$BASE/products/widget" x-app-middleware -A "$CHROME")"
check "search engine: no NORG header" "" "$(header "$BASE/products/widget" x-norg-edge -A "$GOOGLE" -H "x-real-ip: 20.171.5.9")"
check "verified agent: render" "mirror" "$(header "$BASE/products/widget" x-norg-edge -A "$GPTBOT" -H "x-real-ip: 20.171.5.9")"
check "verified agent: render body" "1" "$(curl -s -A "$GPTBOT" -H "x-real-ip: 20.171.5.9" "$BASE/products/widget" | grep -c 'NORG render of widget')"
check "verified agent: miss is stripped" "stripped" "$(header "$BASE/products/fresh" x-norg-edge -A "$GPTBOT" -H "x-real-ip: 20.171.5.9")"
check "unverified agent: untouched" "" "$(header "$BASE/products/widget" x-norg-edge -A "$GPTBOT" -H "x-real-ip: 8.8.8.8")"
check "llms.txt from NORG" "mirror" "$(header "$BASE/llms.txt" x-norg-edge -A "$CHROME")"
PROBE="$(curl -s -H "x-norg-edge-check: nek_live_e2e" "$BASE/")"
check "health probe: platform" "vercel" "$(node -p "JSON.parse(process.argv[1]).platform" "$PROBE")"
check "health probe: entitled" "true" "$(node -p "JSON.parse(process.argv[1]).entitled" "$PROBE")"
sleep 1
check "heartbeat reached NORG" "1" "$(grep -c '"url":"/api/v1/edge/heartbeat"' "$LOG" | tr -d ' ' | sed 's/^[1-9][0-9]*$/1/')"
check "receptionist got a visit header" "1" "$(grep -c 'x-norg-visit' "$LOG" | sed 's/^[1-9][0-9]*$/1/')"

if [[ $FAILS -gt 0 ]]; then
  echo "== $FAILS failed; app log:"; tail -30 "$WORK/app.log"; exit 1
fi
echo "== all passed"
