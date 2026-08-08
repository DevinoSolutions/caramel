import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
    UNKNOWN_SHA,
    readShaFromGitMetadata,
    resolveBuildSha,
} from '../../scripts/build-sha.mjs'

// The commit stamped into the build feeds CI's deploy gate
// (.github/workflows/scripts/wait-for-deploy.sh), which refuses to run E2E
// against the live site until the site reports the commit under test. Every
// layout below is one this resolver actually meets:
//   - loose ref            a plain clone with the checked-out branch unpacked
//   - packed-refs          a fresh `git clone`, which packs refs
//   - detached HEAD        a platform that checks out an exact commit
//   - worktree             `.git` is a FILE and the branch ref lives in the
//                          main clone's common dir, not beside HEAD
// The "no metadata" case must return UNKNOWN_SHA rather than throwing: it is
// reached inside a Docker build stage, where throwing would fail the image.

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const OTHER_SHA = '00112233445566778899aabbccddeeff00112233'

const tempRoots: string[] = []

function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-sha-'))
    tempRoots.push(dir)
    return dir
}

/** Writes `content` to `file`, creating parent directories. */
function write(file: string, content: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
}

afterEach(() => {
    while (tempRoots.length > 0) {
        const dir = tempRoots.pop()
        if (dir) fs.rmSync(dir, { recursive: true, force: true })
    }
})

describe('readShaFromGitMetadata (git layouts a real build meets)', () => {
    it('reads a loose ref through the symbolic HEAD', () => {
        const root = makeTempDir()
        write(path.join(root, '.git/HEAD'), 'ref: refs/heads/dev\n')
        write(path.join(root, '.git/refs/heads/dev'), `${SHA}\n`)

        expect(readShaFromGitMetadata(root)).toBe(SHA)
    })

    it('falls back to packed-refs when the ref is not loose (a fresh clone)', () => {
        const root = makeTempDir()
        write(path.join(root, '.git/HEAD'), 'ref: refs/heads/dev\n')
        write(
            path.join(root, '.git/packed-refs'),
            [
                '# pack-refs with: peeled fully-peeled sorted',
                `${OTHER_SHA} refs/heads/main`,
                `${SHA} refs/heads/dev`,
                `${OTHER_SHA} refs/tags/v1`,
                `^${OTHER_SHA}`,
                '',
            ].join('\n'),
        )

        expect(readShaFromGitMetadata(root)).toBe(SHA)
    })

    it('reads a detached HEAD, which stores the commit directly', () => {
        const root = makeTempDir()
        write(path.join(root, '.git/HEAD'), `${SHA}\n`)

        expect(readShaFromGitMetadata(root)).toBe(SHA)
    })

    it('resolves a worktree, whose .git is a FILE and whose ref lives in the common dir', () => {
        // The layout `git worktree add` produces: HEAD is worktree-local, the
        // branch ref is only in the main clone. Reading HEAD alone finds
        // nothing, which is why commondir is followed.
        const root = makeTempDir()
        const mainGitDir = path.join(root, 'main-clone/.git')
        const worktreeGitDir = path.join(mainGitDir, 'worktrees/feature')
        const worktree = path.join(root, 'feature')

        write(path.join(worktreeGitDir, 'HEAD'), 'ref: refs/heads/dev\n')
        write(path.join(worktreeGitDir, 'commondir'), '../..\n')
        write(path.join(mainGitDir, 'refs/heads/dev'), `${SHA}\n`)
        write(path.join(worktree, '.git'), `gitdir: ${worktreeGitDir}\n`)

        expect(readShaFromGitMetadata(worktree)).toBe(SHA)
    })

    it('prefers the worktree-local ref over the common dir when both exist', () => {
        const root = makeTempDir()
        const mainGitDir = path.join(root, 'main-clone/.git')
        const worktreeGitDir = path.join(mainGitDir, 'worktrees/feature')
        const worktree = path.join(root, 'feature')

        write(path.join(worktreeGitDir, 'HEAD'), 'ref: refs/heads/dev\n')
        write(path.join(worktreeGitDir, 'commondir'), '../..\n')
        write(path.join(worktreeGitDir, 'refs/heads/dev'), `${SHA}\n`)
        write(path.join(mainGitDir, 'refs/heads/dev'), `${OTHER_SHA}\n`)
        write(path.join(worktree, '.git'), `gitdir: ${worktreeGitDir}\n`)

        expect(readShaFromGitMetadata(worktree)).toBe(SHA)
    })

    it('walks up to an ancestor .git, as next build does from apps/caramel-app', () => {
        const root = makeTempDir()
        write(path.join(root, '.git/HEAD'), `${SHA}\n`)
        const nested = path.join(root, 'apps/caramel-app')
        fs.mkdirSync(nested, { recursive: true })

        expect(readShaFromGitMetadata(nested)).toBe(SHA)
    })

    it('reports absence rather than throwing when there is no git metadata', () => {
        const root = makeTempDir()
        expect(readShaFromGitMetadata(root)).toBeNull()
    })

    it('reports absence when HEAD points at a ref that resolves nowhere', () => {
        const root = makeTempDir()
        write(path.join(root, '.git/HEAD'), 'ref: refs/heads/deleted\n')
        write(path.join(root, '.git/refs/heads/dev'), `${SHA}\n`)

        expect(readShaFromGitMetadata(root)).toBeNull()
    })

    it('rejects a ref file whose contents are not a commit', () => {
        const root = makeTempDir()
        write(path.join(root, '.git/HEAD'), 'ref: refs/heads/dev\n')
        write(path.join(root, '.git/refs/heads/dev'), 'not-a-sha\n')

        expect(readShaFromGitMetadata(root)).toBeNull()
    })
})

describe('resolveBuildSha (what next.config.mjs inlines)', () => {
    it('takes GIT_COMMIT_SHA when it holds a commit — the Docker builder path', () => {
        const root = makeTempDir()
        write(path.join(root, '.git/HEAD'), `${OTHER_SHA}\n`)

        expect(
            resolveBuildSha({
                env: { GIT_COMMIT_SHA: SHA },
                startDir: root,
            }),
        ).toBe(SHA)
    })

    it('normalises an upper-case GIT_COMMIT_SHA so the CI comparison matches', () => {
        expect(
            resolveBuildSha({
                env: { GIT_COMMIT_SHA: SHA.toUpperCase() },
                startDir: makeTempDir(),
            }),
        ).toBe(SHA)
    })

    it('ignores a GIT_COMMIT_SHA that is not a commit and reads the metadata instead', () => {
        const root = makeTempDir()
        write(path.join(root, '.git/HEAD'), `${SHA}\n`)

        for (const value of ['', '   ', 'unknown', 'HEAD']) {
            expect(
                resolveBuildSha({
                    env: { GIT_COMMIT_SHA: value },
                    startDir: root,
                }),
            ).toBe(SHA)
        }
    })

    it('degrades to UNKNOWN_SHA when neither source answers', () => {
        expect(resolveBuildSha({ env: {}, startDir: makeTempDir() })).toBe(
            UNKNOWN_SHA,
        )
    })

    it('never reports a value that could pass for a commit when it does not know one', () => {
        // The deploy gate compares this against github.sha. UNKNOWN_SHA must
        // not be sha-shaped, or an unstamped build could coincide with one.
        expect(UNKNOWN_SHA).not.toMatch(/^[0-9a-f]{40}$/i)
    })
})
