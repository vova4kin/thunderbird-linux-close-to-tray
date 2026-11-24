#!/usr/bin/env bash
# Build a clean, unsigned .xpi for addons.thunderbird.net.
# Only the files listed below end up in the archive (manifest.json at the root).
set -euo pipefail

cd "$(dirname "$0")"

VERSION="$(python3 -c 'import json; print(json.load(open("manifest.json"))["version"])')"
OUT_DIR="dist"
XPI="${OUT_DIR}/close-to-tray-linux-${VERSION}.xpi"

FILES=(
  manifest.json
  background.js
  LICENSE
  _locales/en/messages.json
  _locales/uk/messages.json
  experiments/systemTray/schema.json
  experiments/systemTray/implementation.js
  experiments/trayWindow/schema.json
  experiments/trayWindow/implementation.js
  icons/icon.svg
  icons/tray.svg
  options/options.html
  options/options.css
  options/options.js
)

# Sanity checks: valid JSON and JS syntax.
for f in manifest.json _locales/*/messages.json experiments/*/schema.json; do
  python3 -c 'import json, sys; json.load(open(sys.argv[1]))' "$f"
done
if command -v node >/dev/null; then
  for f in background.js options/options.js experiments/*/implementation.js; do
    node --check "$f"
  done
fi

mkdir -p "$OUT_DIR"
rm -f "$XPI"
# -X: no extra file attributes, -D: no directory entries.
zip -q -X -D "$XPI" "${FILES[@]}"

echo "Built ${XPI}"
unzip -l "$XPI"
