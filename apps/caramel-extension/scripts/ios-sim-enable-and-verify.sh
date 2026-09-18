#!/bin/bash
# enable-and-verify.sh — enable the Caramel Safari web extension in an iOS simulator,
# grant it access to all websites, open a store page, and capture proof screenshots.
#
# Usage: ./enable-and-verify.sh [UDID]   (default: iPhone 16e / iOS 26 phase-4 sim)
#
# Enable mechanism (verified 2026-07-16, Xcode 26.2 / iOS 26 sim):
#   PRIMARY  — direct state write: Safari stores web-extension enablement in
#              <safari-data-container>/Library/Safari/WebExtensions/Extensions.plist
#              keyed by "<app-bundle-id>.Extension (UNSIGNED)" (unsigned dev builds).
#              "Other Websites = Allow" == GrantedPermissionOrigins["*://*/*"].
#              Writing the plist while Safari is terminated is picked up on next launch.
#   FALLBACK — idb UI automation through Settings (Apps > Safari > Extensions >
#              Caramel > Allow Extension + Other Websites > Allow) via tap.py.
set -euo pipefail

if [ $# -lt 1 ]; then
    echo "Usage: $0 <simulator-UDID>   (xcrun simctl list devices available)" >&2
    exit 2
fi
UDID="$1"
PHASE_DIR="$HOME/caramel-ext-phase4"
APP_BUNDLE_ID="ca.devino.caramel.phase4test"
EXT_KEY="${APP_BUNDLE_ID}.Extension (UNSIGNED)"
STORE_URL="https://www.nike.com/cart"
PROOF="$PHASE_DIR/proof"
IDB="$PHASE_DIR/venv/bin/idb"
COMPANION="$PHASE_DIR/idb-companion.universal/bin/idb_companion"
COMPANION_PORT=10882
DEV_DATA="$HOME/Library/Developer/CoreSimulator/Devices/$UDID/data"

mkdir -p "$PROOF"
log() { echo "[enable-and-verify] $*"; }

# ---------- 1. boot ----------
log "booting $UDID (no-op if already booted)"
xcrun simctl bootstatus "$UDID" -b

# ---------- 2. install + register app ----------
if ! grep -q "$APP_BUNDLE_ID" <<<"$(xcrun simctl listapps "$UDID" 2>/dev/null)"; then
  log "app not installed — building unsigned iOS app"
  APP_PATH=$(find "$PHASE_DIR/xcode" -name "Caramel.app" -path "*iphonesimulator*" -not -path "*Index.noindex*" 2>/dev/null | awk 'NR<=1' || true)
  if [ -z "$APP_PATH" ]; then
    xcodebuild -project "$PHASE_DIR/xcode/Caramel/Caramel.xcodeproj" -scheme "Caramel (iOS)" \
      -sdk iphonesimulator -configuration Debug -derivedDataPath "$PHASE_DIR/xcode/DerivedData" \
      CODE_SIGNING_ALLOWED=NO build
    APP_PATH=$(find "$PHASE_DIR/xcode/DerivedData" -name "Caramel.app" -path "*iphonesimulator*" | awk 'NR<=1')
  fi
  xcrun simctl install "$UDID" "$APP_PATH"
fi
# launch once so Safari/extensiond registers the extension, then move on
xcrun simctl launch "$UDID" "$APP_BUNDLE_ID" >/dev/null || true
sleep 3
xcrun simctl terminate "$UDID" "$APP_BUNDLE_ID" 2>/dev/null || true

# ---------- helpers ----------
find_safari_container() {
  local meta
  for meta in "$DEV_DATA"/Containers/Data/Application/*/.com.apple.mobile_container_manager.metadata.plist; do
    if grep -qx 'com.apple.mobilesafari' <<<"$(/usr/libexec/PlistBuddy -c 'Print :MCMMetadataIdentifier' "$meta" 2>/dev/null)"; then
      dirname "$meta"; return 0
    fi
  done
  return 1
}

extension_enabled() {
  local c; c=$(find_safari_container) || return 1
  local p="$c/Library/Safari/WebExtensions/Extensions.plist"
  [ -f "$p" ] || return 1
  python3 - "$p" "$EXT_KEY" <<'PY'
import plistlib, sys
with open(sys.argv[1], 'rb') as f: d = plistlib.load(f)
e = d.get(sys.argv[2], {})
sys.exit(0 if (e.get("Enabled") and "*://*/*" in e.get("GrantedPermissionOrigins", {})) else 1)
PY
}

enable_direct() {
  local c; c=$(find_safari_container) || { log "no Safari container yet"; return 1; }
  # Safari must have created its profile dirs once
  xcrun simctl launch "$UDID" com.apple.mobilesafari >/dev/null || true
  sleep 2
  xcrun simctl terminate "$UDID" com.apple.mobilesafari 2>/dev/null || true
  sleep 1
  mkdir -p "$c/Library/Safari/WebExtensions"
  python3 - "$c/Library/Safari/WebExtensions/Extensions.plist" "$EXT_KEY" <<'PY'
import plistlib, sys, os, datetime
path, key = sys.argv[1], sys.argv[2]
d = {}
if os.path.exists(path):
    with open(path, 'rb') as f: d = plistlib.load(f)
far = datetime.datetime(4001, 1, 1)          # "forever" sentinel Safari uses
now = datetime.datetime.utcnow()
e = d.setdefault(key, {})
e.update({
    "AddedDate": e.get("AddedDate", now),
    "Enabled": True,
    "EnabledByUserGesture": True,
    "EnabledModificationDate": now,
    "GrantedPermissionOrigins": {"*://*/*": far},
    "GrantedPermissions": {k: far for k in ("activeTab", "scripting", "storage", "tabs")},
    "RevokedPermissionOrigins": {},
    "RevokedPermissions": {},
})
with open(path, 'wb') as f: plistlib.dump(d, f, fmt=plistlib.FMT_BINARY)
print("wrote", path)
PY
}

ensure_companion() {
  if ! nc -z localhost $COMPANION_PORT 2>/dev/null; then
    log "starting idb_companion on :$COMPANION_PORT"
    nohup "$COMPANION" --udid "$UDID" --grpc-port $COMPANION_PORT >"$PHASE_DIR/companion.log" 2>&1 &
    sleep 4
  fi
}

tapper() { python3 "$PHASE_DIR/tap.py" "$@"; }
swipe()  { "$IDB" --companion localhost:$COMPANION_PORT ui swipe "$@" --duration 0.4; sleep 1.2; }

enable_via_ui() {
  # Settings > Apps > Safari > Extensions > Caramel > Allow Extension; Other Websites > Allow
  ensure_companion
  xcrun simctl terminate "$UDID" com.apple.Preferences 2>/dev/null || true
  sleep 1
  xcrun simctl launch "$UDID" com.apple.Preferences >/dev/null
  sleep 2
  swipe 195 700 195 200
  tapper com.apple.settings.apps; sleep 1.5
  # scroll until Safari row is visible
  for _ in 1 2 3 4; do
    grep -q Safari <<<"$(tapper --list mobilesafari)" && break
    swipe 195 700 195 200
  done
  tapper com.apple.mobilesafari; sleep 1.5
  # scroll until Extensions row visible, then nudge it clear of the nav-bar overlay
  for _ in 1 2 3 4; do
    grep -q Extensions <<<"$(tapper --list Extensions)" && break
    swipe 195 700 195 200
  done
  swipe 195 300 195 450   # pull row out from under the large-title header
  tapper Extensions; sleep 1.5
  tapper "Caramel - Trusted"; sleep 1.5
  # toggle: tap the switch element (index 1); retry once with raw coords (iOS 26 sometimes eats the first tap)
  if grep -q "| 0 |" <<<"$(tapper --list "Allow Extension" | awk 'NR<=1')"; then
    tapper "Allow Extension" --index 1; sleep 2
    if grep -q "| 0 |" <<<"$(tapper --list "Allow Extension" | awk 'NR<=1')"; then
      "$IDB" --companion localhost:$COMPANION_PORT ui tap 332 356 --duration 0.1; sleep 2
    fi
  fi
  tapper "Other Websites"; sleep 1.5
  tapper Allow --index 0; sleep 1.5
  tapper "Caramel - Trusted"; sleep 1     # back
  xcrun simctl terminate "$UDID" com.apple.Preferences 2>/dev/null || true
}

# ---------- 3. enable ----------
if extension_enabled; then
  log "extension already enabled with all-websites access"
else
  log "enabling via direct state write"
  enable_direct || true
  if ! extension_enabled; then
    log "direct write did not stick — falling back to Settings UI automation"
    enable_via_ui
  fi
  extension_enabled || { log "FATAL: extension still not enabled"; exit 1; }
fi

# ---------- 4. verify in Safari + proof screenshots ----------
log "opening $STORE_URL"
xcrun simctl ui "$UDID" appearance light
xcrun simctl terminate "$UDID" com.apple.mobilesafari 2>/dev/null || true
sleep 1
xcrun simctl openurl "$UDID" "$STORE_URL"
sleep 12
xcrun simctl io "$UDID" screenshot "$PROOF/01-store-page-extension-icon.png"

ensure_companion
# Open the extension popup: Safari Page Menu (puzzle/page button) > Caramel
tapper PageFormatMenuButton; sleep 2
tapper "Caramel - Trusted"; sleep 4
xcrun simctl io "$UDID" screenshot "$PROOF/02-popup-light.png"

xcrun simctl ui "$UDID" appearance dark
sleep 3
xcrun simctl io "$UDID" screenshot "$PROOF/03-popup-dark.png"
xcrun simctl ui "$UDID" appearance light

log "done — proof screenshots in $PROOF"
ls -la "$PROOF"
