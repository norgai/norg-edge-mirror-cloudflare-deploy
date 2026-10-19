#!/usr/bin/env bash
# End-to-end suite: a real WordPress (SQLite, PHP built-in server) with the plugin, against a mock NORG.
#
# Usage: run.sh <work-dir>   (run setup.sh <work-dir> first)
# Exercises every branch of the request pipeline over real HTTP, both rules,
# revocation, outage, capture mode, the self-check and WP-CLI.
set -uo pipefail

WORK="$1"
HERE="$(cd "$(dirname "$0")" && pwd)"
WP_DIR="$WORK/site"
PORT="${WP_PORT:-8889}"
MOCK_PORT="${MOCK_PORT:-8890}"
BASE="http://127.0.0.1:$PORT"
export MOCK_SITE_ID="${MOCK_SITE_ID:-9f1c2e4a-1111-4222-8333-444455556666}"
export MOCK_SITE_KEY="${MOCK_SITE_KEY:-nek_live_e2eTestKeyAAAAAAAAAAAAAAAAAAAAAA}"
export MOCK_LOG="$WORK/mock.jsonl" MOCK_STATE="$WORK/state"
PHP_BIN="${PHP_BIN:-$(command -v php)}"
GPT="Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)"
CLAUDE="Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)"
GOOGLE="Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"
BROWSER="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36"
PASS=0; FAIL=0; H="$WORK/h.txt"; B="$WORK/b.txt"; MOCK_PID=""; WP_PID=""

