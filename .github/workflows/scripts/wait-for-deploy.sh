#!/usr/bin/env bash
#
# Blocks until the live deployment carries the commit CI is testing: it reports
# that exact commit, or a DESCENDANT of it.
#
# The E2E suite this gates runs against the DEPLOYED site on purpose
# (deployed-real journey gates), which means every push races CI against the
# platform's autodeploy of that same commit. Proven 2026-08-06: commit
# a625be9's own test failed at 14:40:44Z, two seconds before the deploy
# carrying its fix finished at 14:40:46Z. Five separate red runs that day were
# this race and not a real defect.
#
# Why a descendant counts (T-9435): prod deploys are manual, and one deploy
# builds main's HEAD, so it routinely carries several merges at once. On
# 2026-10-27 prod went from 0bbad60f straight to 6ca69b67; the main runs for
# bf7ee15b and 01a4097c could then never see their own sha served, however
# often they were re-run. A deployment whose sha has the expected commit as an
# ancestor was built from history that includes that commit.
#
# What a descendant pass does NOT prove: that the commit's code is still
# present (a later revert would still pass). E2E tests the SERVED build, which
# is the point of this gate; ancestry only says the deploy is not older than
# the commit.
#
# Inputs (environment):
#   VERSION_URL   - the deployment's /api/version endpoint
#   EXPECTED_SHA  - the commit CI checked out (github.sha)
#   GITHUB_REPOSITORY, GH_TOKEN - owner/name and token for `gh api`, used to ask
#                                 GitHub's compare API whether the served sha is
#                                 a descendant. Without `gh` or GITHUB_REPOSITORY
#                                 (a developer running this by hand) the script
#                                 says so once and accepts an exact match only.
#   DEPLOY_WAIT_TIMEOUT_SECONDS   - optional, default 600
#   DEPLOY_WAIT_INTERVAL_SECONDS  - optional, default 15
#   DEPLOY_WAIT_HINT              - optional, printed verbatim on failure. For
#                                   branches whose deploy is MANUAL, the generic
#                                   "the deploy failed or is slow" guidance below
#                                   is wrong; this is where a branch says so.
#
# Nothing here passes on a missing sha or one that is not provably the expected
# commit or its descendant. The ancestry check fails CLOSED: `behind`,
# `diverged`, an unknown sha, an API error or an unreachable API all mean "not
# carried yet" and are named in the failure text; none of them ever passes.
# A 404 counts as "not deployed yet", never as a pass: the deploy that carries
# this commit is also the deploy that carries the endpoint, so the endpoint
# appearing IS part of the signal. Treating 404 as a pass would silently restore the race on every
# deployment that failed before serving.

set -euo pipefail

: "${VERSION_URL:?VERSION_URL is required}"
: "${EXPECTED_SHA:?EXPECTED_SHA is required}"

timeout_seconds="${DEPLOY_WAIT_TIMEOUT_SECONDS:-600}"
interval_seconds="${DEPLOY_WAIT_INTERVAL_SECONDS:-15}"

ancestry_available=1
if ! command -v gh >/dev/null 2>&1 || [ -z "${GITHUB_REPOSITORY:-}" ]; then
    ancestry_available=0
    echo "gh or GITHUB_REPOSITORY is missing: ancestry check unavailable, accepting an exact sha match only."
fi

# Prints "ahead" | "identical" | "behind" | "diverged" for a served sha, or
# "error: <why>" when GitHub could not answer. Never exits non-zero, so the
# caller's `set -e` cannot turn an API failure into an unexplained crash.
compare_status() {
    local served="$1" out err_file rc=0
    err_file="$(mktemp)"
    out="$(gh api "repos/${GITHUB_REPOSITORY}/compare/${EXPECTED_SHA}...${served}" --jq .status 2>"$err_file")" || rc=$?
    if [ "$rc" -ne 0 ]; then
        local http first_line
        http="$(grep -o 'HTTP [0-9]*' "$err_file" | head -n 1 | cut -d' ' -f2)"
        # First stderr line only, newlines stripped, capped: an unauthenticated
        # gh (exit 4) must read differently from a network error.
        first_line="$(head -n 1 "$err_file" | tr -d '\r' | cut -c1-150)"
        rm -f "$err_file"
        if [ -n "$http" ]; then
            echo "error: HTTP $http"
        elif [ -n "$first_line" ]; then
            echo "error: gh exit $rc: $first_line"
        else
            echo "error: gh exit $rc"
        fi
        return 0
    fi
    rm -f "$err_file"
    echo "$out"
}

body_file="$(mktemp)"
trap 'rm -f "$body_file"' EXIT

deadline=$(($(date +%s) + timeout_seconds))
attempt=0
last_status="no response"

echo "Waiting for $VERSION_URL to report $EXPECTED_SHA or a descendant of it"
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
        elif [ "$ancestry_available" = "0" ]; then
            last_status="serving $deployed_sha (exact match only: ancestry check unavailable)"
        else
            # Full 40- (sha1) or 64-hex (sha256) object names only, like
            # build-sha.mjs SHA_PATTERN: a short prefix or a hex-named branch
            # could resolve in the compare API and pass on the wrong commit.
            case "$deployed_sha" in
            *[!0-9a-fA-F]*)
                verdict="not-a-sha"
                ;;
            *)
                if [ "${#deployed_sha}" -eq 40 ] || [ "${#deployed_sha}" -eq 64 ]; then
                    verdict="$(compare_status "$deployed_sha")"
                else
                    verdict="not-a-sha"
                fi
                ;;
            esac
            case "$verdict" in
            ahead | identical)
                echo "Deployment is serving $deployed_sha, a descendant of $EXPECTED_SHA; E2E runs against that newer build (after ${attempt} poll(s))."
                exit 0
                ;;
            not-a-sha)
                last_status="serving $deployed_sha (not a full commit sha)"
                ;;
            error:*)
                last_status="serving $deployed_sha (ancestry check failed: ${verdict#error: })"
                ;;
            *)
                last_status="serving $deployed_sha (not a descendant: ${verdict:-empty compare status})"
                ;;
            esac
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

    echo "  poll ${attempt}: ${last_status}; want ${EXPECTED_SHA} or a descendant"
    # Never overshoot the deadline waiting for the next poll.
    remaining=$((deadline - now))
    sleep "$((remaining < interval_seconds ? remaining : interval_seconds))"
done

echo "::error::Deploy never arrived — E2E would test the previous build."
echo "Waited ${timeout_seconds}s for ${VERSION_URL} to report ${EXPECTED_SHA} or a descendant."
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

The site is serving a commit that is neither this one nor a descendant of it
(see the parenthesis after "serving" for which: older/diverged, or the
ancestry check itself failed), so the deploy carrying this commit has not
landed. If a newer push superseded this run, the workflow's concurrency group
should have cancelled it; otherwise the deploy failed or is slower than the
timeout — check the platform's deployment log.
EOF
    ;;
esac

if [ -n "${DEPLOY_WAIT_HINT:-}" ]; then
    printf '\n%s\n' "$DEPLOY_WAIT_HINT"
fi

exit 1
