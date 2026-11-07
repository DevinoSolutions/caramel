import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// T-9427 — .github/workflows/scripts/run-e2e-push.sh runs the deployed-site E2E
// suite and reruns it ONCE, only when the suite failed while /api/version's sha
// CHANGED during the run (a manual prod deploy swapped the containers mid-suite).
// Every other failure keeps the suite's own exit code. The script runs for real;
// its collaborators are MOCKS planted first on a PATH that holds nothing else:
//   - MOCK curl   — replays scripted (status code, body) /api/version responses,
//                   one per call; the last scripted response repeats.
//   - MOCK gh     — answers the compare API wait-for-deploy.sh asks (the script
//                   reuses that gate, for real, to re-check EXPECTED_SHA).
//   - MOCK e2e-suite — stands in for `pnpm test:e2e` (passed as E2E_COMMAND);
//                   replays scripted exit codes, one per run, prints a failing
//                   test title when it fails, and counts every run.
// MOCK sleep is a no-op so the settle loop does not wait. Nothing here talks to
// grabcaramel.com or runs Playwright.
// Needs a POSIX bash on PATH: CI is ubuntu; on Windows run it from Git Bash with
// Git's bash resolving first, NOT the WSL launcher in System32.
const REPO_ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../..',
)
const SCRIPT = path.join(REPO_ROOT, '.github/workflows/scripts/run-e2e-push.sh')

const EXPECTED = 'e'.repeat(40)
const BEFORE = 'a'.repeat(40)
const AFTER = 'b'.repeat(40)
const OTHER = 'c'.repeat(40)

function resolveTool(name: string): string {
    const res = spawnSync('bash', ['-c', `command -v ${name}`], {
        encoding: 'utf8',
    })
    const found = res.stdout.trim()
    if (res.status !== 0 || found === '') {
        throw new Error(`run-e2e-push test needs ${name} on PATH`)
    }
    return found
}

const BASH = resolveTool('bash')
// What the script calls besides curl/sleep/the suite: thin wrappers so the test
// PATH holds exactly these and nothing else.
const PASSTHROUGH_TOOLS = [
    'bash',
    'sed',
    'head',
    'mktemp',
    'rm',
    'seq',
    'tee',
    'sort',
    'dirname',
    'date',
    'grep',
    'cut',
    'tr',
    'cat',
    'env',
]

interface VersionResponse {
    code: string
    body: string
}

interface RunResult {
    status: number | null
    output: string
}

let mockDir: string

function writeExecutable(name: string, lines: string[]): void {
    const file = path.join(mockDir, name)
    fs.writeFileSync(file, `#!${BASH}\n${lines.join('\n')}\n`, { mode: 0o755 })
}

function scriptVersionResponses(responses: VersionResponse[]): void {
    responses.forEach((response, index) => {
        fs.writeFileSync(
            path.join(mockDir, `curl.${index + 1}.code`),
            response.code,
        )
        fs.writeFileSync(
            path.join(mockDir, `curl.${index + 1}.body`),
            response.body,
        )
    })
    fs.writeFileSync(path.join(mockDir, 'curl.last'), String(responses.length))
}

function servesSha(sha: string): VersionResponse {
    return { code: '200', body: JSON.stringify({ sha }) }
}

function scriptSuiteExitCodes(codes: number[]): void {
    codes.forEach((code, index) => {
        fs.writeFileSync(
            path.join(mockDir, `e2e.${index + 1}.status`),
            `${code}`,
        )
    })
    fs.writeFileSync(path.join(mockDir, 'e2e.last'), String(codes.length))
}

function suiteRuns(): number {
    const log = path.join(mockDir, 'e2e.count')
    return fs.existsSync(log) ? Number(fs.readFileSync(log, 'utf8').trim()) : 0
}

function ghCalls(): string[] {
    const log = path.join(mockDir, 'gh.log')
    return fs.existsSync(log)
        ? fs.readFileSync(log, 'utf8').trim().split('\n')
        : []
}

function tokenSeenBy(tool: 'e2e' | 'gh'): string[] {
    const log = path.join(mockDir, `${tool}.token.log`)
    return fs.existsSync(log)
        ? fs.readFileSync(log, 'utf8').trim().split('\n')
        : []
}

function stepSummary(): string {
    const file = path.join(mockDir, 'step-summary.md')
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}

