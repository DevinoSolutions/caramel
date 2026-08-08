#!/usr/bin/env bash
#
# Blocks until the live deployment reports the commit CI is testing.
#
# The E2E suite this gates runs against the DEPLOYED site on purpose
# (deployed-real journey gates), which means every push races CI against the
# platform's autodeploy of that same commit. Proven 2026-08-06: commit
# a625be9's own test failed at 14:40:44Z, two seconds before the deploy
# carrying its fix finished at 14:40:46Z. Five separate red runs that day were
# this race and not a real defect.
#
# Inputs (environment):
#   VERSION_URL   - the deployment's /api/version endpoint
#   EXPECTED_SHA  - the commit CI checked out (github.sha)
#   DEPLOY_WAIT_TIMEOUT_SECONDS   - optional, default 600
#   DEPLOY_WAIT_INTERVAL_SECONDS  - optional, default 15
#
# Nothing here passes on a missing or mismatched sha. A 404 counts as "not
# deployed yet", never as a pass: the deploy that carries this commit is also
# the deploy that carries the endpoint, so the endpoint appearing IS part of
# the signal. Treating 404 as a pass would silently restore the race on every
# deployment that failed before serving.

set -euo pipefail

: "${VERSION_URL:?VERSION_URL is required}"
: "${EXPECTED_SHA:?EXPECTED_SHA is required}"

timeout_seconds="${DEPLOY_WAIT_TIMEOUT_SECONDS:-600}"
interval_seconds="${DEPLOY_WAIT_INTERVAL_SECONDS:-15}"

body_file="$(mktemp)"
trap 'rm -f "$body_file"' EXIT

deadline=$(($(date +%s) + timeout_seconds))
attempt=0
last_status="no response"

echo "Waiting for $VERSION_URL to report $EXPECTED_SHA"
echo "(timeout ${timeout_seconds}s, polling every ${interval_seconds}s)"

while :; do
    attempt=$((attempt + 1))

    # `|| true` keeps a connection failure (deploy mid-restart, DNS blip) as a
    # retryable poll rather than killing the script under `set -e`; curl's own
    # failure is still visible in http_code.
    http_code="$(curl --silent --show-error --location --max-time 15 \
        --output "$body_file" --write-out '%{http_code}' \
        "$VERSION_URL" 2>/dev/null || true)"
    [ -n "$http_code" ] || http_code="000"

    if [ "$http_code" = "200" ]; then
        # Dependency-free extraction: jq is not guaranteed on every runner or
        # on a developer's machine running this script by hand.
        deployed_sha="$(sed -n 's/.*"sha"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$body_file" | head -n 1)"

        if [ "$deployed_sha" = "$EXPECTED_SHA" ]; then
            echo "Deployment is serving $EXPECTED_SHA after ${attempt} poll(s) — running E2E against it."
            exit 0
        fi

        if [ -z "$deployed_sha" ]; then
            last_status="HTTP 200 with no \"sha\" field (body: $(head -c 200 "$body_file"))"
        else
            last_status="serving $deployed_sha"
        fi
    elif [ "$http_code" = "404" ]; then
        last_status="HTTP 404 (endpoint not deployed)"
    else
        last_status="HTTP $http_code"
    fi

    now="$(date +%s)"
    if [ "$now" -ge "$deadline" ]; then
        break
    fi

    echo "  poll ${attempt}: ${last_status}; want ${EXPECTED_SHA}"
    # Never overshoot the deadline waiting for the next poll.
    remaining=$((deadline - now))
    sleep "$((remaining < interval_seconds ? remaining : interval_seconds))"
done

echo "::error::Deploy never arrived — E2E would test the previous build."
echo "Waited ${timeout_seconds}s for ${VERSION_URL} to report ${EXPECTED_SHA}."
echo "Last observed: ${last_status}"

case "$last_status" in
"HTTP 404"*)
    cat <<'EOF'

The endpoint answered 404 for the whole window. Either the deploy for this
commit never ran, or it failed before it could serve. This is also what the
first push introducing /api/version looks like if that deploy failed — check
the platform's deployment log for this commit before assuming the gate is at
fault.
EOF
    ;;
"HTTP 200 with no"*)
    cat <<'EOF'

The endpoint answered but without a "sha" field. The deployed build predates
this contract, or the route's response shape changed — reconcile
apps/caramel-app/src/app/api/version/route.ts with this script.
EOF
    ;;
"serving "*)
    cat <<'EOF'

The site is serving a DIFFERENT commit, so the deploy for this one has not
landed. If a newer push superseded this run, the workflow's concurrency group
should have cancelled it; otherwise the deploy failed or is slower than the
timeout — check the platform's deployment log.
EOF
    ;;
esac

exit 1
