#!/usr/bin/env bash
# Build a clean, unsigned .xpi for addons.thunderbird.net.
# The archive contains only the add-on itself, with manifest.json at its root.
set -euo pipefail

cd "$(dirname "$0")"

CONTENTS=(manifest.json background.js LICENSE _locales common experiments icons options)

VERSION="$(python3 -c 'import json; print(json.load(open("manifest.json"))["version"])')"
XPI="dist/close-to-tray-linux-${VERSION}.xpi"

# Sanity checks: valid JSON and JavaScript syntax.
find manifest.json _locales experiments -name '*.json' -print0 |
  xargs -0 -n1 python3 -c 'import json, sys; json.load(open(sys.argv[1]))'
if command -v node >/dev/null; then
  find background.js common experiments options -name '*.js' -print0 | xargs -0 -n1 node --check
fi

mkdir -p dist
rm -f "$XPI"
# -X: no extra file attributes, -D: no directory entries.
zip -q -r -X -D "$XPI" "${CONTENTS[@]}"

echo "Built ${XPI}"
unzip -l "$XPI"
