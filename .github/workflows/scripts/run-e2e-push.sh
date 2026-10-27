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
#   - the failure is announced as a ::warning (never silent), naming both shas;
#   - the served sha is awaited until it is stable again;
#   - the suite runs ONCE more. Its exit code is the job's exit code, so a real
#     regression (or a second deploy straddling the rerun) still fails the job.
# A failure while the sha did NOT change, or when the sha could not be read at
# both ends, fails the job exactly as before: unexplained flakes stay red.
#
# Inputs (environment):
#   VERSION_URL   - the deployment's /api/version endpoint (same as
#                   wait-for-deploy.sh)
#   E2E_COMMAND   - optional, the suite command; default `pnpm test:e2e`
#   E2E_SETTLE_POLLS             - optional, default 18 (reads while waiting for
#                                  the served sha to stop changing)
#   E2E_SETTLE_INTERVAL_SECONDS  - optional, default 10
#
# Run it from apps/caramel-app (the suite's working directory).

set -uo pipefail

: "${VERSION_URL:?VERSION_URL is required}"

e2e_command="${E2E_COMMAND:-pnpm test:e2e}"
settle_polls="${E2E_SETTLE_POLLS:-18}"
settle_interval="${E2E_SETTLE_INTERVAL_SECONDS:-10}"

body_file="$(mktemp)"
trap 'rm -f "$body_file"' EXIT

# Prints the sha /api/version reports now, or nothing when it cannot be read
# (deploy mid-restart, non-200, no sha field). Never exits non-zero.
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

before_sha="$(served_sha)"
if [ -z "$before_sha" ]; then
    echo "::warning::Could not read ${VERSION_URL} before the E2E run; a failure cannot be attributed to a redeploy."
else
    echo "E2E starts against ${before_sha}."
fi

run_status=0
bash -c "$e2e_command" || run_status=$?

if [ "$run_status" -eq 0 ]; then
    exit 0
fi

after_sha="$(served_sha)"

if [ -z "$before_sha" ] || [ -z "$after_sha" ]; then
    echo "E2E failed (exit ${run_status}) and the served sha could not be read at both ends (before='${before_sha}' after='${after_sha}'): not attributing it to a redeploy."
    exit "$run_status"
fi

if [ "$before_sha" = "$after_sha" ]; then
    echo "E2E failed (exit ${run_status}) while production stayed on ${before_sha}: not a redeploy race."
    exit "$run_status"
fi

echo "::warning title=Production redeployed during the E2E run::The suite failed (exit ${run_status}) while ${VERSION_URL} went from ${before_sha} to ${after_sha}. A page that straddles the container swap gets HTML and JS chunks from different builds and never hydrates, so the failure is attributed to the deploy. Waiting for the new deployment to settle and rerunning the suite once (T-9427)."

settled="$(settled_sha)"
if [ -z "$settled" ]; then
    echo "::error::Production never settled on one sha after the redeploy (last read: '$(served_sha)'); not rerunning against a moving target."
    exit "$run_status"
fi

echo "Production settled on ${settled}; rerunning E2E once."
rerun_status=0
bash -c "$e2e_command" || rerun_status=$?

if [ "$rerun_status" -eq 0 ]; then
    echo "::warning title=E2E passed on the post-redeploy rerun::The first run failed across a production redeploy (${before_sha} to ${after_sha}); the rerun against ${settled} is green."
fi
exit "$rerun_status"
