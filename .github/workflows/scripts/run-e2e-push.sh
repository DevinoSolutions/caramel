#!/usr/bin/env bash
#
# Runs the E2E suite against the DEPLOYED site (the e2e-push job) and, when the
# suite fails while production was REDEPLOYED underneath it, reruns the suite
# once against the settled deployment.
#
# Why (T-9427): wait-for-deploy.sh proves the site carried this commit when the
# run STARTED, but prod deploys are manual and land every 20-40 minutes on a
# busy day, and a deploy takes 2-4 minutes to build and then swaps the
# containers. A suite that is already running can straddle the swap: a page's
# HTML comes from one build while its JS chunks are asked of the other (the
# chunk hashes differ), so the page never hydrates and a hydration-gated
# assertion times out. Both red runs of 2026-10-27 were exactly that, each on
# the test that started within seconds of a swap:
#   - run 40454216689, privacy visual test (60s `locator.waitFor` on
#     html[data-hydrated]) began 06:10:37Z; deploy dcac9c17 finished 06:10:29Z.
#   - run 40462114897, profile heading (15s `toBeVisible`) began ~07:01:44Z;
#     deploy 0bbad60f finished 07:01:42Z.
# 165 other tests passed in each and the retried test passed straight away: a
# stable deployment serves a consistent build.
#
# No wait or timeout inside the tests can fix that (the page is waiting for a
# chunk that does not exist on the server it asks), so the fix is at the one
# place that can see the cause: the served sha. It is read before and after the
# run, and ONLY when it CHANGED is a failure attributed to the redeploy:
#   - the failure is announced as a ::warning AND a $GITHUB_STEP_SUMMARY entry,
#     both naming the two shas, the summary also the failed first-attempt tests;
#   - the served sha is awaited until it is stable again;
#   - that settled deployment must still carry EXPECTED_SHA (wait-for-deploy.sh,
#     reused as is: the exact commit or a descendant, fail closed). A rollback
#     or any deploy of an older commit means NO rerun and the original exit code;
#   - the suite runs ONCE more. Its exit code is the job's exit code, so a real
#     regression (or a second deploy straddling the rerun) still fails the job.
# A failure while the sha did NOT change, or when the sha could not be read at
# both ends, fails the job exactly as before: unexplained flakes stay red.
#
# The failed attempt's evidence is already in the log before any rerun: the
# suite's own fixture (e2e/support/test.ts) prints a sanitized failed-request
# list (host + path, status or net:: error, no query/headers/cookies/bodies) at
# the end of every failed attempt. Traces are never uploaded (the repo is
# public), so that list is how the next incident says "chunk 404" (deploy race)
# or "net::ERR_*" (a network event on the runner).
#
# Known limits, on purpose:
#   - The rerun may test a NEWER DESCENDANT of the commit under test, not the
#     commit itself (the same allowance wait-for-deploy.sh makes, T-9435).
#   - The trigger is the whole run window, not the failing test's start time.
#     A real intermittent failure that happens to fall in a window where a
#     deploy landed gets one rerun and can go green. That residual risk is
#     bounded to one rerun and made loud (::warning + step summary naming the
#     failed tests), not hidden.
#   - A redeploy of the SAME sha (restart, rebuild of one commit) is not
#     detected: the sha is the only signal read.
#
# Inputs (environment):
#   VERSION_URL   - the deployment's /api/version endpoint (same as
#                   wait-for-deploy.sh)
#   EXPECTED_SHA  - the commit CI is testing (github.sha); GH_TOKEN and
#                   GITHUB_REPOSITORY are used by wait-for-deploy.sh for the
#                   ancestry check
#   E2E_COMMAND   - optional, the suite command; default `pnpm test:e2e`
#   E2E_SETTLE_POLLS             - optional, default 18 (reads while waiting for
#                                  the served sha to stop changing)
#   E2E_SETTLE_INTERVAL_SECONDS  - optional, default 10
#   E2E_READ_POLLS               - optional, default 3 (reads for the before and
#                                  after sha; a swap can 502 for several seconds)
#   E2E_READ_INTERVAL_SECONDS    - optional, default 10
#
# Run it from apps/caramel-app (the suite's working directory).

set -uo pipefail

: "${VERSION_URL:?VERSION_URL is required}"
: "${EXPECTED_SHA:?EXPECTED_SHA is required}"

e2e_command="${E2E_COMMAND:-pnpm test:e2e}"
settle_polls="${E2E_SETTLE_POLLS:-18}"
settle_interval="${E2E_SETTLE_INTERVAL_SECONDS:-10}"
read_polls="${E2E_READ_POLLS:-3}"
read_interval="${E2E_READ_INTERVAL_SECONDS:-10}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

body_file="$(mktemp)"
run_log="$(mktemp)"
trap 'rm -f "$body_file" "$run_log"' EXIT

# Prints the sha /api/version reports now, or nothing when it cannot be read
# (deploy mid-restart, non-200, no sha field, curl failure). Never exits
# non-zero.
served_sha() {
    local http_code
    http_code="$(curl --silent --show-error --location --max-time 15 \
        --output "$body_file" --write-out '%{http_code}' \
        "$VERSION_URL" 2>/dev/null || true)"
    if [ "$http_code" = "200" ]; then
        sed -n 's/.*"sha"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$body_file" | head -n 1
    fi
    return 0
}

