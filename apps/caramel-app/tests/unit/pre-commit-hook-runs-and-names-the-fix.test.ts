/**
 * The pre-commit hook runs in every checkout and says what stops it (T-12805).
 *
 * `core.hooksPath` is shared by every linked worktree and points at `.husky/_`, which only
 * `pnpm install` generated. A worktree with no install had no such directory, and git treats a
 * missing hooks directory as "no hooks", silently: three commits on PR #650 ran no gate at all.
 * Tracking husky's two files puts the directory in every checkout. Once the hook really runs, the
 * wrong pnpm (this PC's global is 12) rewrites the lockfile on its way to failing, so the hook
 * stops first and names the fix.
 *
 * These run the real `.husky/pre-commit` under `sh` with a stub `pnpm` that records its calls.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(__dirname, '../../../..')
const HOOK = join(REPO_ROOT, '.husky/pre-commit')

let checkout: string
let calls: string

function runHook(pnpmVersion: string, env: Record<string, string> = {}) {
    const bin = join(checkout, '.stub-bin')
    mkdirSync(bin, { recursive: true })
    const stub = join(bin, 'pnpm')
    writeFileSync(
        stub,
        `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${pnpmVersion}; exit 0; fi\necho "$*" >> "${calls.replace(/\\/g, '/')}"\n`,
    )
    chmodSync(stub, 0o755)
    const { DATABASE_URL: _ignored, ...inherited } = process.env
    return spawnSync('sh', ['-e', HOOK], {
        cwd: checkout,
        encoding: 'utf8',
        env: {
            ...inherited,
            PATH: `${bin}${delimiter}${process.env.PATH}`,
            ...env,
        },
    })
}

function ranCommands(): string[] {
    try {
        return readFileSync(calls, 'utf8').trim().split('\n')
    } catch {
        return []
    }
}

function install() {
    mkdirSync(join(checkout, 'node_modules/.bin'), { recursive: true })
}

function generatePrisma() {
    mkdirSync(join(checkout, 'apps/caramel-app/src/generated/prisma'), {
        recursive: true,
    })
}

beforeEach(() => {
    checkout = mkdtempSync(join(tmpdir(), 'caramel-hook-'))
    calls = join(checkout, 'calls.txt')
    writeFileSync(
        join(checkout, 'package.json'),
        JSON.stringify({ packageManager: 'pnpm@9.0.0' }, null, 4),
    )
})

afterEach(() => {
    rmSync(checkout, { recursive: true, force: true })
})

describe('husky files every checkout needs', () => {
    it.each(['.husky/_/h', '.husky/_/pre-commit'])(
        '%s is tracked and executable',
        file => {
            const entry = execFileSync('git', ['ls-files', '-s', file], {
                cwd: REPO_ROOT,
                encoding: 'utf8',
            })
            expect(entry).toMatch(/^100755 /)
        },
    )
})

describe('.husky/pre-commit', () => {
    it('stops under the wrong pnpm, names the fix and runs no gate', () => {
        install()
        generatePrisma()
        const result = runHook('12.3.4', { DATABASE_URL: 'postgresql://x' })
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('pnpm 12.3.4 is first on PATH')
        expect(result.stderr).toContain('pins pnpm 9.0.0')
        expect(result.stderr).toContain('exec corepack pnpm')
        expect(ranCommands()).toEqual([])
    })

    it('stops in a checkout with no install', () => {
        const result = runHook('9.0.0', { DATABASE_URL: 'postgresql://x' })
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('pnpm install --frozen-lockfile')
        expect(ranCommands()).toEqual([])
    })

    it('stops in a checkout with no Prisma client', () => {
        install()
        const result = runHook('9.0.0', { DATABASE_URL: 'postgresql://x' })
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('pnpm --filter caramel-app generate')
        expect(ranCommands()).toEqual([])
    })

    it('stops when prisma validate would have no database URL', () => {
        install()
        generatePrisma()
        const result = runHook('9.0.0')
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('prisma validate needs a DATABASE_URL')
        expect(ranCommands()).toEqual([])
    })

    it('takes the database URL from the checkout .env file too', () => {
        install()
        generatePrisma()
        writeFileSync(join(checkout, 'apps/caramel-app/.env'), '')
        const result = runHook('9.0.0')
        expect(result.status).toBe(0)
    })

    it('runs every gate in order when the checkout is ready', () => {
        install()
        generatePrisma()
        const result = runHook('9.0.0', { DATABASE_URL: 'postgresql://x' })
        expect(result.status).toBe(0)
        expect(ranCommands()).toEqual([
            'lint-staged',
            '-r run type-check',
            '--filter caramel-app knip',
            '--filter caramel-extension knip',
            '--filter caramel-app exec prisma validate',
        ])
    })
})
