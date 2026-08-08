// e2e/support/posthog.ts
//
// PostHog ingestion-VERIFICATION helper — Playwright/CI side ONLY. This is the
// piece that turns "the API returned 200" into "the event actually landed in
// PostHog": it polls the PostHog Query API (HogQL) for events tagged with the
// current Playwright run's test_run_id and returns the matched rows so a spec
// can assert on their real, ingested properties.
//
// ⚠️ This module reads POSTHOG_E2E_TEST_PROJECT_QUERY_READ_ONLY_PERSONAL_API_KEY
// — a Query:Read-only PostHog personal API key. It is loaded ONLY here (test
// runner process), NEVER by the app/server: env.ts fail-fasts at boot if that
// key is present in an app/container env. The key is never logged.
//
// Bounded polling only — no fixed sleeps. Ingestion is async (posthog-node
// captureImmediate + PostHog's own ingestion lag), so we poll the Query API
// until the row appears or a hard timeout elapses, then throw with context.
//
// Polling uses Playwright's expect.poll — NOT a hand-rolled setTimeout loop —
// because the test-quality guardrail (tests/unit/test-quality-guardrails.test.ts)
// bans wall-clock sleeps in e2e/**; expect.poll is the sanctioned bounded-poll
// primitive.
import { expect } from '@playwright/test'

/** The four config values this helper needs, resolved from process.env. */
interface PosthogVerificationConfig {
    host: string
    projectId: string
    readKey: string
}

/**
 * Resolve the verification config from process.env. Host falls back from the
 * dedicated NEXT_PUBLIC host var (the same project host the app captures to).
 * Returns null when any piece is missing.
 */
function resolveConfig(): PosthogVerificationConfig | null {
    const host = (
        process.env.POSTHOG_E2E_TEST_PROJECT_HOST ??
        process.env.NEXT_PUBLIC_POSTHOG_E2E_TEST_PROJECT_HOST ??
        ''
    ).replace(/\/+$/, '')
    const projectId = process.env.POSTHOG_E2E_TEST_PROJECT_ID ?? ''
    const readKey =
        process.env.POSTHOG_E2E_TEST_PROJECT_QUERY_READ_ONLY_PERSONAL_API_KEY ??
        ''
    if (!host || !projectId || !readKey) return null
    return { host, projectId, readKey }
}

/** True when the read key + project id + host are all present (spec skip-gate). */
export function isPosthogVerificationConfigured(): boolean {
    return resolveConfig() !== null
}

/** One matched, ingested PostHog event row (properties JSON already parsed). */
export interface PosthogEventRow {
    uuid: string
    event: string
    distinctId: string
    properties: Record<string, unknown>
}

interface QueryEventsArgs {
    /** The current Playwright run id — matched against properties.test_run_id. */
    testRunId: string
    /** The event name to match (e.g. 'support_request_submitted', '$pageview'). */
    event: string
    /**
     * Scope to ONE test's events via the test_scenario super prop the
     * handshake registers. Without this, the poll returns on the FIRST row any
     * test in the run ingested — a sibling test's minutes-old row satisfies
     * `rows.length > 0` while the caller's own event is still in the ingestion
     * pipeline, and every per-row assertion then runs against the wrong event
     * (the exact deterministic failure the $identify spec hit in CI).
     */
    testScenario?: string
    /** Hard ceiling on total polling time before throwing. */
    timeoutMs?: number
    /** Delay between poll attempts. */
    pollIntervalMs?: number
}

interface HogQLQueryResponse {
    results?: unknown[][]
    columns?: string[]
    error?: string
    detail?: string
}

/** Parse the HogQL `properties` cell, which comes back as a JSON string. */
function parseProperties(cell: unknown): Record<string, unknown> {
    if (cell && typeof cell === 'object') return cell as Record<string, unknown>
    if (typeof cell === 'string' && cell.length > 0) {
        try {
            const parsed: unknown = JSON.parse(cell)
            if (parsed && typeof parsed === 'object') {
                return parsed as Record<string, unknown>
            }
        } catch {
            // Fall through to empty — a malformed properties blob is treated as
            // "no matchable properties", never a silent crash.
        }
    }
    return {}
}