# The first sha readable within the read budget, else nothing. During a
# container swap the proxy can answer 502/503 for several seconds, so a single
# read is not evidence of anything.
read_sha_retrying() {
    local sha poll
    for poll in $(seq 1 "$read_polls"); do
        sha="$(served_sha)"
        if [ -n "$sha" ]; then
            echo "$sha"
            return 0
        fi
        if [ "$poll" -lt "$read_polls" ]; then
            sleep "$read_interval"
        fi
    done
    return 0
}

# Blocks until two consecutive reads agree on a non-empty sha, then prints it.
# Prints nothing if that never happens within the poll budget.
settled_sha() {
    local previous="" current poll
    for poll in $(seq 1 "$settle_polls"); do
        current="$(served_sha)"
        if [ -n "$current" ] && [ "$current" = "$previous" ]; then
            echo "$current"
            return 0
        fi
        previous="$current"
        sleep "$settle_interval"
    done
    return 0
}

# Appends markdown to the job's step summary. Outside Actions there is none, and
# that is fine; inside, a write that fails is reported, not swallowed.
summary() {
    [ -n "${GITHUB_STEP_SUMMARY:-}" ] || return 0
    if ! printf '%s\n' "$@" >>"$GITHUB_STEP_SUMMARY"; then
        echo "::warning::Could not write to GITHUB_STEP_SUMMARY."
    fi
    return 0
}

# Failed/flaky test titles Playwright printed in the first attempt's output
# ("  1) [chromium] › e2e/x.spec.ts:1:1 › title"), de-duplicated, capped.
failed_test_titles() {
    sed 's/\x1b\[[0-9;]*[A-Za-z]//g' "$run_log" |
        sed -n 's/^[[:space:]]\{1,\}[0-9]\{1,\}) \(\[.*\)$/\1/p' |
        sort -u | head -n 20
}

before_sha="$(read_sha_retrying)"
if [ -z "$before_sha" ]; then
    echo "::warning::Could not read ${VERSION_URL} before the E2E run; a failure cannot be attributed to a redeploy."
else
    echo "E2E starts against ${before_sha} (testing commit ${EXPECTED_SHA})."
fi

run_status=0
bash -c "$e2e_command" 2>&1 | tee "$run_log"
run_status="${PIPESTATUS[0]}"

if [ "$run_status" -eq 0 ]; then
    exit 0
fi

after_sha="$(read_sha_retrying)"

if [ -z "$before_sha" ] || [ -z "$after_sha" ]; then
    echo "E2E failed (exit ${run_status}) and the served sha could not be read at both ends (before='${before_sha}' after='${after_sha}'): not attributing it to a redeploy."
    exit "$run_status"
fi

if [ "$before_sha" = "$after_sha" ]; then
    echo "E2E failed (exit ${run_status}) while production stayed on ${before_sha}: not a redeploy race."
    exit "$run_status"
fi

first_attempt_titles="$(failed_test_titles)"

echo "::warning title=Production redeployed during the E2E run::The suite failed (exit ${run_status}) while ${VERSION_URL} went from ${before_sha} to ${after_sha}. A page that straddles the container swap gets HTML and JS chunks from different builds and never hydrates, so the failure is attributed to the deploy. Waiting for the new deployment to settle, checking it still carries ${EXPECTED_SHA}, and rerunning the suite once (T-9427). The rerun may test a newer descendant of that commit."
summary \
    "### E2E failed across a production redeploy (T-9427)" \
    "" \
    "- Served sha during the run: \`${before_sha}\` -> \`${after_sha}\` (suite exit ${run_status}); commit under test \`${EXPECTED_SHA}\`." \
    "- Failed tests of the first attempt (their sanitized request lists are above in this log):" \
    "$(printf '%s\n' "${first_attempt_titles:-(no failure titles found in the output)}" | sed 's/^/  - /')"

settled="$(settled_sha)"
if [ -z "$settled" ]; then
    echo "::error::Production never settled on one sha after the redeploy (last read: '$(served_sha)'); not rerunning against a moving target."
    summary "- Production never settled on one sha: no rerun, job keeps exit ${run_status}."
    exit "$run_status"
fi

# The settled deployment must still be the commit under test or a descendant of
# it: a rollback after the swap would otherwise turn the rerun green on a build
# that lacks the commit. Reuses the gate's own logic, polled once (the sha has
# just settled; there is nothing left to wait for).
if ! DEPLOY_WAIT_TIMEOUT_SECONDS=0 bash "${script_dir}/wait-for-deploy.sh"; then
    echo "::error::The settled deployment (${settled}) does not carry ${EXPECTED_SHA}; not rerunning, keeping the original failure (exit ${run_status})."
    summary "- The settled deployment \`${settled}\` does not carry the commit under test: no rerun, job keeps exit ${run_status}."
    exit "$run_status"
fi

echo "Production settled on ${settled}; rerunning E2E once."
summary "- Production settled on \`${settled}\` (the commit under test or a newer descendant); rerunning the suite once."
rerun_status=0
bash -c "$e2e_command" || rerun_status=$?

if [ "$rerun_status" -eq 0 ]; then
    echo "::warning title=E2E passed on the post-redeploy rerun::The first run failed across a production redeploy (${before_sha} to ${after_sha}); the rerun against ${settled} is green."
    summary "- Rerun against \`${settled}\`: **passed**. The first attempt's failures above are attributed to the redeploy."
else
    summary "- Rerun against \`${settled}\`: **failed** (exit ${rerun_status}); the job fails."
fi
exit "$rerun_status"
