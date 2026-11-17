import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// FLAG-02 — production dependency vulnerability gate.
//
// Replaces the CI `pnpm audit --prod --audit-level=high` step, which is
// permanently broken: pnpm's audit still calls npm's retired quick-audit
// endpoint (`/-/npm/v1/security/audits`), which now answers HTTP 410
// ("This endpoint is being retired") on pnpm 9 AND 10 — so the step errored on
// the transport, never on an actual vulnerability, and reddened CI regardless
// of the deps.
//
// This keeps the SAME contract as the old step:
//   • scope = the workspace PRODUCTION closure only (what shipped/deployed code
//     can reach) — `pnpm -r list --prod`, matching `pnpm audit --prod`. Build/
//     dev-only tooling vulnerabilities (eslint, web-ext's CLI tree, turbo, …)
//     are deliberately out of scope, exactly as `--prod` intended.
//   • threshold = fail ONLY on HIGH or CRITICAL (matching `--audit-level=high`);
//     moderate/low are reported for visibility but do not fail the gate.
// Source of truth is the OSV.dev database (the same GHSA advisory data
// Dependabot uses), queried over HTTPS with no npm-audit endpoint involved.
//
// Fails LOUD on an unreachable advisory source (never silently passes): a
// security gate that cannot verify must go red, not green.

const OSV_QUERYBATCH = 'https://api.osv.dev/v1/querybatch'
const OSV_VULN = 'https://api.osv.dev/v1/vulns'
const REQUEST_TIMEOUT_MS = 20_000
const RETRIES = 4

interface PkgRef {
    name: string
    version: string
}

interface PnpmDepNode {
    version?: string
    dependencies?: Record<string, PnpmDepNode>
}

interface PnpmListProject {
    name?: string
    dependencies?: Record<string, PnpmDepNode>
}

interface OsvBatchResult {
    vulns?: Array<{ id: string }>
}

interface OsvVuln {
    id: string
    summary?: string
    withdrawn?: string
    database_specific?: { severity?: string }
    severity?: Array<{ type: string; score: string }>
}

/** Flatten `pnpm -r list --prod --depth Infinity --json` into a unique set of name@version. */
function collectProdClosure(projects: PnpmListProject[]): PkgRef[] {
    const seen = new Map<string, PkgRef>()
    const walk = (deps: Record<string, PnpmDepNode> | undefined): void => {
        if (!deps) return
        for (const [name, node] of Object.entries(deps)) {
            if (!node?.version) continue
            const key = `${name}@${node.version}`
            if (!seen.has(key)) seen.set(key, { name, version: node.version })
            walk(node.dependencies)
        }
    }
    for (const project of projects) walk(project.dependencies)
    return Array.from(seen.values())
}

function readProdClosure(): PkgRef[] {
    const scriptDir = path.dirname(fileURLToPath(import.meta.url))
    const repoRoot = path.resolve(scriptDir, '../../..')
    const raw = execFileSync(
        'pnpm',
        ['-r', 'list', '--prod', '--depth', 'Infinity', '--json'],
        { cwd: repoRoot, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
    )
    const projects = JSON.parse(raw) as PnpmListProject[]
    return collectProdClosure(projects)
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    let lastError: unknown
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
        try {
            const res = await fetch(url, {
                ...init,
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            })
            if (!res.ok) throw new Error(`${url} responded ${res.status}`)
            return (await res.json()) as T
        } catch (error) {
            lastError = error
            if (attempt < RETRIES) {
                const backoffMs = 500 * 2 ** (attempt - 1)
                await new Promise(resolve => setTimeout(resolve, backoffMs))
            }
        }
    }
    throw new Error(
        `OSV advisory source unreachable after ${RETRIES} attempts (${url}): ${String(lastError)}`,
    )
}

async function findVulnIds(pkgs: PkgRef[]): Promise<Map<string, string[]>> {
    const byPkg = new Map<string, string[]>()
    const CHUNK = 500
    for (let i = 0; i < pkgs.length; i += CHUNK) {
        const chunk = pkgs.slice(i, i + CHUNK)
        const body = JSON.stringify({
            queries: chunk.map(p => ({
                package: { name: p.name, ecosystem: 'npm' },
                version: p.version,
            })),
        })
        const { results } = await fetchJson<{ results: OsvBatchResult[] }>(
            OSV_QUERYBATCH,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body,
            },
        )
        results.forEach((result, idx) => {
            const ids = (result.vulns ?? []).map(v => v.id)
            if (ids.length)
                byPkg.set(`${chunk[idx].name}@${chunk[idx].version}`, ids)
        })
    }
    return byPkg
}

