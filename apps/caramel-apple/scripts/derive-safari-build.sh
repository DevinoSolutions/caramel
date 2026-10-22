#!/usr/bin/env bash
# Derives apps/caramel-extension/.output/safari-mv3 from the WXT Chrome build:
# the same directory with only the manifest `name` swapped for the Safari-length
# one (App Store Connect rejects names over 40 characters, error 90849). This is
# the same derivation release-extension.yml's package job performs.
# Run after `pnpm --filter caramel-extension exec wxt build`. Needs node and jq.
set -euo pipefail

ext="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../caramel-extension" && pwd)"
cd "${ext}"

name=$(node --input-type=module -e "import { SAFARI_NAME } from './scripts/store-listing.mjs'; process.stdout.write(SAFARI_NAME)")
if [ "${#name}" -gt 40 ]; then
  echo "SAFARI_NAME '${name}' is ${#name} characters; App Store Connect allows 40." >&2
  exit 1
fi
[ -f .output/chrome-mv3/manifest.json ] || { echo ".output/chrome-mv3 is missing: build the extension first." >&2; exit 1; }
rm -rf .output/safari-mv3
cp -R .output/chrome-mv3 .output/safari-mv3
jq --arg name "${name}" '.name = $name' .output/chrome-mv3/manifest.json > .output/safari-mv3/manifest.json
echo "Safari manifest name: $(jq -er '.name' .output/safari-mv3/manifest.json), version $(jq -er '.version' .output/safari-mv3/manifest.json)"
