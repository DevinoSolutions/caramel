#!/usr/bin/env bash
# T-8305 proof: walk the shell on a fresh iOS simulator and measure the /profile <-> /login
# bounce loop (Sentry CARAMEL-2Y). Usage: run.sh <app.app> <out_dir> <expect: no-loop|control>
# Verdict rules:
#   The detector is WebKit's own navigation log in the app process (WebPageProxy
#   decidePolicyForNavigationAction lines), counted over a 6 s window after the Saved tab
#   opened: it needs nothing from the app, so it works on both builds.
#   no-loop (fixed build): <= 3 navigations in the window, the screen is stable
#     (<= 2 distinct frames), the sign-in sheet shows (flow B) and opens + cancels back
#     to the settled sign-in state (flow C).
#   loop (pre-fix 1.6.0): >= 6 navigations in the window (it bounces every ~150 ms) or
#     the screen keeps changing; the job counts that as the expected result.
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
DEVTYPE=$(xcrun simctl list runtimes -j | jq -r --arg rt "$RUNTIME" '.runtimes[] | select(.identifier==$rt) | [.supportedDeviceTypes[] | select(.name | test("^iPhone [0-9]+ Pro$"))] | sort_by(.name | capture("(?<n>[0-9]+)").n | tonumber) | last | .identifier')
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
xcrun simctl spawn "$UDID" log stream --level debug --style compact   --predicate 'subsystem == "com.apple.WebKit" AND category == "Loading" AND eventMessage CONTAINS "decidePolicyForNavigationAction"' > "$OUT/webkit-nav.txt" 2>&1 &
NAVPID=$!
# Maestro writes takeScreenshot files next to the flow or into its own test dir; gather them.
collect() { for d in "$OUT/maestro" "$HERE" "$HOME/.maestro"; do find "$d" -name '0[0-9]-*.png' -newer "$OUT/.start" -exec mv -f {} "$OUT/" \; 2>/dev/null; done; }
touch "$OUT/.start"

cd "$OUT"
maestro --device "$UDID" test --test-output-dir "$OUT/maestro" "$HERE/flow-a-walk.yaml" > flow-a.txt 2>&1; A=$?; collect

# Burst: the pre-fix loop flips /profile <-> /login every ~150 ms. Wait out the first
# bounce, then photograph the Saved screen repeatedly and count distinct frames.
sleep 2
NAV0=$(grep -c decidePolicyForNavigationAction webkit-nav.txt || true)
mkdir -p burst
for i in $(seq -w 1 12); do xcrun simctl io "$UDID" screenshot --type=png "burst/$i.png" >/dev/null 2>&1; sleep 0.25; done
sleep $((6 - 3)) # the burst takes ~3 s; the window is 6 s in total
NAV1=$(grep -c decidePolicyForNavigationAction webkit-nav.txt || true)
NAVS=$((NAV1 - NAV0))
DISTINCT=$(md5 -q burst/*.png | sort -u | wc -l | tr -d ' ')
cp burst/01.png 03-saved-after-bounce.png

maestro --device "$UDID" test --test-output-dir "$OUT/maestro" "$HERE/flow-b-settled.yaml" > flow-b.txt 2>&1; B=$?; collect
C=skipped
if [ "$B" = 0 ]; then maestro --device "$UDID" test --test-output-dir "$OUT/maestro" "$HERE/flow-c-signin-sheet.yaml" > flow-c.txt 2>&1; C=$?; collect; fi
kill "$LOGPID" "$NAVPID" 2>/dev/null
BOUNCE_LOGS=$(grep -c "bounced to sign-in again" app-log.txt || true)

echo "flowA=$A flowB=$B flowC=$C navigationsIn6s=$NAVS distinctFrames=$DISTINCT/12 guardLogs=$BOUNCE_LOGS" | tee summary.txt
echo "--- WebKit navigations (first 8 of the run)"; grep decidePolicyForNavigationAction webkit-nav.txt | head -8 | cut -c1-220
for f in flow-a flow-b flow-c; do [ -f "$f.txt" ] && { echo "--- $f"; grep -vE '^\s+at ' "$f.txt" | tail -14; }; done
echo "--- screenshots: $(ls 0*.png 2>/dev/null | tr '
' ' ')"
if [ "$EXPECT" = no-loop ]; then
  if [ "$A" = 0 ] && [ "$B" = 0 ] && [ "$C" = 0 ] && [ "$NAVS" -le 3 ] && [ "$DISTINCT" -le 2 ]; then
    echo "VERDICT=PASS (no loop: settled on the sign-in state, screen stable, sheet opens and cancels)" | tee -a summary.txt; RC=0
  else
    echo "VERDICT=FAIL (expected no loop)" | tee -a summary.txt; RC=1
  fi
else
  # control: the same signed-out walk on the pre-fix build, reported, never failing the job.
  if [ "$NAVS" -ge 6 ] || [ "$DISTINCT" -gt 2 ]; then
    echo "VERDICT=CONTROL-LOOPS (the pre-fix build loops on the signed-out walk)" | tee -a summary.txt
  else
    echo "VERDICT=CONTROL-NO-LOOP (the pre-fix build does not loop signed out: CARAMEL-2Y needs a native session)" | tee -a summary.txt
  fi
  RC=0
fi
# Small previews in the log so the result can be checked without the artifact store.
for f in 01-onboarding 02-deals 03-saved-after-bounce 04-saved-settled 05-auth-consent 06-signin-sheet 07-after-cancel; do
  [ -f "$f.png" ] || continue
  sips -Z 360 -s format jpeg -s formatOptions 40 "$f.png" --out "/tmp/prev-$$.jpg" >/dev/null 2>&1 || continue
  echo "PREVIEW-BEGIN $f"; base64 -i "/tmp/prev-$$.jpg" | tr -d '\n'; echo; echo "PREVIEW-END $f"
done
rm -f "/tmp/prev-$$.jpg"
exit "$RC"
