#!/usr/bin/env bash
# Self-hosted update channel, end to end: WordPress sees the update from NORG's
# manifest, installs a package whose SHA-256 matches, and refuses one that does not.
#
# Usage: updates.sh <work-dir> <plugin-zip>   (after setup.sh; plugin installed from a zip, not a symlink)
set -uo pipefail
WORK="$1"; ZIP="$2"; HERE="$(cd "$(dirname "$0")" && pwd)"; WP_DIR="$WORK/site"
MOCK_PORT="${MOCK_PORT:-8890}"; PHP_BIN="${PHP_BIN:-$(command -v php)}"
export MOCK_SITE_ID="${MOCK_SITE_ID:-9f1c2e4a-1111-4222-8333-444455556666}" MOCK_SITE_KEY="${MOCK_SITE_KEY:-nek_live_e2eTestKeyAAAAAAAAAAAAAAAAAAAAAA}"
export MOCK_LOG="$WORK/mock.jsonl" MOCK_STATE="$WORK/state"
PASS=0; FAIL=0
ok() { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31m✗ %s\033[0m  %s\n' "$1" "${2:-}"; }
check() { if eval "$2"; then ok "$1"; else bad "$1" "$2"; fi; }
wpcli() { (cd "$WP_DIR" && wp "$@" 2>&1); }
mkdir -p "$MOCK_STATE" "$WP_DIR/wp-content/mu-plugins"
[ -f "$WP_DIR/wp-content/mu-plugins/e2e-allow-local-packages.php" ] || printf '%s\n' '<?php' "add_filter( 'http_request_host_is_external', static function ( \$e, \$h ) { return '127.0.0.1' === \$h ? true : \$e; }, 10, 2 );" "add_filter( 'http_allowed_safe_ports', static function ( \$p ) { return array_merge( (array) \$p, array( $MOCK_PORT ) ); } );" > "$WP_DIR/wp-content/mu-plugins/e2e-allow-local-packages.php"
# The offered package is a real 0.1.3 build of the given zip, so success is proven by the installed version.
python3 - "$ZIP" "$MOCK_STATE/package.zip" <<'PY'
import sys, zipfile
src, dst = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
    for item in zin.infolist():
        data = zin.read(item.filename)
        if item.filename.endswith("norg-edge-router/norg-edge-router.php"):
            data = data.replace(b"0.1.2", b"0.1.3")
        zout.writestr(item, data)
PY
nohup "$PHP_BIN" -d opcache.enable_cli=0 -S "127.0.0.1:$MOCK_PORT" "$HERE/mock-norg.php" >"$WORK/mock.out" 2>&1 & MP=$!
trap 'kill $MP 2>/dev/null; rm -f "$MOCK_STATE/update_version" "$MOCK_STATE/update_sha" "$MOCK_STATE/package.zip"' EXIT; sleep 0.7
grep -q "Failed to listen" "$WORK/mock.out" && { echo "port in use: $(cat "$WORK/mock.out")" >&2; exit 2; }
# WP-CLI caches downloaded packages by name+version; a stale 0.1.3 from an earlier
# run would be (rightly) refused on checksum, so the cache is cleared each round.
reset_updates() { wpcli eval 'delete_site_transient("update_plugins"); delete_site_transient("norg_edge_update_manifest");' >/dev/null; wpcli cli cache clear >/dev/null 2>&1 || true; }
check "installed from a zip (not a dev symlink)" '[ ! -L "$WP_DIR/wp-content/plugins/norg-edge-router" ]'

echo "Manifest offers the running version: no update"
echo 0.1.2 > "$MOCK_STATE/update_version"; reset_updates
check "no update offered" '[[ "$(wpcli plugin list --name=norg-edge-router --field=update)" == none ]]'

echo "Manifest offers a newer version with a WRONG checksum"
echo 0.1.3 > "$MOCK_STATE/update_version"; echo "$(printf 'f%.0s' $(seq 64))" > "$MOCK_STATE/update_sha"; reset_updates
check "update is offered" '[[ "$(wpcli plugin list --name=norg-edge-router --field=update)" == available ]]'
OUT="$(wpcli plugin update norg-edge-router)"
check "the package is refused on checksum mismatch" '[[ "$OUT" == *"did not match its published checksum"* ]]'
check "the plugin still runs the old copy" '[[ "$(wpcli plugin list --name=norg-edge-router --field=version)" == 0.1.2 && "$(wpcli plugin list --name=norg-edge-router --field=status)" == active ]]'

echo "Manifest offers a newer version with the RIGHT checksum"
sha256sum "$MOCK_STATE/package.zip" | cut -d' ' -f1 > "$MOCK_STATE/update_sha"; reset_updates
OUT="$(wpcli plugin update norg-edge-router)"
check "the verified package installs (now 0.1.3)" '[[ "$(wpcli plugin list --name=norg-edge-router --field=version)" == 0.1.3 ]]'
check "the plugin is active after the update" '[[ "$(wpcli plugin list --name=norg-edge-router --field=status)" == active ]]'
check "auto-updates are on for this plugin by default" '[[ "$(wpcli eval "echo (int) apply_filters(\"auto_update_plugin\", false, (object) array(\"plugin\" => \"norg-edge-router/norg-edge-router.php\"));")" == 1 ]]'

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"; [ "$FAIL" -eq 0 ]
