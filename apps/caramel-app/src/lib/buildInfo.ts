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