/** Run one HogQL query against the project's Query API. Throws on HTTP error. */
async function runQuery(
    config: PosthogVerificationConfig,
    hogql: string,
    values: Record<string, string>,
): Promise<PosthogEventRow[]> {
    const url = `${config.host}/api/projects/${config.projectId}/query`
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${config.readKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            query: { kind: 'HogQLQuery', query: hogql, values },
        }),
    })

    if (res.status === 401 || res.status === 403) {
        // Distinct, actionable message — never echo the key itself.
        throw new Error(
            `PostHog Query API rejected the read key (HTTP ${res.status}). ` +
                'Check POSTHOG_E2E_TEST_PROJECT_QUERY_READ_ONLY_PERSONAL_API_KEY is a ' +
                'valid Query:Read key scoped to project ' +
                `${config.projectId}.`,
        )
    }
    if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(
            `PostHog Query API HTTP ${res.status} for project ${config.projectId}: ${body.slice(0, 500)}`,
        )
    }

    const json = (await res.json()) as HogQLQueryResponse
    if (json.error || json.detail) {
        throw new Error(
            `PostHog Query API returned an error: ${json.error ?? json.detail}`,
        )
    }
    const rows = json.results ?? []
    // Column order is fixed by the SELECT below: uuid, event, distinct_id, properties.
    return rows.map(row => ({
        uuid: String(row[0] ?? ''),
        event: String(row[1] ?? ''),
        distinctId: String(row[2] ?? ''),
        properties: parseProperties(row[3]),
    }))
}

/**
 * Poll the PostHog Query API until at least one event matching
 * (test_run_id, event) is ingested, or throw after `timeoutMs`. Returns the
 * matched rows (newest first) with parsed properties — the REAL proof that an
 * event reached PostHog, not just that an API returned 200.
 */
export async function queryEventsByTestRun({
    testRunId,
    event,
    testScenario,
    // Ingestion lag on the shared self-hosted PostHog is VARIABLE: usually a few
    // seconds, but in a slow window BOTH the browser (posthog-js → /e/) and
    // server (posthog-node → /batch/) paths lag together — measured as high as
    // ~343s under consumer backlog. The ceiling is generous so the gate proves
    // REAL ingestion without flaking; the happy path returns on the first poll
    // the moment the row appears. Callers can pass a larger timeoutMs (the
    // support-flow specs use 420s).
    timeoutMs = 360_000,
    pollIntervalMs = 5_000,
}: QueryEventsArgs): Promise<PosthogEventRow[]> {
    const config = resolveConfig()
    if (!config) {
        throw new Error(
            'queryEventsByTestRun called without PostHog verification config — ' +
                'gate the test on isPosthogVerificationConfigured() first.',
        )
    }

    // Bounded 1-day window keeps the scan cheap; test_run_id makes it exact.
    const hogql =
        'SELECT uuid, event, distinct_id, properties ' +
        'FROM events ' +
        'WHERE properties.test_run_id = {tr} AND event = {ev} ' +
        (testScenario ? 'AND properties.test_scenario = {sc} ' : '') +
        'AND timestamp > now() - INTERVAL 1 DAY ' +
        'ORDER BY timestamp DESC LIMIT 10'
    const values: Record<string, string> = { tr: testRunId, ev: event }
    if (testScenario) values.sc = testScenario

    // Preflight ONE query up front: a bad read key (401/403) throws here and
    // fails FAST + loud, instead of silently polling for the whole timeout.
    const initial = await runQuery(config, hogql, values)
    if (initial.length > 0) return initial

    // Bounded polling via Playwright's expect.poll (sanctioned; no hand-rolled
    // wall-clock sleep). A transient query error is swallowed to "not yet" so a
    // blip doesn't fail the gate — a persistent bad key was already surfaced by
    // the preflight above. On timeout, expect.poll throws with `message`.
    let rows: PosthogEventRow[] = []
    await expect
        .poll(
            async () => {
                try {
                    rows = await runQuery(config, hogql, values)
                    return rows.length
                } catch {
                    return 0
                }
            },
            {
                timeout: timeoutMs,
                intervals: [pollIntervalMs],
                message:
                    `Timed out after ~${timeoutMs / 1000}s waiting for event "${event}" ` +
                    `with test_run_id=${testRunId} to ingest into PostHog project ${config.projectId}.`,
            },
        )
        .toBeGreaterThan(0)
    return rows
}
