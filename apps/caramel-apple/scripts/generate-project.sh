#!/usr/bin/env bash
# Regenerates apps/caramel-apple/Caramel.xcodeproj (and the Info.plist /
# entitlements files) from project.yml with a PINNED XcodeGen. macOS only.
# Usage: scripts/generate-project.sh
set -euo pipefail

XCODEGEN_VERSION="2.46.0"
XCODEGEN_SHA256="4d9e34b62172d645eed6457cac13fc222569974098ef4ee9c3368bedf0196806"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tool_dir="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/xcodegen-${XCODEGEN_VERSION}"

if [ ! -x "${tool_dir}/xcodegen/bin/xcodegen" ]; then
  mkdir -p "${tool_dir}"
  curl -fsSL -o "${tool_dir}/xcodegen.zip" \
    "https://github.com/yonaskolb/XcodeGen/releases/download/${XCODEGEN_VERSION}/xcodegen.zip"
  echo "${XCODEGEN_SHA256}  ${tool_dir}/xcodegen.zip" | shasum -a 256 -c -
  unzip -q -o "${tool_dir}/xcodegen.zip" -d "${tool_dir}"
fi

cd "${here}"
"${tool_dir}/xcodegen/bin/xcodegen" generate --spec project.yml --project .