/** Normalise an OSV vuln to HIGH/CRITICAL/MODERATE/LOW/UNKNOWN. */
function classifySeverity(vuln: OsvVuln): string {
    const label = vuln.database_specific?.severity
    if (label) return label.toUpperCase()
    // Fallback: derive a coarse band from a CVSS vector's own severity words
    // is not possible without scoring, so surface as UNKNOWN (logged, non-gating).
    return 'UNKNOWN'
}

const HIGH_OR_CRITICAL = new Set(['HIGH', 'CRITICAL'])

// Dated allowlist for HIGH/CRITICAL advisories that have NO patched release
// yet. An entry stops gating only up to and including its `expires` day (UTC);
// after that the advisory fails the gate again, so every entry must be
// re-reviewed or dropped. Anything with a fix gets a real version bump instead.
interface AllowedAdvisory {
    id: string
    expires: string // YYYY-MM-DD, inclusive
    reason: string
}

const ALLOWED_ADVISORIES: readonly AllowedAdvisory[] = [
    {
        id: 'GHSA-fc5q-39xc-vjpf',
        expires: '2026-12-01',
        reason: 'build/dev tooling only, repo-authored patterns; checked no tracked source imports picomatch, micromatch, minimatch, fast-glob, globby, tinyglobby, glob or anymatch, and pnpm why --prod shows picomatch only under @sentry/nextjs build plugins (@rollup/plugin-commonjs), vite/tinyglobby/fdir peers and sass @parcel/watcher; drop when picomatch ships a fix (micromatch/picomatch#194)',
    },
]

function activeAllowance(
    id: string,
    today = new Date().toISOString().slice(0, 10),
): AllowedAdvisory | undefined {
    return ALLOWED_ADVISORIES.find(
        entry => entry.id === id && today <= entry.expires,
    )
}

async function auditProdDeps(): Promise<number> {
    const pkgs = readProdClosure()
    console.log(
        `[audit:prod] scanning ${pkgs.length} production packages against OSV.dev (fail on HIGH/CRITICAL)`,
    )
    const vulnIdsByPkg = await findVulnIds(pkgs)
    if (vulnIdsByPkg.size === 0) {
        console.log(
            '[audit:prod] no known vulnerabilities in the production closure ✅',
        )
        return 0
    }

    const uniqueIds = new Set<string>()
    for (const ids of Array.from(vulnIdsByPkg.values()))
        for (const id of ids) uniqueIds.add(id)
    const severityById = new Map<
        string,
        { severity: string; summary: string; withdrawn: boolean }
    >()
    for (const id of Array.from(uniqueIds)) {
        const vuln = await fetchJson<OsvVuln>(`${OSV_VULN}/${id}`)
        severityById.set(id, {
            severity: classifySeverity(vuln),
            summary: vuln.summary ?? '',
            withdrawn: Boolean(vuln.withdrawn),
        })
    }

    const failures: string[] = []
    const informational: string[] = []
    const allowed: string[] = []
    for (const [pkg, ids] of Array.from(vulnIdsByPkg.entries())) {
        for (const id of ids) {
            const info = severityById.get(id)
            if (!info || info.withdrawn) continue
            const line = `  [${info.severity}] ${pkg} ${id} — ${info.summary.slice(0, 80)}`
            if (!HIGH_OR_CRITICAL.has(info.severity)) {
                informational.push(line)
                continue
            }
            const allowance = activeAllowance(id)
            if (allowance)
                allowed.push(`${line} (allowed until ${allowance.expires})`)
            else failures.push(line)
        }
    }

    if (allowed.length) {
        console.log(
            `[audit:prod] ${allowed.length} HIGH/CRITICAL advisory(ies) on the dated allowlist (not gating until expiry):`,
        )
        allowed.forEach(line => console.log(line))
    }

    if (informational.length) {
        console.log(
            `[audit:prod] ${informational.length} sub-threshold advisory(ies) (not gating):`,
        )
        informational.forEach(line => console.log(line))
    }

    if (failures.length) {
        console.error(
            `\n[audit:prod] FAIL — ${failures.length} HIGH/CRITICAL advisory(ies) in production dependencies:`,
        )
        failures.forEach(line => console.error(line))
        console.error(
            '\nResolve by upgrading the affected package or adding a pinned pnpm override, then re-run.',
        )
        return 1
    }

    console.log(
        '[audit:prod] no HIGH/CRITICAL advisories in the production closure ✅',
    )
    return 0
}

const isDirectExecution =
    process.argv[1] &&
    path.resolve(process.argv[1]) ===
        path.resolve(fileURLToPath(import.meta.url))

if (isDirectExecution) {
    auditProdDeps()
        .then(code => process.exit(code))
        .catch((error: unknown) => {
            console.error(`[audit:prod] ${String(error)}`)
            process.exit(1)
        })
}
