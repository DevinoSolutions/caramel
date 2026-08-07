// Resolves the commit a build was produced from, so the running deployment can
// answer "which commit am I?" over /api/version.
//
// Why this exists: the push E2E suite runs against the LIVE deployment, so CI
// races the platform's autodeploy of the same commit. A deployment that can
// name its own commit lets CI wait for the right build instead of testing the
// previous one (see .github/workflows/scripts/wait-for-deploy.sh).
//
// Two consumers, one resolution order:
//   * next.config.mjs imports resolveBuildSha() and inlines the result into
//     the bundle via `env` — the value is fixed at BUILD time, so it can never
//     drift from the code that ships with it.
//   * the root Dockerfile runs this file as a CLI in the pruner stage, where
//     the git metadata still exists, and hands the answer to the builder stage
//     as GIT_COMMIT_SHA (`turbo prune` does not carry .git forward).
//
// Plain .mjs, no dependencies and no `git` binary: next.config.mjs is ESM
// loaded before any TS toolchain exists, and the Docker build stages have node
// but not git.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Reported when no commit can be determined. Never a plausible-looking sha —
 * a caller that compares against a real commit must fail, not coincide. */
export const UNKNOWN_SHA = 'unknown'

// sha-1 (40) or sha-256 (64) object names.
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))

// Absence — a path that does not exist, or exists but cannot be read — is a
// normal outcome here, not a swallowed failure: every reader below turns null
// into the single loud UNKNOWN_SHA fallback its caller reports once.
function readFileOrNull(file) {
    try {
        return fs.readFileSync(file, 'utf8')
    } catch {
        return null
    }
}

function readFirstLine(file) {
    const content = readFileOrNull(file)
    return content === null ? null : content.split('\n', 1)[0].trim()
}

/** Nearest ancestor directory containing a `.git` entry, or null. */
function findGitEntry(startDir) {
    let dir = path.resolve(startDir)
    for (;;) {
        const candidate = path.join(dir, '.git')
        if (fs.existsSync(candidate)) return candidate
        const parent = path.dirname(dir)
        if (parent === dir) return null
        dir = parent
    }
}

/**
 * `.git` is a DIRECTORY in a normal clone but a FILE ("gitdir: <path>") in a
 * linked worktree — and a worktree keeps only HEAD locally while the branch
 * refs stay in the main clone's common dir. Both are returned so a ref lookup
 * can try the worktree first and fall back to the shared store.
 */
function resolveGitDirs(gitEntry) {
    let stat
    try {
        stat = fs.statSync(gitEntry)
    } catch {
        return null
    }
    if (stat.isDirectory()) return { gitDir: gitEntry, commonDir: gitEntry }

    const pointer = readFirstLine(gitEntry)
    if (!pointer || !pointer.startsWith('gitdir:')) return null
    const gitDir = path.resolve(
        path.dirname(gitEntry),
        pointer.slice('gitdir:'.length).trim(),
    )
    const commonDir = readFirstLine(path.join(gitDir, 'commondir'))
    return {
        gitDir,
        commonDir: commonDir ? path.resolve(gitDir, commonDir) : gitDir,
    }
}

/** Looks a symbolic ref up as a loose ref file, then in packed-refs. */
function resolveRef(ref, searchDirs) {
    for (const base of searchDirs) {
        const loose = readFirstLine(path.join(base, ...ref.split('/')))
        if (loose && SHA_PATTERN.test(loose)) return loose.toLowerCase()
    }
    // packed-refs lines are "<sha> <refname>"; "#" heads the trailer comment
    // and "^" prefixes a peeled tag target, neither of which is a ref line.
    for (const base of searchDirs) {
        const packed = readFileOrNull(path.join(base, 'packed-refs'))
        if (packed === null) continue
        for (const line of packed.split('\n')) {
            const trimmed = line.trim()
            if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('^'))
                continue
            const [sha, name] = trimmed.split(/\s+/)
            if (name === ref && SHA_PATTERN.test(sha)) return sha.toLowerCase()
        }
    }
    return null
}

/**
 * Commit from on-disk git metadata at or above `startDir`, or null.
 * @param {string} startDir
 * @returns {string | null}
 */
export function readShaFromGitMetadata(startDir) {
    const gitEntry = findGitEntry(startDir)
    if (!gitEntry) return null
    const dirs = resolveGitDirs(gitEntry)
    if (!dirs) return null

    const head = readFirstLine(path.join(dirs.gitDir, 'HEAD'))
    if (!head) return null
    // Detached HEAD (a platform that checks out an exact commit) stores the
    // object name directly instead of a symbolic ref.
    if (SHA_PATTERN.test(head)) return head.toLowerCase()
    if (!head.startsWith('ref:')) return null

    return resolveRef(head.slice('ref:'.length).trim(), [
        dirs.gitDir,
        dirs.commonDir,
    ])
}

/**
 * GIT_COMMIT_SHA wins when it holds a real object name — that is how the
 * Docker builder stage receives the commit the pruner stage read, and how a
 * platform that knows its commit can supply it directly. Otherwise the git
 * metadata around this file is read. UNKNOWN_SHA when neither answers.
 * @param {{ env?: Record<string, string | undefined>, startDir?: string }} [options]
 * @returns {string}
 */
export function resolveBuildSha({
    env = process.env,
    startDir = MODULE_DIR,
} = {}) {
    const fromEnv = (env.GIT_COMMIT_SHA ?? '').trim()
    if (SHA_PATTERN.test(fromEnv)) return fromEnv.toLowerCase()
    return readShaFromGitMetadata(startDir) ?? UNKNOWN_SHA
}

// CLI mode (the Dockerfile's pruner stage): the commit on stdout, and — when
// there is none — a warning on stderr naming what breaks. Exit stays 0 so a
// context without git metadata degrades the deploy gate instead of failing the
// image build.
const invokedDirectly =
    process.argv[1] !== undefined &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
    const sha = resolveBuildSha()
    if (sha === UNKNOWN_SHA) {
        process.stderr.write(
            '[build-sha] no git metadata in this build context — /api/version ' +
                'will report "unknown" and CI\'s deploy gate cannot confirm ' +
                'this build\n',
        )
    }
    process.stdout.write(`${sha}\n`)
}
