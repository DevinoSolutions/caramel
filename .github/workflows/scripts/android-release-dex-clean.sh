#!/usr/bin/env bash
# T-9413: the store build of apps/caramel-android must carry no dev-only proof path. Run by release-android-app.yml
# before any Play upload, and by the PR guard workflow, from the repo root AFTER the release build. Fails (non-zero,
# ::error:: lines) unless:
#   1. the release applicationId is exactly com.devino.caramel (no suffix);
#   2. no classes*.dex of the release APK, or of the release AAB's base module, contains the dev-only intent-extra name
#      or the dev origin. R8 strips both from release because every use sits behind a constant that is false there; a
#      string that survives means the dev path leaked into the store build.
# The two needles are assembled below from halves so that this file does not itself spell them out.
# Needs python3. Inputs (all optional paths, defaults match the workflow): ANDROID_DIR.
set -euo pipefail

ANDROID_DIR="${ANDROID_DIR:-apps/caramel-android}"
OUT="$ANDROID_DIR/app/build/outputs"
STORE_ID="com.devino.caramel"
EXTRA_NAME="dev""proof_session"
DEV_ORIGIN="dev.grab""caramel.com"
failed=0

fail() {
  echo "::error::$1"
  failed=1
}

# Prints yes or no: whether any dex of an APK (classes*.dex) or AAB (base/dex/classes*.dex) contains a literal string.
# An unreadable archive aborts the script (set -e on the assignment at the call site), so a read failure can never
# pass as "not found".
dex_has() { # archive, needle
  python3 -c '
import re, sys, zipfile

archive, needle = sys.argv[1], sys.argv[2].encode()
with zipfile.ZipFile(archive) as z:
    dexes = [n for n in z.namelist() if re.fullmatch(r"(base/dex/)?classes\d*\.dex", n)]
    if not dexes:
        sys.exit("no classes*.dex in " + archive)
    print("yes" if any(needle in z.read(n) for n in dexes) else "no")
' "$1" "$2"
}

metadata="$OUT/apk/release/output-metadata.json"
[ -f "$metadata" ] || { echo "::error::$metadata is missing: build the release APK first."; exit 1; }
release_id="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["applicationId"])' "$metadata")"
if [ "$release_id" != "$STORE_ID" ]; then
  fail "release applicationId is '$release_id', expected '$STORE_ID' (no suffix)."
fi

archives=()
for pattern in "$OUT"/apk/release/*.apk "$OUT"/bundle/release/*.aab; do
  [ -f "$pattern" ] && archives+=("$pattern")
done
[ "${#archives[@]}" -gt 0 ] || { echo "::error::no release APK or AAB under $OUT."; exit 1; }

for archive in "${archives[@]}"; do
  echo "checking $archive"
  for needle in "$EXTRA_NAME" "$DEV_ORIGIN"; do
    found="$(dex_has "$archive" "$needle")"
    if [ "$found" = yes ]; then
      fail "$archive still contains '$needle': the dev-only path was not stripped from the store build."
    fi
  done
done

if [ "$failed" -ne 0 ]; then
  exit 1
fi
echo "release dex clean: applicationId $release_id, ${#archives[@]} archive(s) hold no dev-only strings."
