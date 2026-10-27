import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// T-9435 — .github/workflows/scripts/wait-for-deploy.sh passes when the deployed
// /api/version sha is the expected commit OR a descendant of it (prod deploys are
// manual and one deploy carries several merges), and fails CLOSED on everything
// else. The script runs for real; only its two external collaborators are MOCKS,
// planted first on a PATH that holds nothing else:
//   - MOCK curl  — replays scripted (status code, body) responses, one per call;
//                  the last scripted response repeats.
//   - MOCK gh    — answers `gh api repos/.../compare/A...B --jq .status` with a
//                  scripted status string or a scripted failure; logs every call.
// MOCK sleep is a no-op so a multi-poll case does not wait out the interval.
// Nothing here talks to GitHub or to grabcaramel.com.
const REPO_ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../..',
)
const SCRIPT = path.join(
    REPO_ROOT,
    '.github/workflows/scripts/wait-for-deploy.sh',
)

const EXPECTED = 'a'.repeat(40)
const NEWER = 'b'.repeat(40)
const REPOSITORY = 'mock-owner/mock-repo'

function resolveTool(name: string): string {
    const res = spawnSync('bash', ['-c', `command -v ${name}`], {
        encoding: 'utf8',
    })
    const found = res.stdout.trim()
    if (res.status !== 0 || found === '') {
        throw new Error(`wait-for-deploy test needs ${name} on PATH`)
    }
    return found
}

