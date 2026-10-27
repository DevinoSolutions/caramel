#!/usr/bin/env bash
# T-9413 guard for the dev-only `devproof` Android build type (apps/caramel-android/app/build.gradle.kts).
# Run by .github/workflows/android-devproof-guard.yml AFTER `./gradlew assembleRelease assembleDevproof`, from the repo
# root. Fails (non-zero, with ::error:: lines) when any of these is not true:
#   1. release-android-app.yml never mentions the variant (it must not build, sign or upload it);
#   2. the store build keeps the bare applicationId and its shrunk code holds no trace of the dev-proof path
#      (the `devproof_session` extra name, the dev origin);
#   3. the devproof build has the suffixed applicationId, DOES hold those strings (so check 2 is proven able to see
#      them), and is signed with the Android debug key, never an upload key.
set -euo pipefail

ANDROID_DIR="${ANDROID_DIR:-apps/caramel-android}"
OUT="$ANDROID_DIR/app/build/outputs"
RELEASE_WORKFLOW=".github/workflows/release-android-app.yml"
STORE_ID="com.devino.caramel"
EXTRA_NAME="devproof_session"
DEV_ORIGIN="dev.grabcaramel.com"
failed=0

fail() {
  echo "::error::$1"
  failed=1
}

# 1. The release workflow must not know the variant exists.
if grep -n -i 'devproof' "$RELEASE_WORKFLOW"; then
  fail "$RELEASE_WORKFLOW mentions devproof: the release workflow must never build, sign or upload the dev-only variant."
fi

# applicationId recorded by AGP for one output directory (apk/release, apk/devproof).
application_id() {
  python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["applicationId"])' "$1/output-metadata.json"
}

# Whether the dex files of an APK contain a literal string.
dex_contains() { # apk, needle
  unzip -p "$1" 'classes*.dex' | grep -a -q -F -- "$2"
}

release_apk="$(ls "$OUT"/apk/release/*.apk | head -1)"
devproof_apk="$(ls "$OUT"/apk/devproof/*.apk | head -1)"
echo "release APK:  $release_apk"
echo "devproof APK: $devproof_apk"

# 2. The store build.
release_id="$(application_id "$OUT/apk/release")"
if [ "$release_id" != "$STORE_ID" ]; then
  fail "release applicationId is '$release_id', expected '$STORE_ID' (no suffix)."
fi
for needle in "$EXTRA_NAME" "$DEV_ORIGIN"; do
  if dex_contains "$release_apk" "$needle"; then
    fail "the shrunk release APK still contains '$needle': the dev-proof path was not stripped by R8."
  fi
done

# 3. The devproof build.
devproof_id="$(application_id "$OUT/apk/devproof")"
if [ "$devproof_id" != "$STORE_ID.devproof" ]; then
  fail "devproof applicationId is '$devproof_id', expected '$STORE_ID.devproof'."
fi
for needle in "$EXTRA_NAME" "$DEV_ORIGIN"; do
  if ! dex_contains "$devproof_apk" "$needle"; then
    fail "the devproof APK does not contain '$needle': the dev-proof path is not wired (or this check is blind)."
  fi
done
apksigner="$(ls -d "$ANDROID_HOME"/build-tools/*/apksigner | sort -V | tail -1)"
signer="$("$apksigner" verify --print-certs "$devproof_apk")"
echo "$signer" | grep -E 'Signer #1 certificate (DN|SHA-256)' || true
if ! grep -q 'CN=Android Debug' <<<"$signer"; then
  fail "the devproof APK is not signed with the Android debug key (certificate DN must contain CN=Android Debug)."
fi

if [ "$failed" -ne 0 ]; then
  exit 1
fi
echo "devproof guard: release is clean, devproof is wired and debug-signed."
