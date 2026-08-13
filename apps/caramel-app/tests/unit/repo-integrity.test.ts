import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// F-015 — repo-integrity gate (rules-become-checks).
//
// This file used to hold a second invariant — "the extension manifests
// reference only files that exist" (the audit had found manifest-firefox.json
// shipping a deleted amazon.js to Firefox users). That invariant moved with
// the WXT migration (P1, 2026-08-13): the hand-maintained manifests are gone,
// WXT generates them from the entrypoint import graph, and the
// missing-reference check now runs against the real BUILT output for both
// browsers in apps/caramel-extension/scripts/parity-harness.mjs — a stronger
// home, since it checks what actually ships rather than a committed twin.

const REPO_ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../..',
)

// A repo root should hold only files a human intentionally put there for
// tooling/workspace reasons — everything else (stray scratch output,
// committed error logs, OS artifacts) is a finding waiting to happen
// (AIH-3). Checked against `git ls-files`, not a raw directory listing, so
// untracked local artifacts (editor state, a stray Windows `nul` file —
// see .gitignore) never trip this in a dev's working copy; only what
// actually ships in the repo counts.
const ROOT_FILE_ALLOWLIST = new Set([
    '.dockerignore',
    '.gitattributes',
    '.gitignore',
    '.oxlintrc.json',
    '.prettierignore',
    '.prettierrc.json',
    'CLAUDE.md',
    'DESIGN.md',
    'Dockerfile',
    'LICENSE',
    'README.md',
    'RUNBOOK.md',
    // One-root-compose (F-016): THE prod service graph lives at repo root.
    'docker-compose.yml',
    'docker-entrypoint.sh',
    'eslint.config.mjs',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'turbo.json',
])

function trackedRootFiles(): string[] {
    const out = execFileSync('git', ['ls-files'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
    })
    return out
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.includes('/'))
}

describe('repo-integrity (F-015): root-file allowlist', () => {
    it('every git-tracked file at repo root is on the allowlist', () => {
        const strays = trackedRootFiles().filter(
            file => !ROOT_FILE_ALLOWLIST.has(file),
        )
        expect(strays).toEqual([])
    })
})