start_mock() { MOCK_FEED_TTL="${1:-3600}" nohup "$PHP_BIN" -d opcache.enable_cli=0 -S "127.0.0.1:$MOCK_PORT" "$HERE/mock-norg.php" >"$WORK/mock.out" 2>&1 & MOCK_PID=$!; bound "$WORK/mock.out"; }
stop_mock() { [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null; wait "$MOCK_PID" 2>/dev/null; MOCK_PID=""; }
# A server that cannot bind would leave requests to whatever already holds the port.
bound() { sleep 0.7; if grep -q "Failed to listen" "$1"; then echo "port in use: $(cat "$1")" >&2; exit 2; fi; }
start_wp() { PHP_CLI_SERVER_WORKERS=4 nohup "$PHP_BIN" -d opcache.enable_cli=0 -S "127.0.0.1:$PORT" -t "$WP_DIR" "$HERE/wp-router.php" >"$WORK/wp.out" 2>&1 & WP_PID=$!; bound "$WORK/wp.out"; }
# PHP_CLI_SERVER_WORKERS forks children that keep listening after the parent dies.
stop_wp() { [ -n "$WP_PID" ] && { pkill -P "$WP_PID" 2>/dev/null; kill "$WP_PID" 2>/dev/null; }; }
cleanup() { stop_mock; stop_wp; }
trap cleanup EXIT

ok() { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31m✗ %s\033[0m\n' "$1"; [ -n "${2:-}" ] && printf '      %s\n' "$2"; }
req() { local ua="$1" path="$2"; shift 2; : >"$MOCK_LOG"; curl -s -D "$H" -o "$B" -A "$ua" "$@" "$BASE$path"; sleep "${SETTLE:-0.3}"; }
hdr() { grep -i "^$1:" "$H" | head -1 | cut -d' ' -f2- | tr -d '\r'; }
status() { head -1 "$H" | awk '{print $2}'; }
expect_edge() { local got; got="$(hdr X-Norg-Edge)"; [ "$got" = "$2" ] && ok "$1" || bad "$1" "X-Norg-Edge='$got' want '$2' (HTTP $(status))"; }
expect_hdr() { local got; got="$(hdr "$2")"; [[ "$got" == *"$3"* ]] && ok "$1" || bad "$1" "$2='$got' want *$3*"; }
expect_body() { grep -q -- "$2" "$B" && ok "$1" || bad "$1" "body lacks '$2': $(head -c 160 "$B")"; }
expect_no_body() { if grep -q -- "$2" "$B"; then bad "$1" "body has '$2'"; else ok "$1"; fi; }
expect_status() { [ "$(status)" = "$2" ] && ok "$1" || bad "$1" "HTTP $(status) want $2"; }
# log_has <label> <python-expr over r (one request dict)>: at least one mock request matches.
log_has() { python3 - "$MOCK_LOG" "$2" <<'PY' && ok "$1" || bad "$1" "no mock request matched: $2"
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
def safe(r):
    try:
        return eval(sys.argv[2], {}, {"r": r})
    except Exception:
        return False
sys.exit(0 if any(safe(r) for r in rows) else 1)
PY
}
log_none() { python3 - "$MOCK_LOG" "$2" <<'PY' && ok "$1" || bad "$1" "a mock request matched: $2"
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
def safe(r):
    try:
        return eval(sys.argv[2], {}, {"r": r})
    except Exception:
        return False
sys.exit(1 if any(safe(r) for r in rows) else 0)
PY
}
wpcli() { (cd "$WP_DIR" && wp "$@"); }
reset_feed() { wpcli eval 'global $wpdb; $wpdb->query( "DELETE FROM {$wpdb->options} WHERE option_name LIKE \"%norg_edge_feed%\" OR option_name LIKE \"%norg_edge_rr_%\" OR option_name LIKE \"%norg_edge_heartbeat_floor%\" OR option_name LIKE \"%norg_edge_origin_%\"" ); wp_cache_flush();' >/dev/null 2>&1; }

mkdir -p "$MOCK_STATE"; rm -f "$MOCK_STATE/refuse"; : >"$WORK/debug.log"
start_mock; start_wp; reset_feed

echo "People and search engines (rules 1 and 2)"
req "$BROWSER" /
expect_status "browser gets 200" 200; expect_edge "browser untouched" ""; expect_body "browser sees the WordPress page" "E2E Shop"
req "$GOOGLE" / -H "x-norg-edge-simulate: $MOCK_SITE_KEY"
expect_edge "Googlebot untouched even with a verified-source assertion" ""
req "$GOOGLE" "/?agent=true"
expect_edge "Googlebot untouched even with ?agent=true" ""
req "$BROWSER" "/" -H "x-norg-edge-simulate: nope"
expect_edge "a wrong simulate key does nothing" ""

echo "Verified AI agents"
req "$GPT" /
expect_edge "GPTBot from OpenAI's range gets the mirror" mirror
expect_body "mirror body is NORG's render" NORG-RENDER-HOME
expect_hdr "mirror is never cacheable" Cache-Control "private, no-store"
expect_hdr "mirror carries the env" X-Norg-Edge-Env test
log_has "visit travelled in X-Norg-Visit as served=mirror" "r['visit'] and r['visit'].get('served')=='mirror' and r['visit'].get('bot_name')=='gptbot'"
log_has "heartbeat sent with platform=wordpress and runtime" "r['path']=='/api/v1/edge/heartbeat' and r['body']['platform']=='wordpress' and r['body']['runtime']['wordpress']"
log_none "receptionist was not asked to file the render (key-suffix bug avoided)" "r['lazy']=='1'"

req "$GPT" /long-article/
expect_edge "GPTBot on an unrendered page gets the stripped page" stripped
expect_body "stripped page keeps the content" "Genuine product prose"
expect_no_body "stripped page has no scripts" "var secret"
expect_no_body "stripped page has no nav" "<nav"
log_has "render requested with the PAGE path" "r['path']=='/api/v1/edge/render-requests' and r['body']['path']=='/long-article/'"
log_has "miss declared as served_on_miss=stripped" "r['visit'] and r['visit'].get('served_on_miss')=='stripped'"
req "$GPT" /long-article/
log_none "render request deduplicated within 10 minutes" "r['path']=='/api/v1/edge/render-requests'"

req "$GPT" /thin-page/
expect_edge "too few words after stripping: untouched page (origin_thin)" ""
expect_body "thin page is the real page" "Just a few words"

req "$CLAUDE" /
expect_edge "ClaudeBot from outside Anthropic's range is not trusted" ""
req "$CLAUDE" "/?norg_edge=1"
expect_edge "a host-rewritten (?norg_edge) request from an untrusted agent still gets the real page" ""
expect_hdr "a host-rewritten request is never cacheable, verified or not" Cache-Control "private, no-store"
req "$BROWSER" /
[[ "$(hdr Cache-Control)" != *no-store* ]] && ok "an unmarked page is not forced no-store" || bad "an unmarked page is not forced no-store" "Cache-Control='$(hdr Cache-Control)'"
req "$CLAUDE" / -H "x-norg-edge-simulate: $MOCK_SITE_KEY"
expect_edge "ClaudeBot with the self-check's verified assertion is diverted" mirror
req "$CLAUDE" / -H "X-Forwarded-For: 203.0.113.9, 192.0.2.44"
expect_edge "behind a proxy, auto mode verifies the proxy's hop (Anthropic's range)" mirror
req "$CLAUDE" / -H "X-Forwarded-For: 192.0.2.44, 203.0.113.9"
expect_edge "a forged hop ahead of the proxy's is ignored" ""
req "Mozilla/5.0 (compatible; DeepSeekBot/1.0)" /
expect_edge "divert_unverified agent gets an existing render" mirror
log_has "divert_unverified tagged mirror_unverified" "r['visit'] and r['visit'].get('served')=='mirror_unverified'"
req "Mozilla/5.0 (compatible; DeepSeekBot/1.0)" /long-article/
expect_edge "divert_unverified miss gets the untouched page" ""
log_none "divert_unverified miss never triggers a render" "r['path']=='/api/v1/edge/render-requests'"
req "Mozilla/5.0 (compatible; PerplexityBot/1.0)" /
expect_edge "never_divert agent untouched" ""
req "curl/8.4.0" /
expect_edge "script automation untouched" ""
req "$GPT" /skipped-page/
expect_edge "operator-skipped page untouched for a diverting agent" ""
expect_no_body "skipped page never shows the NORG copy" SHOULD-NEVER-BE-SERVED

echo "Override and agentic subtree"
req "$BROWSER" "/?agent=true"
expect_edge "?agent=true serves the render to anyone but search engines" mirror
req "$BROWSER" "/long-article/?agent=true"
expect_edge "?agent=true miss is the untouched page" ""
log_none "?agent=true never triggers a render" "r['path']=='/api/v1/edge/render-requests'"
req "$BROWSER" /ai/sample-page/
expect_edge "/ai/* serves the render of the inner path to every caller" mirror
expect_body "agentic body is the inner page's render" NORG-RENDER-SAMPLE

echo "NORG-owned surfaces (identical for every caller)"
req "$BROWSER" /llms.txt
expect_edge "llms.txt from NORG" mirror; expect_hdr "llms.txt content type" Content-Type text/plain; expect_body "llms.txt body" "NORG llms.txt"
req "$BROWSER" /llms.txt -I
expect_status "HEAD llms.txt is 200" 200; expect_edge "HEAD llms.txt has the same headers" mirror
req "$BROWSER" /graph.jsonld
expect_status "missing discovery file falls through to WordPress 404" 404
req "$BROWSER" /.norg/theme.css
expect_edge "theme CSS" reserved-asset; expect_hdr "theme CSS is public" Cache-Control "public, max-age=60"
req "$BROWSER" /mcp
expect_edge "MCP manifest" mcp; expect_body "root manifest" norg-mcp-root
req "$BROWSER" /sample-page/mcp
expect_body "page manifest" norg-mcp-sample
req "$BROWSER" /mcp -X POST -H 'Content-Type: application/json' -H 'Cookie: wordpress_logged_in_x=secret' -H 'Authorization: Bearer x' --data '{"jsonrpc":"2.0","id":7,"method":"tools/list"}'
expect_body "MCP POST relayed to NORG" '"echo":"tools'; expect_hdr "MCP session id relayed" Mcp-Session-Id sess-123
log_none "cookies never forwarded to NORG" "r['path']=='/public-mcp/' and r['cookie']"
req "$BROWSER" /about/index.md
expect_edge "sibling artifact" mirror; expect_hdr "sibling canonical" Link 'rel="canonical"'; expect_hdr "sibling noindex" X-Robots-Tag noindex
req "$BROWSER" /openapi.json
expect_edge "OpenAI feed" openai-feed

echo "WordPress's own application"
req "$GPT" /wp-json/
expect_edge "REST API untouched" ""
req "$GPT" /wp-login.php
expect_edge "login untouched" ""
req "$GPT" /feed/
expect_edge "feeds untouched" ""
req "$GPT" / -X POST --data 'a=1'
expect_edge "non-GET to a page untouched" ""

echo "Health probe"
req "$BROWSER" / -H "x-norg-edge-check: $MOCK_SITE_KEY"
expect_body "probe answers JSON" '"platform":"wordpress"'; expect_body "probe reports entitlement" '"entitled":true'
req "$BROWSER" / -H "x-norg-edge-check: wrong"
expect_body "wrong probe key gets the normal page" "E2E Shop"

echo "Self-check and WP-CLI"
CHECK="$(wpcli norg-edge check 2>/dev/null)"
for want in '"cache_reach": "reached"' '"human": "ok"' '"search": "ok"' '"agent": "mirror"'; do
  [[ "$CHECK" == *"$want"* ]] && ok "self-check $want" || bad "self-check $want" "$CHECK"
done
STATUS="$(wpcli norg-edge status 2>/dev/null)"
[[ "$STATUS" != *"$MOCK_SITE_KEY"* && "$STATUS" == *'"platform": "wordpress"'* ]] && ok "status works and never prints the site key" || bad "status output wrong or leaks the key" "$STATUS"

echo "Revocation and outage"
stop_mock; start_mock 2; reset_feed
req "$GPT" /
expect_edge "short-TTL feed still serves" mirror
touch "$MOCK_STATE/refuse"; sleep 2.5
req "$GPT" /
expect_edge "first request after expiry: content refused too, so the normal page" ""
log_has "the stale feed was revalidated in the background (and refused)" "r['path']=='/api/v1/edge/bot-patterns'"
req "$GPT" /
expect_edge "after NORG refuses (401) the install stops diverting" ""
expect_body "and serves the normal page" "E2E Shop"
log_none "the refusal is cached: no NORG call at all on the next request" "r['path'].startswith('/content/') or r['path']=='/api/v1/edge/bot-patterns'"
rm -f "$MOCK_STATE/refuse"; stop_mock; start_mock; reset_feed
req "$GPT" /
expect_edge "re-entitled after the refusal is withdrawn" mirror
stop_mock
req "$GPT" /
expect_status "NORG down: still 200" 200; expect_body "NORG down: normal page (rule 1)" "E2E Shop"
start_mock

echo "Record-only mode"
wpcli option patch insert norg_edge_settings capture_only 1 >/dev/null 2>&1 || wpcli option update norg_edge_settings '{"capture_only":true}' --format=json >/dev/null
reset_feed
SETTLE=0.6 req "$GPT" /
expect_edge "capture mode never diverts" ""
log_has "capture reports the agent visit after the response" "r['path']=='/api/v1/edge/events' and r['body']['served']=='capture' and r['body']['bot_name']=='gptbot' and r['body']['verified_source']==True"
SETTLE=0.6 req "$BROWSER" "/sample-page/" -H 'Referer: https://chatgpt.com/'
log_has "capture reports a citation page view" "r['path']=='/api/v1/edge/page-views' and r['body']['citation_source']=='chatgpt' and r['body']['served_surface']=='customer_zone' and len(r['body']['visitor_id'])==32"
SETTLE=0.6 req "$BROWSER" "/sample-page/"
log_none "a direct human visit is not reported" "r['path'] in ('/api/v1/edge/events','/api/v1/edge/page-views')"
wpcli option patch delete norg_edge_settings capture_only >/dev/null 2>&1

echo "REST connect (NORG dashboard with an Application Password)"
APP_PW="$(wpcli user application-password create admin norg-e2e --porcelain 2>/dev/null)"
rest() { curl -s -o "$B" -w '%{http_code}' "$@"; }
CONNECT_BODY="{\"site_id\":\"$MOCK_SITE_ID\",\"site_key\":\"$MOCK_SITE_KEY\",\"env\":\"test\"}"
code="$(rest -X POST -H 'Content-Type: application/json' -d "$CONNECT_BODY" "$BASE/wp-json/norg-edge/v1/connect")"
[ "$code" = 401 ] && ok "connect without credentials is refused (401)" || bad "connect without credentials is refused (401)" "got $code"
code="$(rest -u "admin:wrong" -X POST -H 'Content-Type: application/json' -d "$CONNECT_BODY" "$BASE/wp-json/norg-edge/v1/connect")"
[ "$code" = 401 ] && ok "a wrong Application Password is refused (401)" || bad "a wrong Application Password is refused (401)" "got $code"
code="$(rest -u "admin:$APP_PW" -X POST -H 'Content-Type: application/json' -d "$CONNECT_BODY" "$BASE/wp-json/norg-edge/v1/connect")"
[ "$code" = 409 ] && ok "connect refuses while wp-config constants lock the settings (409)" || bad "connect refuses while wp-config constants lock the settings (409)" "got $code: $(head -c 200 "$B")"
touch "$WP_DIR/.e2e-form-credentials"
code="$(rest -u "admin:$APP_PW" -X POST -H 'Content-Type: application/json' -d '{"site_id":"nope","site_key":"x"}' "$BASE/wp-json/norg-edge/v1/connect")"
[ "$code" = 400 ] && ok "connect validates the Site ID and Site Key (400)" || bad "connect validates the Site ID and Site Key (400)" "got $code"
code="$(rest -u "admin:$APP_PW" -X POST -H 'Content-Type: application/json' -d "$CONNECT_BODY" "$BASE/wp-json/norg-edge/v1/connect")"
[ "$code" = 200 ] && grep -q '"saved":true' "$B" && grep -q '"agent":"mirror"' "$B" && ! grep -q "$MOCK_SITE_KEY" "$B" && ok "connect saves, proves the install and never echoes the key" || bad "connect saves, proves the install and never echoes the key" "got $code: $(head -c 300 "$B")"
log_has "connect sent a heartbeat" "r['path']=='/api/v1/edge/heartbeat'"
code="$(rest -u "admin:$APP_PW" "$BASE/wp-json/norg-edge/v1/status")"
[ "$code" = 200 ] && grep -q '"configured":true' "$B" && grep -q '"locked":false' "$B" && ! grep -q "$MOCK_SITE_KEY" "$B" && ok "status reports configured, unlocked, no key" || bad "status reports configured, unlocked, no key" "got $code: $(head -c 300 "$B")"
rm -f "$WP_DIR/.e2e-form-credentials"
wpcli option patch delete norg_edge_settings site_key_enc >/dev/null 2>&1; wpcli option patch delete norg_edge_settings site_id >/dev/null 2>&1

if [ -s "$WORK/debug.log" ] && grep -qi "fatal\|norg" "$WORK/debug.log"; then bad "PHP debug log is clean" "$(grep -i 'fatal\|norg' "$WORK/debug.log" | tail -3)"; else ok "PHP debug log is clean"; fi

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