function runScript(
    overrides: Record<string, string | undefined> = {},
): RunResult {
    const env: Record<string, string | undefined> = {
        NODE_ENV: 'test',
        PATH: mockDir,
        MOCK_DIR: mockDir,
        MOCK_GH_STATUS: 'ahead',
        VERSION_URL: 'http://mock.invalid/api/version',
        EXPECTED_SHA: EXPECTED,
        GITHUB_REPOSITORY: 'mock-owner/mock-repo',
        GH_TOKEN: 'mock-token',
        GITHUB_STEP_SUMMARY: path.join(mockDir, 'step-summary.md'),
        E2E_COMMAND: 'e2e-suite',
        E2E_SETTLE_POLLS: '3',
        E2E_SETTLE_INTERVAL_SECONDS: '1',
        E2E_READ_POLLS: '2',
        E2E_READ_INTERVAL_SECONDS: '1',
        ...overrides,
    }
    for (const key of Object.keys(env)) {
        if (env[key] === undefined) delete env[key]
    }
    const res = spawnSync(BASH, [SCRIPT], {
        env: env as NodeJS.ProcessEnv,
        encoding: 'utf8',
    })
    return { status: res.status, output: `${res.stdout}${res.stderr}` }
}

beforeEach(() => {
    mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-e2e-push-'))
    for (const tool of PASSTHROUGH_TOOLS) {
        writeExecutable(tool, [`exec ${resolveTool(tool)} "$@"`])
    }
    writeExecutable('sleep', ['# MOCK sleep: no-op.', 'exit 0'])
    writeExecutable('curl', [
        '# MOCK curl for run-e2e-push.test.ts: replays scripted responses.',
        'out=""',
        'while [ $# -gt 0 ]; do',
        '    if [ "$1" = "--output" ]; then out="$2"; shift; fi',
        '    shift',
        'done',
        'n=0',
        '[ -f "$MOCK_DIR/curl.count" ] && n=$(<"$MOCK_DIR/curl.count")',
        'n=$((n + 1))',
        'echo "$n" > "$MOCK_DIR/curl.count"',
        'last=$(<"$MOCK_DIR/curl.last")',
        'i=$((n > last ? last : n))',
        '# A scripted code of "curlfail" is a transport failure: no output, exit 7.',
        '[ "$(<"$MOCK_DIR/curl.$i.code")" = "curlfail" ] && exit 7',
        'printf %s "$(<"$MOCK_DIR/curl.$i.body")" > "$out"',
        'printf %s "$(<"$MOCK_DIR/curl.$i.code")"',
    ])
    writeExecutable('gh', [
        '# MOCK gh for run-e2e-push.test.ts: never contacts GitHub.',
        'echo "$*" >> "$MOCK_DIR/gh.log"',
        'echo "${GH_TOKEN:-unset}" >> "$MOCK_DIR/gh.token.log"',
        'echo "$MOCK_GH_STATUS"',
    ])
    writeExecutable('e2e-suite', [
        '# MOCK e2e-suite for run-e2e-push.test.ts: stands in for pnpm test:e2e.',
        'n=0',
        '[ -f "$MOCK_DIR/e2e.count" ] && n=$(<"$MOCK_DIR/e2e.count")',
        'n=$((n + 1))',
        'echo "$n" > "$MOCK_DIR/e2e.count"',
        'echo "${GH_TOKEN:-unset}" >> "$MOCK_DIR/e2e.token.log"',
        'last=$(<"$MOCK_DIR/e2e.last")',
        'i=$((n > last ? last : n))',
        'code="$(<"$MOCK_DIR/e2e.$i.status")"',
        '[ "$code" != "0" ] && echo "  1) [chromium] › e2e/mock.spec.ts:1:1 › mock failing test"',
        'exit "$code"',
    ])
})

afterEach(() => {
    fs.rmSync(mockDir, { recursive: true, force: true })
})

// reads: before, after, then two agreeing reads while settling (the last
// response repeats for wait-for-deploy.sh's own read).
const REDEPLOYED = [
    servesSha(BEFORE),
    servesSha(AFTER),
    servesSha(AFTER),
    servesSha(AFTER),
]