const BASH = resolveTool('bash')
// What the script calls besides curl/gh/sleep: exposed through thin wrappers so
// the test PATH can hold exactly these and nothing else (above all: no real gh).
const PASSTHROUGH_TOOLS = [
    'sed',
    'head',
    'date',
    'mktemp',
    'rm',
    'grep',
    'cut',
    'cat',
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

function installGh(behavior: { status: string } | { failure: string }): void {
    writeExecutable('gh', [
        '# MOCK gh for wait-for-deploy.test.ts: never contacts GitHub.',
        'echo "$*" >> "$MOCK_DIR/gh.log"',
        ...('failure' in behavior
            ? [`echo ${JSON.stringify(behavior.failure)} >&2`, 'exit 1']
            : [`echo ${JSON.stringify(behavior.status)}`]),
    ])
}

function ghCalls(): string[] {
    const log = path.join(mockDir, 'gh.log')
    return fs.existsSync(log)
        ? fs.readFileSync(log, 'utf8').trim().split('\n')
        : []
}

function runScript(options: {
    timeoutSeconds: number
    repository?: string | null
}): RunResult {
    const env: NodeJS.ProcessEnv = {
        NODE_ENV: 'test',
        PATH: mockDir,
        MOCK_DIR: mockDir,
        VERSION_URL: 'http://mock.invalid/api/version',
        EXPECTED_SHA: EXPECTED,
        GH_TOKEN: 'mock-token',
        DEPLOY_WAIT_TIMEOUT_SECONDS: String(options.timeoutSeconds),
        DEPLOY_WAIT_INTERVAL_SECONDS: '1',
    }
    if (options.repository !== null) {
        env.GITHUB_REPOSITORY = options.repository ?? REPOSITORY
    }
    const res = spawnSync(BASH, [SCRIPT], { env, encoding: 'utf8' })
    return { status: res.status, output: `${res.stdout}${res.stderr}` }
}

beforeEach(() => {
    mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wait-for-deploy-'))
    for (const tool of PASSTHROUGH_TOOLS) {
        writeExecutable(tool, [`exec ${resolveTool(tool)} "$@"`])
    }
    writeExecutable('sleep', ['# MOCK sleep: no-op.', 'exit 0'])
    writeExecutable('curl', [
        '# MOCK curl for wait-for-deploy.test.ts: replays scripted responses.',
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
})

afterEach(() => {
    fs.rmSync(mockDir, { recursive: true, force: true })
})

describe('wait-for-deploy.sh', () => {
    it('passes on an exact sha match without asking GitHub anything', () => {
        scriptVersionResponses([servesSha(EXPECTED)])
        installGh({ status: 'ahead' })

        const run = runScript({ timeoutSeconds: 0 })

        expect(run.status).toBe(0)
        expect(run.output).toContain(`Deployment is serving ${EXPECTED}`)
        expect(ghCalls()).toEqual([])
    })

    it('passes when the served sha is a descendant (compare status ahead)', () => {
        scriptVersionResponses([servesSha(NEWER)])
        installGh({ status: 'ahead' })

        const run = runScript({ timeoutSeconds: 0 })

        expect(run.status).toBe(0)
        expect(run.output).toContain(
            `Deployment is serving ${NEWER}, a descendant of ${EXPECTED}; E2E runs against that newer build`,
        )
        expect(ghCalls()).toEqual([
            `api repos/${REPOSITORY}/compare/${EXPECTED}...${NEWER} --jq .status`,
        ])
    })

    it('fails closed when the served sha is behind the expected commit', () => {
        scriptVersionResponses([servesSha(NEWER)])
        installGh({ status: 'behind' })

        const run = runScript({ timeoutSeconds: 0 })

        expect(run.status).toBe(1)
        expect(run.output).toContain(
            `Last observed: serving ${NEWER} (not a descendant: behind)`,
        )
    })

    it('fails closed when the served sha has diverged from the expected commit', () => {
        scriptVersionResponses([servesSha(NEWER)])
        installGh({ status: 'diverged' })

        const run = runScript({ timeoutSeconds: 0 })

        expect(run.status).toBe(1)
        expect(run.output).toContain(
            `Last observed: serving ${NEWER} (not a descendant: diverged)`,
        )
    })

    it('fails closed, naming the HTTP status, when the compare API errors', () => {
        scriptVersionResponses([servesSha(NEWER)])
        installGh({ failure: 'gh: Not Found (HTTP 404)' })

        const run = runScript({ timeoutSeconds: 0 })

        expect(run.status).toBe(1)
        expect(run.output).toContain(
            `Last observed: serving ${NEWER} (ancestry check failed: HTTP 404)`,
        )
    })

    it('fails closed when gh dies without an HTTP status', () => {
        scriptVersionResponses([servesSha(NEWER)])
        installGh({ failure: 'gh: connection refused' })

        const run = runScript({ timeoutSeconds: 0 })

        expect(run.status).toBe(1)
        expect(run.output).toContain(
            `Last observed: serving ${NEWER} (ancestry check failed: gh exit 1)`,
        )
    })

    it('does not send a non-sha value to the compare API', () => {
        scriptVersionResponses([servesSha('unknown')])
        installGh({ status: 'ahead' })

        const run = runScript({ timeoutSeconds: 0 })

        expect(run.status).toBe(1)
        expect(run.output).toContain(
            'Last observed: serving unknown (not a commit sha)',
        )
        expect(ghCalls()).toEqual([])
    })

    it('treats a 404 as not deployed yet and passes once a later poll matches', () => {
        scriptVersionResponses([
            { code: '404', body: 'not found' },
            servesSha(EXPECTED),
        ])
        installGh({ status: 'behind' })

        const run = runScript({ timeoutSeconds: 5 })

        expect(run.status).toBe(0)
        expect(run.output).toContain('poll 1: HTTP 404 (endpoint not deployed)')
        expect(run.output).toContain(
            `Deployment is serving ${EXPECTED} after 2 poll(s)`,
        )
    })

    it('with a zero timeout and an unrelated sha polls once and fails', () => {
        scriptVersionResponses([servesSha('c'.repeat(40))])
        installGh({ status: 'diverged' })

        const run = runScript({ timeoutSeconds: 0 })

        expect(run.status).toBe(1)
        expect(run.output).toContain('::error::Deploy never arrived')
        expect(fs.readFileSync(path.join(mockDir, 'curl.count'), 'utf8')).toBe(
            '1\n',
        )
    })

    it('without gh falls back to exact-match only and says so once', () => {
        scriptVersionResponses([servesSha(NEWER)])

        const descendant = runScript({ timeoutSeconds: 0 })

        expect(descendant.status).toBe(1)
        expect(
            descendant.output.match(/accepting an exact sha match only/g),
        ).toHaveLength(1)
        expect(descendant.output).toContain(
            `Last observed: serving ${NEWER} (exact match only: ancestry check unavailable)`,
        )

        scriptVersionResponses([servesSha(EXPECTED)])
        fs.rmSync(path.join(mockDir, 'curl.count'))

        const exact = runScript({ timeoutSeconds: 0 })

        expect(exact.status).toBe(0)
    })

    it('without GITHUB_REPOSITORY also falls back to exact-match only', () => {
        scriptVersionResponses([servesSha(NEWER)])
        installGh({ status: 'ahead' })

        const run = runScript({ timeoutSeconds: 0, repository: null })

        expect(run.status).toBe(1)
        expect(run.output).toContain('accepting an exact sha match only')
        expect(ghCalls()).toEqual([])
    })
})
