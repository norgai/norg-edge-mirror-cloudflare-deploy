#!/usr/bin/env bash
# Headed Chrome UI tests: start mock NORG + WordPress with credentials NOT in wp-config.php, then run Playwright.
#
# Usage: ui.sh <work-dir>   (after setup.sh)
set -uo pipefail
WORK="$1"; HERE="$(cd "$(dirname "$0")" && pwd)"; WP_DIR="$WORK/site"
PORT="${WP_PORT:-8889}"; MOCK_PORT="${MOCK_PORT:-8890}"; PHP_BIN="${PHP_BIN:-$(command -v php)}"
export MOCK_SITE_ID="${MOCK_SITE_ID:-9f1c2e4a-1111-4222-8333-444455556666}" MOCK_SITE_KEY="${MOCK_SITE_KEY:-nek_live_e2eTestKeyAAAAAAAAAAAAAAAAAAAAAA}"
export MOCK_LOG="$WORK/mock.jsonl" MOCK_STATE="$WORK/state"
mkdir -p "$MOCK_STATE" "$HERE/../../screenshots"; rm -f "$MOCK_STATE/refuse"
# Credentials come from the settings form in this run, not wp-config.php constants.
touch "$WP_DIR/.e2e-form-credentials"
(cd "$WP_DIR" && wp option delete norg_edge_settings norg_edge_feed_status norg_edge_last_self_check norg_edge_bypass >/dev/null 2>&1; wp eval 'global $wpdb; $wpdb->query("DELETE FROM {$wpdb->options} WHERE option_name LIKE \"%norg_edge_feed_%\"");' >/dev/null 2>&1)
MOCK_FEED_TTL=3600 nohup "$PHP_BIN" -S "127.0.0.1:$MOCK_PORT" "$HERE/mock-norg.php" >/dev/null 2>&1 & MP=$!
PHP_CLI_SERVER_WORKERS=4 nohup "$PHP_BIN" -S "127.0.0.1:$PORT" -t "$WP_DIR" "$HERE/wp-router.php" >/dev/null 2>&1 & WP=$!
trap 'kill $MP $WP 2>/dev/null; rm -f "$WP_DIR/.e2e-form-credentials"' EXIT; sleep 1
cd "$HERE/ui" && pnpm exec playwright test