describe('run-e2e-push.sh', () => {
    it('runs the suite once and passes through when it is green, even across a redeploy', () => {
        scriptVersionResponses([servesSha(BEFORE), servesSha(AFTER)])
        scriptSuiteExitCodes([0])

        const run = runScript()

        expect(run.status).toBe(0)
        expect(suiteRuns()).toBe(1)
        expect(run.output).not.toContain(
            '::warning title=Production redeployed',
        )
        expect(stepSummary()).toBe('')
    })

    it('keeps the suite exit code and does not rerun when production stayed on one sha', () => {
        scriptVersionResponses([servesSha(BEFORE)])
        scriptSuiteExitCodes([3])

        const run = runScript()

        expect(run.status).toBe(3)
        expect(suiteRuns()).toBe(1)
        expect(run.output).toContain(
            `while production stayed on ${BEFORE}: not a redeploy race`,
        )
    })

    it('reruns once when the sha changed during a failed run, and is green when the rerun is', () => {
        scriptVersionResponses(REDEPLOYED)
        scriptSuiteExitCodes([1, 0])

        const run = runScript()

        expect(run.status).toBe(0)
        expect(suiteRuns()).toBe(2)
        // The redeploy stays loudly visible: a warning naming both shas, and
        // that the rerun may test a newer descendant.
        expect(run.output).toContain(
            `::warning title=Production redeployed during the E2E run::The suite failed (exit 1) while http://mock.invalid/api/version went from ${BEFORE} to ${AFTER}`,
        )
        expect(run.output).not.toContain('is attributed to the deploy')
        expect(run.output).toContain('may test a newer descendant')
        expect(run.output).toContain(
            '::warning title=E2E passed on the post-redeploy rerun',
        )
        // The settled deployment was checked against the commit under test.
        expect(ghCalls()).toEqual([
            `api repos/mock-owner/mock-repo/compare/${EXPECTED}...${AFTER} --jq .status`,
        ])
    })

    it('keeps GH_TOKEN away from the suite (both runs) while the ancestry check still gets it', () => {
        scriptVersionResponses(REDEPLOYED)
        scriptSuiteExitCodes([1, 0])

        runScript()

        expect(tokenSeenBy('e2e')).toEqual(['unset', 'unset'])
        expect(tokenSeenBy('gh')).toEqual(['mock-token'])
    })

    it('writes both shas, the failed first-attempt test and the rerun verdict to the step summary', () => {
        scriptVersionResponses(REDEPLOYED)
        scriptSuiteExitCodes([1, 0])

        runScript()

        const summary = stepSummary()
        expect(summary).toContain(
            `Production changed from \`${BEFORE}\` to \`${AFTER}\` during the run`,
        )
        expect(summary).toContain('the suite is rerun once')
        expect(summary).not.toContain('attributed')
        expect(summary).toContain(`commit under test \`${EXPECTED}\``)
        expect(summary).toContain(
            '[chromium] › e2e/mock.spec.ts:1:1 › mock failing test',
        )
        expect(summary).toContain('**passed**')
    })

    it('fails with the rerun exit code when the rerun is red too (a real regression stays red)', () => {
        scriptVersionResponses(REDEPLOYED)
        scriptSuiteExitCodes([1, 7])

        const run = runScript()

        expect(run.status).toBe(7)
        expect(suiteRuns()).toBe(2)
        expect(run.output).not.toContain('passed on the post-redeploy rerun')
        expect(stepSummary()).toContain('**failed** (exit 7)')
    })

    it('never reruns more than once', () => {
        scriptVersionResponses(REDEPLOYED)
        scriptSuiteExitCodes([1, 1, 0])

        const run = runScript()

        expect(run.status).toBe(1)
        expect(suiteRuns()).toBe(2)
    })

    it('does not rerun when the settled deployment no longer carries the commit under test (rollback)', () => {
        scriptVersionResponses(REDEPLOYED)
        scriptSuiteExitCodes([5, 0])

        const run = runScript({ MOCK_GH_STATUS: 'behind' })

        expect(run.status).toBe(5)
        expect(suiteRuns()).toBe(1)
        expect(run.output).toContain(
            `::error::The settled deployment (${AFTER}) does not carry ${EXPECTED}`,
        )
        expect(stepSummary()).toContain('does not carry the commit under test')
    })

    it('does not rerun when the settled deployment has diverged from the commit under test', () => {
        scriptVersionResponses(REDEPLOYED)
        scriptSuiteExitCodes([5, 0])

        const run = runScript({ MOCK_GH_STATUS: 'diverged' })

        expect(run.status).toBe(5)
        expect(suiteRuns()).toBe(1)
    })

    it('reruns when the settled deployment is exactly the commit under test', () => {
        scriptVersionResponses([
            servesSha(BEFORE),
            servesSha(EXPECTED),
            servesSha(EXPECTED),
            servesSha(EXPECTED),
        ])
        scriptSuiteExitCodes([1, 0])

        const run = runScript()

        expect(run.status).toBe(0)
        expect(suiteRuns()).toBe(2)
        // An exact match never asks GitHub.
        expect(ghCalls()).toEqual([])
    })

    it('does not rerun against a moving target when the sha never settles', () => {
        scriptVersionResponses([
            servesSha(BEFORE),
            servesSha(AFTER),
            servesSha(OTHER),
            servesSha(AFTER),
            servesSha(OTHER),
        ])
        scriptSuiteExitCodes([5, 0])

        const run = runScript()

        expect(run.status).toBe(5)
        expect(suiteRuns()).toBe(1)
        expect(run.output).toContain('::error::Production never settled')
    })

    it('does not attribute a failure to a redeploy when the sha could not be read before the run', () => {
        scriptVersionResponses([
            { code: '404', body: 'not found' },
            { code: '404', body: 'not found' },
            servesSha(AFTER),
        ])
        scriptSuiteExitCodes([2, 0])

        const run = runScript()

        expect(run.status).toBe(2)
        expect(suiteRuns()).toBe(1)
        expect(run.output).toContain('could not be read at both ends')
    })

    it('does not attribute a failure to a redeploy when the sha could not be read after the run, however often it is retried', () => {
        scriptVersionResponses([
            servesSha(BEFORE),
            { code: '502', body: 'bad gateway' },
        ])
        scriptSuiteExitCodes([2, 0])

        const run = runScript()

        expect(run.status).toBe(2)
        expect(suiteRuns()).toBe(1)
        expect(run.output).toContain('could not be read at both ends')
        expect(fs.readFileSync(path.join(mockDir, 'curl.count'), 'utf8')).toBe(
            '3\n',
        )
    })

    it('survives a transient 502 on the post-suite read (a container swap) and still reruns', () => {
        scriptVersionResponses([
            servesSha(BEFORE),
            { code: '502', body: 'bad gateway' },
            servesSha(AFTER),
            servesSha(AFTER),
            servesSha(AFTER),
        ])
        scriptSuiteExitCodes([1, 0])

        const run = runScript()

        expect(run.status).toBe(0)
        expect(suiteRuns()).toBe(2)
    })

    it('treats a curl transport failure as an unreadable sha and keeps the suite exit code', () => {
        scriptVersionResponses([{ code: 'curlfail', body: '' }])
        scriptSuiteExitCodes([4, 0])

        const run = runScript()

        expect(run.status).toBe(4)
        expect(suiteRuns()).toBe(1)
        expect(run.output).toContain('could not be read at both ends')
    })

    it('treats a 200 with a non-JSON body as an unreadable sha and keeps the suite exit code', () => {
        scriptVersionResponses([
            { code: '200', body: '<html>502 Bad Gateway</html>' },
        ])
        scriptSuiteExitCodes([4, 0])

        const run = runScript()

        expect(run.status).toBe(4)
        expect(suiteRuns()).toBe(1)
        expect(run.output).toContain('could not be read at both ends')
    })

    it('refuses to start without VERSION_URL, and does not run the suite', () => {
        scriptVersionResponses([servesSha(BEFORE)])
        scriptSuiteExitCodes([0])

        const run = runScript({ VERSION_URL: undefined })

        expect(run.status).not.toBe(0)
        expect(run.output).toContain('VERSION_URL is required')
        expect(suiteRuns()).toBe(0)
    })

    it('refuses to start without EXPECTED_SHA, and does not run the suite', () => {
        scriptVersionResponses([servesSha(BEFORE)])
        scriptSuiteExitCodes([0])

        const run = runScript({ EXPECTED_SHA: undefined })

        expect(run.status).not.toBe(0)
        expect(run.output).toContain('EXPECTED_SHA is required')
        expect(suiteRuns()).toBe(0)
    })
})
