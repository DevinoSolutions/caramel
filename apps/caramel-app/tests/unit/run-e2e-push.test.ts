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
//   - MOCK e2e-suite — stands in for `pnpm test:e2e` (passed as E2E_COMMAND);
//                   replays scripted exit codes, one per run, and logs every run.
// MOCK sleep is a no-op so the settle loop does not wait. Nothing here talks to
// grabcaramel.com or runs Playwright.
// Needs a POSIX bash on PATH: CI is ubuntu; on Windows run it from Git Bash with
// Git's bash resolving first, NOT the WSL launcher in System32.
const REPO_ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../..',
)
const SCRIPT = path.join(REPO_ROOT, '.github/workflows/scripts/run-e2e-push.sh')

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
const PASSTHROUGH_TOOLS = ['bash', 'sed', 'head', 'mktemp', 'rm', 'seq']

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
        fs.writeFileSync(path.join(mockDir, `e2e.${index + 1}.status`), `${code}`)
    })
    fs.writeFileSync(path.join(mockDir, 'e2e.last'), String(codes.length))
}

function suiteRuns(): number {
    const log = path.join(mockDir, 'e2e.count')
    return fs.existsSync(log)
        ? Number(fs.readFileSync(log, 'utf8').trim())
        : 0
}

function runScript(): RunResult {
    const res = spawnSync(BASH, [SCRIPT], {
        env: {
            NODE_ENV: 'test',
            PATH: mockDir,
            MOCK_DIR: mockDir,
            VERSION_URL: 'http://mock.invalid/api/version',
            E2E_COMMAND: 'e2e-suite',
            E2E_SETTLE_POLLS: '3',
            E2E_SETTLE_INTERVAL_SECONDS: '1',
        },
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
        'printf %s "$(<"$MOCK_DIR/curl.$i.body")" > "$out"',
        'printf %s "$(<"$MOCK_DIR/curl.$i.code")"',
    ])
    writeExecutable('e2e-suite', [
        '# MOCK e2e-suite for run-e2e-push.test.ts: stands in for pnpm test:e2e.',
        'n=0',
        '[ -f "$MOCK_DIR/e2e.count" ] && n=$(<"$MOCK_DIR/e2e.count")',
        'n=$((n + 1))',
        'echo "$n" > "$MOCK_DIR/e2e.count"',
        'last=$(<"$MOCK_DIR/e2e.last")',
        'i=$((n > last ? last : n))',
        'exit "$(<"$MOCK_DIR/e2e.$i.status")"',
    ])
})

afterEach(() => {
    fs.rmSync(mockDir, { recursive: true, force: true })
})

describe('run-e2e-push.sh', () => {
    it('runs the suite once and passes through when it is green, even across a redeploy', () => {
        scriptVersionResponses([servesSha(BEFORE), servesSha(AFTER)])
        scriptSuiteExitCodes([0])

        const run = runScript()

        expect(run.status).toBe(0)
        expect(suiteRuns()).toBe(1)
        expect(run.output).not.toContain('::warning title=Production redeployed')
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
        // reads: before, after, then two agreeing reads while settling.
        scriptVersionResponses([
            servesSha(BEFORE),
            servesSha(AFTER),
            servesSha(AFTER),
            servesSha(AFTER),
        ])
        scriptSuiteExitCodes([1, 0])

        const run = runScript()

        expect(run.status).toBe(0)
        expect(suiteRuns()).toBe(2)
        // The redeploy stays loudly visible: a warning naming both shas.
        expect(run.output).toContain(
            `::warning title=Production redeployed during the E2E run::The suite failed (exit 1) while http://mock.invalid/api/version went from ${BEFORE} to ${AFTER}`,
        )
        expect(run.output).toContain(
            `::warning title=E2E passed on the post-redeploy rerun`,
        )
    })

    it('fails with the rerun exit code when the rerun is red too (a real regression stays red)', () => {
        scriptVersionResponses([
            servesSha(BEFORE),
            servesSha(AFTER),
            servesSha(AFTER),
            servesSha(AFTER),
        ])
        scriptSuiteExitCodes([1, 7])

        const run = runScript()

        expect(run.status).toBe(7)
        expect(suiteRuns()).toBe(2)
        expect(run.output).not.toContain('passed on the post-redeploy rerun')
    })

    it('never reruns more than once', () => {
        scriptVersionResponses([
            servesSha(BEFORE),
            servesSha(AFTER),
            servesSha(AFTER),
            servesSha(AFTER),
        ])
        scriptSuiteExitCodes([1, 1, 0])

        const run = runScript()

        expect(run.status).toBe(1)
        expect(suiteRuns()).toBe(2)
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
            servesSha(AFTER),
        ])
        scriptSuiteExitCodes([2, 0])

        const run = runScript()

        expect(run.status).toBe(2)
        expect(suiteRuns()).toBe(1)
        expect(run.output).toContain('could not be read at both ends')
    })

    it('does not attribute a failure to a redeploy when the sha could not be read after the run', () => {
        scriptVersionResponses([
            servesSha(BEFORE),
            { code: '502', body: 'bad gateway' },
        ])
        scriptSuiteExitCodes([2, 0])

        const run = runScript()

        expect(run.status).toBe(2)
        expect(suiteRuns()).toBe(1)
        expect(run.output).toContain('could not be read at both ends')
    })
})
