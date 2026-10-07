// The commit this bundle was built from, for /api/version.
//
// Deliberately NOT behind the env door (src/lib/env.ts), and the env-door lint
// rule carries a matching exception for this file. Two reasons, both hard:
//
//  1. This is not a runtime value. next.config.mjs's `env` inlines it at BUILD
//     time by replacing the literal `process.env.GIT_COMMIT_SHA` expression
//     below with a string. Nothing sets GIT_COMMIT_SHA in the running
//     container, so a runtime read would always be undefined — the point is
//     that the value is frozen to the code it ships with.
//  2. env.ts parses `process.env` as a whole object, so it contains no literal
//     member expression for the inliner to rewrite. Routing this through it
//     would silently produce undefined. The same applies to destructuring here
//     — the inline only fires on this exact member expression.
//
// See apps/caramel-app/scripts/build-sha.mjs for how the value is resolved in
// each build context, and .github/workflows/scripts/wait-for-deploy.sh for the
// CI gate that consumes it.
export const BUILD_SHA: string = process.env.GIT_COMMIT_SHA ?? 'unknown'

// The Sentry `release` every init (server, edge, browser) reports, so each
// event carries the commit that produced it. Before this every event had
// release: null, which made 'is it fixed in the deployed build?' unanswerable.
// undefined — not the string 'unknown' — when the build could not resolve a
// commit: Sentry then records no release instead of a bogus one that groups
// unrelated builds together. Lives here, next to the inlined sha, because the
// same build-time inlining caveat applies (see the header above).
export const SENTRY_RELEASE: string | undefined =
    BUILD_SHA === 'unknown' ? undefined : BUILD_SHA
