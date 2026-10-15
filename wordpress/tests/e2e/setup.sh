#!/usr/bin/env bash
# Build a throwaway WordPress site (SQLite, no MySQL, no Docker) for the end-to-end suite.
#
# Usage: setup.sh <work-dir>
# Needs: php, wp (WP-CLI) on PATH; downloads cached in $E2E_CACHE (default <work-dir>/dl).
set -euo pipefail

WORK="$1"
HERE="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_SRC="$(cd "$HERE/../../norg-edge-router" && pwd)"
CACHE="${E2E_CACHE:-$WORK/dl}"
WP_DIR="$WORK/site"
PORT="${WP_PORT:-8889}"
MOCK_PORT="${MOCK_PORT:-8890}"
SITE_ID="${MOCK_SITE_ID:-9f1c2e4a-1111-4222-8333-444455556666}"
SITE_KEY="${MOCK_SITE_KEY:-nek_live_e2eTestKeyAAAAAAAAAAAAAAAAAAAAAA}"

mkdir -p "$CACHE" "$WORK"
fetch() { [ -s "$CACHE/$1" ] || curl -sSfL -o "$CACHE/$1" "$2"; }
fetch wordpress.zip https://wordpress.org/latest.zip
fetch sqlite.zip https://downloads.wordpress.org/plugin/sqlite-database-integration.latest-stable.zip

rm -rf "$WP_DIR" && mkdir -p "$WP_DIR"
unzip -q "$CACHE/wordpress.zip" -d "$WORK/wp-tmp" && mv "$WORK/wp-tmp/wordpress/"* "$WP_DIR/" && rm -rf "$WORK/wp-tmp"
unzip -q "$CACHE/sqlite.zip" -d "$WP_DIR/wp-content/plugins/"
sed -e "s#{SQLITE_IMPLEMENTATION_FOLDER_PATH}#$WP_DIR/wp-content/plugins/sqlite-database-integration#" \
    -e "s#{SQLITE_PLUGIN}#sqlite-database-integration/load.php#" \
    "$WP_DIR/wp-content/plugins/sqlite-database-integration/db.copy" > "$WP_DIR/wp-content/db.php"

cat > "$WP_DIR/wp-config.php" <<PHP
<?php
define( 'DB_NAME', 'wp' ); define( 'DB_USER', 'wp' ); define( 'DB_PASSWORD', 'wp' ); define( 'DB_HOST', 'localhost' );
define( 'DB_CHARSET', 'utf8' ); define( 'DB_COLLATE', '' );
define( 'AUTH_KEY', 'e2e-a' ); define( 'SECURE_AUTH_KEY', 'e2e-b' ); define( 'LOGGED_IN_KEY', 'e2e-c' ); define( 'NONCE_KEY', 'e2e-d' );
define( 'AUTH_SALT', 'e2e-e' ); define( 'SECURE_AUTH_SALT', 'e2e-f' ); define( 'LOGGED_IN_SALT', 'e2e-g' ); define( 'NONCE_SALT', 'e2e-h' );
\$table_prefix = 'wp_';
define( 'WP_DEBUG', true ); define( 'WP_DEBUG_LOG', '$WORK/debug.log' ); define( 'WP_DEBUG_DISPLAY', false );
define( 'NORG_API_URL', 'http://127.0.0.1:$MOCK_PORT' );
define( 'NORG_CONTENT_BASE', 'http://127.0.0.1:$MOCK_PORT/content' );
define( 'NORG_EDGE_ENV', 'test' );
if ( ! file_exists( __DIR__ . '/.e2e-form-credentials' ) ) { define( 'NORG_SITE_ID', '$SITE_ID' ); define( 'NORG_SITE_KEY', '$SITE_KEY' ); }
@include __DIR__ . '/wp-config-extra.php';
if ( ! defined( 'ABSPATH' ) ) { define( 'ABSPATH', __DIR__ . '/' ); }
require_once ABSPATH . 'wp-settings.php';
PHP

cd "$WP_DIR"
# Test-only: WordPress's download_url() refuses loopback hosts, and the update test
# serves its package from the local mock. Production packages are public HTTPS URLs.
mkdir -p "$WP_DIR/wp-content/mu-plugins"
cat > "$WP_DIR/wp-content/mu-plugins/e2e-allow-local-packages.php" <<'MU'
<?php
// E2E only: let download_url() fetch from the local mock NORG.
add_filter( 'http_request_host_is_external', static function ( $external, $host ) { return '127.0.0.1' === $host ? true : $external; }, 10, 2 );
add_filter( 'http_allowed_safe_ports', static function ( $ports ) { return array_merge( (array) $ports, array( 8890 ) ); } );
// E2E only: the site is plain HTTP, where core refuses Application Passwords.
add_filter( 'wp_is_application_passwords_available', '__return_true' );
MU
wp core install --url="http://127.0.0.1:$PORT" --title="E2E Shop" --admin_user=admin --admin_password=admin --admin_email=e2e@example.test --skip-email --quiet
wp rewrite structure '/%postname%/' --quiet
ln -s "$PLUGIN_SRC" "$WP_DIR/wp-content/plugins/norg-edge-router"
wp plugin activate norg-edge-router --quiet

LONG="$(for i in $(seq 1 60); do printf 'Genuine product prose sentence number %s about widgets. ' "$i"; done)"
wp post create --post_type=page --post_status=publish --post_title='Long Article' --post_name=long-article --post_content="<p>$LONG</p><script>var secret=1;</script><nav>menu</nav>" --quiet
wp post create --post_type=page --post_status=publish --post_title='Thin Page' --post_name=thin-page --post_content='<p>Just a few words.</p>' --quiet
wp post create --post_type=page --post_status=publish --post_title='Skipped Page' --post_name=skipped-page --post_content="<p>$LONG</p>" --quiet
wp post create --post_type=page --post_status=publish --post_title='About' --post_name=about --post_content='<p>About us.</p>' --quiet
echo "site ready: $WP_DIR (http://127.0.0.1:$PORT)"
