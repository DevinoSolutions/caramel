#!/usr/bin/env bash
# T-8305 proof: walk the shell on a fresh iOS simulator and measure the /profile <-> /login
# bounce loop (Sentry CARAMEL-2Y). Usage: run.sh <app.app> <out_dir> <expect: loop|no-loop>
# Verdict rules:
#   no-loop (fixed build): "Sign in to see this page" settles (flow B), the Saved screen is
#     visually stable over ~5 s (<= 2 distinct frames), and the sign-in sheet opens and
#     cancels back to the settled state (flow C).
#   loop (pre-fix 1.6.0): the settled state never appears or the screen keeps changing;
#     this shows the detector catches the bug, so the job counts it as expected.
set -uo pipefail
APP="$1"; OUT="$2"; EXPECT="$3"
HERE="$(cd "$(dirname "$0")" && pwd)"
BUNDLE_ID=com.devino.Caramel
mkdir -p "$OUT"
export PATH="$HOME/.maestro/bin:$PATH"
command -v jq >/dev/null || brew install jq >/dev/null
command -v maestro >/dev/null || { echo "::error::maestro is not installed on this runner"; exit 1; }

# Fresh simulator: the newest iOS runtime + the newest "iPhone NN Pro" device type it supports.
RUNTIME=$(xcrun simctl list runtimes -j | jq -r '[.runtimes[] | select(.isAvailable and (.identifier | test("iOS")))] | sort_by(.version | split(".") | map(tonumber)) | last | .identifier')
DEVTYPE=$(xcrun simctl list runtimes -j | jq -r --arg rt "$RUNTIME" '.runtimes[] | select(.identifier==$rt) | [.supportedDeviceTypes[] | select(.name | test("^iPhone [0-9]+ Pro$"))] | last | .identifier')
[ -n "$RUNTIME" ] && [ -n "$DEVTYPE" ] || { echo "::error::no iOS runtime / iPhone Pro device type"; exit 1; }
UDID=$(xcrun simctl create "t8305-$(basename "$OUT")-$$" "$DEVTYPE" "$RUNTIME")
echo "simulator $UDID ($DEVTYPE, $RUNTIME)"
cleanup() { xcrun simctl shutdown "$UDID" >/dev/null 2>&1; xcrun simctl delete "$UDID" >/dev/null 2>&1; }
trap cleanup EXIT
xcrun simctl boot "$UDID"
xcrun simctl bootstatus "$UDID" -b >/dev/null
# Freeze the status bar so identical screens hash identically.
xcrun simctl status_bar "$UDID" override --time 9:41 --batteryState charged --batteryLevel 100 --wifiBars 3 --cellularBars 4 --dataNetwork wifi
xcrun simctl install "$UDID" "$APP"

xcrun simctl spawn "$UDID" log stream --level debug --style compact \
  --predicate 'subsystem == "com.devino.Caramel"' > "$OUT/app-log.txt" 2>&1 &
LOGPID=$!

cd "$OUT"
maestro --device "$UDID" test "$HERE/flow-a-walk.yaml" > flow-a.txt 2>&1; A=$?

# Burst: the pre-fix loop flips /profile <-> /login every ~150 ms. Wait out the first
# bounce, then photograph the Saved screen repeatedly and count distinct frames.
sleep 4
mkdir -p burst
for i in $(seq -w 1 12); do xcrun simctl io "$UDID" screenshot --type=png "burst/$i.png" >/dev/null 2>&1; sleep 0.25; done
DISTINCT=$(md5 -q burst/*.png | sort -u | wc -l | tr -d ' ')
cp burst/01.png 03-saved-after-bounce.png

maestro --device "$UDID" test "$HERE/flow-b-settled.yaml" > flow-b.txt 2>&1; B=$?
C=skipped
if [ "$B" = 0 ]; then maestro --device "$UDID" test "$HERE/flow-c-signin-sheet.yaml" > flow-c.txt 2>&1; C=$?; fi
kill "$LOGPID" 2>/dev/null
BOUNCE_LOGS=$(grep -c "bounced to sign-in again" app-log.txt || true)

echo "flowA=$A flowB=$B flowC=$C distinctFrames=$DISTINCT/12 guardLogs=$BOUNCE_LOGS" | tee summary.txt
if [ "$EXPECT" = no-loop ]; then
  if [ "$A" = 0 ] && [ "$B" = 0 ] && [ "$C" = 0 ] && [ "$DISTINCT" -le 2 ]; then
    echo "VERDICT=PASS (no loop: settled on the sign-in state, screen stable, sheet opens and cancels)" | tee -a summary.txt; RC=0
  else
    echo "VERDICT=FAIL (expected no loop)" | tee -a summary.txt; RC=1
  fi
else
  if [ "$A" = 0 ] && { [ "$B" != 0 ] || [ "$DISTINCT" -gt 2 ]; }; then
    echo "VERDICT=LOOP-REPRODUCED (the detector catches the CARAMEL-2Y loop on the pre-fix build)" | tee -a summary.txt; RC=0
  else
    echo "VERDICT=INCONCLUSIVE (pre-fix build did not show the loop under this detector)" | tee -a summary.txt; RC=1
  fi
fi
# Small previews in the log so the result can be checked without the artifact store.
for f in 01-onboarding 02-deals 03-saved-after-bounce 04-saved-settled 06-signin-sheet 07-after-cancel; do
  [ -f "$f.png" ] || continue
  sips -Z 360 -s format jpeg -s formatOptions 40 "$f.png" --out "/tmp/prev-$$.jpg" >/dev/null 2>&1 || continue
  echo "PREVIEW-BEGIN $f"; base64 -i "/tmp/prev-$$.jpg" | tr -d '\n'; echo; echo "PREVIEW-END $f"
done
rm -f "/tmp/prev-$$.jpg"
exit "$RC"
