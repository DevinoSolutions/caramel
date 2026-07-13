// scripts/smoke.ts
//
// Post-deploy smoke check (F-011). Before this script, confirming a deploy
// actually worked meant opening the site by hand — no repo-provided
// automation existed (see AM-9 in audit/empirical-3am.md: no deploy
// workflow, no post-deploy smoke, no rollback documentation anywhere in the
// repo). This is the callable half of that gap: hits the 3 endpoints that
// between them prove "the app booted, the auth DB is reachable, the coupons
// DB is reachable, and a real read query returns real data" — the same
// signals a human would eyeball, run one command.
//
// Not wired into the Dokploy deploy pipeline itself (ops/human handoff —
// see RUNBOOK.md "Post-deploy smoke"). Run manually:
//   BASE_URL=https://grabcaramel.com UPKUMA_HEALTH_SECRET=*** pnpm --filter caramel-app run smoke
//
// Assertion helpers (assert*Ok) are pure — they take an already-fetched
// status/body, not a URL — so tests/unit/smoke.test.ts can pin PASS and FAIL
// cases without a live server. The fetch* functions below them are the only
// parts that touch the network; they're exercised by actually running this
// script (see PLAN-F-011.md §Test strategy), not by the unit suite.
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface CheckResult {
    name: string
    ok: boolean
    detail?: string
}

function snippet(body: unknown): string {
    try {
        return ` — body: ${JSON.stringify(body).slice(0, 300)}`
    } catch {
        return ''
    }
}

/** `/` must serve the actual app shell, not an error/redirect. */
export function assertHomeOk(
    status: number,
    contentType: string | null,
): CheckResult {
    const name = 'GET /'
    if (status !== 200) {
        return { name, ok: false, detail: `expected 200, got ${status}` }
    }
    if (!contentType || !contentType.includes('text/html')) {
        return {
            name,
            ok: false,
            detail: `expected a text/html content-type, got "${contentType ?? '(none)'}"`,
        }
    }
    return { name, ok: true }
}

/** Mirrors the ACTUAL /api/health/db response shape landed in F-001
 * (src/app/api/health/db/route.ts): {status, checks: {auth_db, coupons_db}},
 * where each check is {status: 'ok'|'error', service, latencyMs, details?}.
 * Generic over the checks key set (doesn't hardcode auth_db/coupons_db) so
 * this doesn't silently stop covering a future 3rd check. */
interface HealthCheckEntry {
    status: string
    [key: string]: unknown
}
interface HealthBody {
    status: string
    checks: Record<string, HealthCheckEntry>
}

function isHealthBody(body: unknown): body is HealthBody {
    if (typeof body !== 'object' || body === null) return false
    const candidate = body as Record<string, unknown>
    return (
        typeof candidate.status === 'string' &&
        typeof candidate.checks === 'object' &&
        candidate.checks !== null
    )
}

export function assertHealthOk(status: number, body: unknown): CheckResult {
    const name = 'GET /api/health/db'
    if (!isHealthBody(body)) {
        return {
            name,
            ok: false,
            detail: `expected {status, checks} shape, got status=${status}${snippet(body)}`,
        }
    }
    if (status !== 200 || body.status !== 'ok') {
        const failing = Object.entries(body.checks)
            .filter(([, check]) => check.status !== 'ok')
            .map(([key, check]) => `${key}=${check.status}`)
        return {
            name,
            ok: false,
            detail: `HTTP ${status}, top-level status="${body.status}"${
                failing.length ? `, failing: ${failing.join(', ')}` : ''
            }`,
        }
    }
    return { name, ok: true }
}

/** Mirrors the ACTUAL /api/coupons response shape (src/app/api/coupons/
 * route.ts): {coupons, page, limit, total, hasMore} — `coupons` is always an
 * array (possibly empty; an empty result for one query site is not itself a
 * failure signal). */
export function assertCouponsOk(status: number, body: unknown): CheckResult {
    const name = 'GET /api/coupons?site=amazon.com'
    const coupons =
        typeof body === 'object' && body !== null
            ? (body as Record<string, unknown>).coupons
            : undefined
    if (status !== 200 || !Array.isArray(coupons)) {
        return {
            name,
            ok: false,
            detail: `expected 200 + {coupons: [...]}, got status=${status}${snippet(body)}`,
        }
    }
    return { name, ok: true }
}

async function parseJson(res: Response): Promise<unknown> {
    return res.json().catch(() => undefined)
}

async function fetchHome(baseUrl: string): Promise<CheckResult> {
    const res = await fetch(new URL('/', baseUrl))
    return assertHomeOk(res.status, res.headers.get('content-type'))
}

async function fetchHealth(
    baseUrl: string,
    healthSecret: string,
): Promise<CheckResult> {
    const res = await fetch(new URL('/api/health/db', baseUrl), {
        headers: { Authorization: `Bearer ${healthSecret}` },
    })
    return assertHealthOk(res.status, await parseJson(res))
}

async function fetchCoupons(baseUrl: string): Promise<CheckResult> {
    const res = await fetch(new URL('/api/coupons?site=amazon.com', baseUrl))
    return assertCouponsOk(res.status, await parseJson(res))
}

async function runCheck(
    check: () => Promise<CheckResult>,
    fallbackName: string,
): Promise<CheckResult> {
    try {
        return await check()
    } catch (err) {
        return {
            name: fallbackName,
            ok: false,
            detail: err instanceof Error ? err.message : String(err),
        }
    }
}

export async function runSmoke(
    baseUrl: string,
    healthSecret: string,
): Promise<boolean> {
    const checks: Array<[() => Promise<CheckResult>, string]> = [
        [() => fetchHome(baseUrl), 'GET /'],
        [() => fetchHealth(baseUrl, healthSecret), 'GET /api/health/db'],
        [() => fetchCoupons(baseUrl), 'GET /api/coupons?site=amazon.com'],
    ]

    for (const [check, fallbackName] of checks) {
        const result = await runCheck(check, fallbackName)
        if (!result.ok) {
            console.error(`[smoke] FAIL — ${result.name}: ${result.detail}`)
            return false
        }
        console.log(`[smoke] PASS — ${result.name}`)
    }
    return true
}

async function main() {
    const baseUrl = process.env.BASE_URL || 'http://localhost:58000'
    const healthSecret = process.env.UPKUMA_HEALTH_SECRET
    if (!healthSecret) {
        console.error(
            '[smoke] UPKUMA_HEALTH_SECRET is not set — /api/health/db would 401. ' +
                'Set BASE_URL + UPKUMA_HEALTH_SECRET and re-run (see RUNBOOK.md "Post-deploy smoke").',
        )
        process.exit(1)
    }

    console.log(`[smoke] Target: ${baseUrl}`)
    const passed = await runSmoke(baseUrl, healthSecret)
    if (!passed) process.exit(1)
    console.log('[smoke] All checks passed.')
}

const isDirectExecution =
    process.argv[1] &&
    path.resolve(process.argv[1]) ===
        path.resolve(fileURLToPath(import.meta.url))

if (isDirectExecution) {
    main().catch(err => {
        console.error('[smoke] Unexpected failure:', err)
        process.exit(1)
    })
}
