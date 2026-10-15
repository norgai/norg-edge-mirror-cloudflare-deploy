#!/usr/bin/env bash
# Build the installable plugin zip.
#
# Usage: build-zip.sh [norg|wporg] [out-dir]
#   norg   (default) NORG distribution channel: includes the self-hosted updater and Update URI.
#   wporg  WordPress.org build: no updater and no Update URI (directory guidelines forbid both).
# Prints the zip path and its SHA-256 (the value the update manifest publishes).
set -euo pipefail
CHANNEL="${1:-norg}"; OUT="${2:-$(pwd)/dist}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"; SRC="$HERE/norg-edge-router"
VERSION="$(sed -n "s/^define( 'NORG_EDGE_ROUTER_VERSION', '\([^']*\)' );/\1/p" "$SRC/norg-edge-router.php")"
STABLE="$(sed -n 's/^Stable tag: //p' "$SRC/readme.txt")"
HEADER="$(sed -n 's/^ \* Version: *//p' "$SRC/norg-edge-router.php")"
[ "$VERSION" = "$STABLE" ] && [ "$VERSION" = "$HEADER" ] || { echo "version mismatch: const=$VERSION header=$HEADER stable=$STABLE" >&2; exit 1; }
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/norg-edge-router" "$OUT"
( cd "$SRC" && find . -type f ! -name '.*' ! -path './tests/*' -print0 | xargs -0 -I{} cp --parents {} "$STAGE/norg-edge-router/" )
if [ "$CHANNEL" = wporg ]; then
  rm -f "$STAGE/norg-edge-router/includes/class-updater.php"
  sed -i '/^ \* Update URI:/d' "$STAGE/norg-edge-router/norg-edge-router.php"
elif [ "$CHANNEL" != norg ]; then
  echo "unknown channel: $CHANNEL" >&2; exit 1
fi
ZIP="$OUT/norg-edge-router-$VERSION-$CHANNEL.zip"
rm -f "$ZIP"
python3 - "$STAGE" "$ZIP" <<'PY'
import os, sys, zipfile
stage, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk(os.path.join(stage, "norg-edge-router")):
        dirs.sort()
        for name in sorted(files):
            full = os.path.join(root, name)
            info = zipfile.ZipInfo(os.path.relpath(full, stage), date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            with open(full, "rb") as f:
                z.writestr(info, f.read())
PY
echo "$ZIP"
sha256sum "$ZIP" | cut -d' ' -f1
