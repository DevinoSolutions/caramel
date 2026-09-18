// src/lib/emailDeliveryHealth.ts
//
// ASYNC transactional-email delivery health.
//
// The SYNCHRONOUS half of email failure is already loud: sendEmail() throws and
// src/lib/auth/auth.ts reports the throw to Sentry, flushes, and rethrows. That
// only covers the request/response with useSend. It does NOT cover the failure
// mode that actually loses mail: useSend 2xx-ACCEPTS the send, SES takes it, and
// the message is later marked BOUNCED / FAILED / COMPLAINED / SUPPRESSED, or
// simply never leaves QUEUED. Nothing in this app ever learned about that —
// grabcaramel.com has 55 BOUNCED and 2 FAILED rows in useSend's own log that
// reached no Sentry issue, no log line, and no human.
//
// This module is the read side of that gap: it asks useSend's OWN send log what
// happened to the mail we handed it in the last window, and turns a bad window
// into exactly ONE Sentry event with counts. It is deliberately:
//
//   * PII-free — the log rows carry `to`, `subject`, `html` and `text`. Those
//     fields are dropped at the parse boundary (toEmailLogEntry) and never
//     enter a report, a log line or a Sentry event. Only ids, timestamps,
//     statuses and counts travel.
//   * config-injected — no `@/lib/env` import, no `server-only`. The caller
//     (the boot monitor, or scripts/email-delivery-health.ts) supplies the
//     credentials, so the same code is usable from the Next server, from a
//     one-shot ops run, and from unit tests with a fake fetch.
//   * never-throwing at the top level — checkEmailDeliveryHealth() returns a
//     report with status 'error' instead of blowing up a boot or an interval.
//
// The useSend API this speaks to (verified against usesend.devino.ca, v1):
//   GET /api/v1/emails?page=<n>&limit=<n>  -> { data: Row[], count: number }
//        newest-first; `status` is NOT a supported filter (passing one is
//        silently ignored), so the window and the status split are done here.
//   GET /api/v1/domains                    -> Domain[] (id, name)
// Both are Bearer-authenticated with the same USESEND_API_KEY the SDK uses.

/** One useSend send-log row, stripped to the fields that carry no PII. */
export interface EmailLogEntry {
    id: string
    createdAt: string
    latestStatus: string
    domainId: number | null
}

/**
 * Terminal statuses that mean the message did NOT reach the recipient. Every
 * one of these is a delivery failure we want a human to see.
 * (useSend's EmailStatus enum, failure subset.)
 */
export const EMAIL_FAILURE_STATUSES = [
    'FAILED',
    'BOUNCED',
    'COMPLAINED',
    'REJECTED',
    'RENDERING_FAILURE',
    'SUPPRESSED',
] as const

/** Accepted-but-not-yet-resolved statuses. Stuck here = silently undelivered. */
export const EMAIL_PENDING_STATUSES = ['QUEUED', 'SCHEDULED', 'SENT'] as const

/** Provider says it is trying again. Not a failure yet, but worth a warning. */
export const EMAIL_DELAYED_STATUSES = ['DELIVERY_DELAYED'] as const

const FAILURE_SET: ReadonlySet<string> = new Set(EMAIL_FAILURE_STATUSES)
const PENDING_SET: ReadonlySet<string> = new Set(EMAIL_PENDING_STATUSES)
const DELAYED_SET: ReadonlySet<string> = new Set(EMAIL_DELAYED_STATUSES)

export const DEFAULT_WINDOW_MINUTES = 60
/** A send still QUEUED/SENT this long after creation is treated as stuck. */
export const DEFAULT_STUCK_AFTER_MINUTES = 30
/**
 * useSend's `/emails` endpoint validates `limit` with a zod `.max(50)` and
 * answers 400 above it — VERIFIED against usesend.devino.ca on 2026-09-16
 * (limit=50 -> 200, limit=51 -> 400 "Number must be less than or equal to 50").
 * A larger page size would make EVERY run come back `status: 'error'`, i.e.
 * exactly the silently-never-ran failure this monitor exists to end, so the
 * cap is enforced here rather than trusted to the caller.
 */
export const MAX_PAGE_SIZE = 50
/** Hard ceiling so a pathological log can never turn this into a crawl. */
export const DEFAULT_MAX_PAGES = 10

export type EmailDeliveryHealthStatus = 'ok' | 'degraded' | 'error' | 'skipped'

export interface EmailDeliveryHealthReport {
    status: EmailDeliveryHealthStatus
    /** Why the run was skipped or errored. Never carries a credential. */
    reason?: string
    windowStart: string
    windowEnd: string
    /** Rows created inside the window (after the domain filter). */
    scanned: number
    failed: number
    delayed: number
    stuckPending: number
    /** Count per raw useSend status, for the Sentry event and the log line. */
    byStatus: Record<string, number>
    /** Domain the window was filtered to; null = no filter could be resolved. */
    domainId: number | null
    pagesFetched: number
    /** True when maxPages was hit before the window was fully covered. */
    truncated: boolean
}

export interface EmailDeliveryHealthConfig {
    /** useSend base URL WITHOUT the /api/v1 suffix (e.g. https://usesend.x). */
    baseUrl: string
    apiKey: string
    /** Sender address; its domain selects which sends are ours. */
    fromEmail?: string
    windowMinutes?: number
    stuckAfterMinutes?: number
    pageSize?: number
    maxPages?: number
    now?: Date
    fetchImpl?: typeof fetch
}

/** `"Caramel <no_reply@grabcaramel.com>"` / `"no_reply@x"` -> `"x"`. */
export function extractEmailDomain(address: string): string | null {
    const match = /<([^>]+)>/.exec(address)
    const bare = (match ? match[1] : address).trim()
    const at = bare.lastIndexOf('@')
    if (at === -1 || at === bare.length - 1) return null
    return bare.slice(at + 1).toLowerCase()
}

/**
 * Narrow a raw useSend row to the PII-free shape. Returns null for anything
 * that does not carry the three fields the summary needs — a shape change in
 * the provider becomes "0 rows scanned", never a crash mid-interval.
 */
export function toEmailLogEntry(row: unknown): EmailLogEntry | null {
    if (typeof row !== 'object' || row === null) return null
    const candidate = row as Record<string, unknown>
    const { id, createdAt, latestStatus, domainId } = candidate
    if (typeof id !== 'string') return null
    if (typeof createdAt !== 'string') return null
    if (typeof latestStatus !== 'string') return null
    return {
        id,
        createdAt,
        latestStatus,
        domainId: typeof domainId === 'number' ? domainId : null,
    }
}

async function usesendGet(
    config: Pick<EmailDeliveryHealthConfig, 'baseUrl' | 'apiKey'>,
    path: string,
    fetchImpl: typeof fetch,
): Promise<unknown> {
    const base = config.baseUrl.replace(/\/+$/, '')
    const response = await fetchImpl(`${base}/api/v1${path}`, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
    })
    if (!response.ok) {
        // Status code only. The body of an error response can echo request
        // content, and this message ends up in Sentry and in the container log.
        throw new Error(`useSend GET ${path} failed with ${response.status}`)
    }
    return response.json()
}

/**
 * Resolve the useSend domain id that owns `fromEmail`. Returns null when the
 * address, the domain list or the match is unavailable — the caller then scans
 * every row instead of filtering, which is the safe direction (over-reporting
 * beats missing our own bounces).
 */
export async function resolveEmailDomainId(
    config: Pick<EmailDeliveryHealthConfig, 'baseUrl' | 'apiKey' | 'fromEmail'>,
    fetchImpl: typeof fetch,
): Promise<number | null> {
    if (!config.fromEmail) return null
    const wanted = extractEmailDomain(config.fromEmail)
    if (!wanted) return null
    const payload = await usesendGet(config, '/domains', fetchImpl)
    const list = Array.isArray(payload) ? payload : []
    for (const entry of list) {
        if (typeof entry !== 'object' || entry === null) continue
        const domain = entry as Record<string, unknown>
        if (
            typeof domain.name === 'string' &&
            domain.name.toLowerCase() === wanted &&
            typeof domain.id === 'number'
        ) {
            return domain.id
        }
    }
    return null
}

interface WindowCollection {
    entries: EmailLogEntry[]
    pagesFetched: number
    truncated: boolean
}

/**
 * Page the newest-first send log until the rows predate `windowStart` (or the
 * page budget runs out), keeping only the rows inside the window and — when a
 * domain id was resolved — only the rows sent from our own domain.
 */
export async function collectEmailLogWindow(
    config: EmailDeliveryHealthConfig,
    options: {
        windowStart: Date
        windowEnd: Date
        domainId: number | null
        fetchImpl: typeof fetch
    },
): Promise<WindowCollection> {
    const pageSize = Math.min(config.pageSize ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE)
    const maxPages = config.maxPages ?? DEFAULT_MAX_PAGES
    const entries: EmailLogEntry[] = []
    let pagesFetched = 0
    let reachedWindowStart = false

    for (let page = 1; page <= maxPages; page++) {
        const payload = await usesendGet(
            config,
            `/emails?page=${page}&limit=${pageSize}`,
            options.fetchImpl,
        )
        pagesFetched = page
        const rows =
            typeof payload === 'object' &&
            payload !== null &&
            Array.isArray((payload as { data?: unknown }).data)
                ? ((payload as { data: unknown[] }).data as unknown[])
                : []
        if (rows.length === 0) {
            reachedWindowStart = true
            break
        }
        for (const row of rows) {
            const entry = toEmailLogEntry(row)
            if (!entry) continue
            const created = new Date(entry.createdAt).getTime()
            if (Number.isNaN(created)) continue
            if (created < options.windowStart.getTime()) {
                reachedWindowStart = true
                continue
            }
            if (created >= options.windowEnd.getTime()) continue
            if (
                options.domainId !== null &&
                entry.domainId !== options.domainId
            ) {
                continue
            }
            entries.push(entry)
        }
        if (reachedWindowStart) break
        if (rows.length < pageSize) {
            // The log itself ended before the window did.
            reachedWindowStart = true
            break
        }
    }

    return { entries, pagesFetched, truncated: !reachedWindowStart }
}

/**
 * Pure classification of a window's rows. Split out from the fetch so the whole
 * decision table (what counts as failed / delayed / stuck) is testable without
 * a network, a clock or a provider.
 */
export function summariseEmailDeliveryWindow(
    entries: readonly EmailLogEntry[],
    options: { now: Date; stuckAfterMs: number },
): Pick<
    EmailDeliveryHealthReport,
    'scanned' | 'failed' | 'delayed' | 'stuckPending' | 'byStatus'
> {
    const byStatus: Record<string, number> = {}
    let failed = 0
    let delayed = 0
    let stuckPending = 0

    for (const entry of entries) {
        byStatus[entry.latestStatus] = (byStatus[entry.latestStatus] ?? 0) + 1
        if (FAILURE_SET.has(entry.latestStatus)) {
            failed++
            continue
        }
        if (DELAYED_SET.has(entry.latestStatus)) {
            delayed++
            continue
        }
        if (PENDING_SET.has(entry.latestStatus)) {
            const created = new Date(entry.createdAt).getTime()
            if (
                !Number.isNaN(created) &&
                options.now.getTime() - created >= options.stuckAfterMs
            ) {
                stuckPending++
            }
        }
    }

    return { scanned: entries.length, failed, delayed, stuckPending, byStatus }
}

/**
 * Run one delivery-health window. NEVER throws: a provider outage, a bad key or
 * a shape change all come back as `status: 'error'` with a reason, which the
 * caller reports exactly like a bad window.
 */
export async function checkEmailDeliveryHealth(
    config: EmailDeliveryHealthConfig,
): Promise<EmailDeliveryHealthReport> {
    const now = config.now ?? new Date()
    const windowMinutes = config.windowMinutes ?? DEFAULT_WINDOW_MINUTES
    const stuckAfterMs =
        (config.stuckAfterMinutes ?? DEFAULT_STUCK_AFTER_MINUTES) * 60_000
    const windowEnd = now
    const windowStart = new Date(now.getTime() - windowMinutes * 60_000)
    const base: Pick<
        EmailDeliveryHealthReport,
        | 'windowStart'
        | 'windowEnd'
        | 'scanned'
        | 'failed'
        | 'delayed'
        | 'stuckPending'
        | 'byStatus'
        | 'domainId'
        | 'pagesFetched'
        | 'truncated'
    > = {
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        scanned: 0,
        failed: 0,
        delayed: 0,
        stuckPending: 0,
        byStatus: {},
        domainId: null,
        pagesFetched: 0,
        truncated: false,
    }

    if (!config.baseUrl || !config.apiKey) {
        return {
            ...base,
            status: 'skipped',
            reason: 'useSend is not configured (USESEND_BASE_URL / USESEND_API_KEY)',
        }
    }

    const fetchImpl = config.fetchImpl ?? fetch
    try {
        const domainId = await resolveEmailDomainId(config, fetchImpl)
        const collected = await collectEmailLogWindow(config, {
            windowStart,
            windowEnd,
            domainId,
            fetchImpl,
        })
        const summary = summariseEmailDeliveryWindow(collected.entries, {
            now,
            stuckAfterMs,
        })
        const bad =
            summary.failed > 0 ||
            summary.stuckPending > 0 ||
            summary.delayed > 0
        return {
            ...base,
            ...summary,
            domainId,
            pagesFetched: collected.pagesFetched,
            truncated: collected.truncated,
            status: bad ? 'degraded' : 'ok',
        }
    } catch (error) {
        return {
            ...base,
            status: 'error',
            reason: error instanceof Error ? error.message : String(error),
        }
    }
}

/** One-line, PII-free ops summary — what lands in the container log. */
export function formatEmailDeliveryHealthLine(
    report: EmailDeliveryHealthReport,
): string {
    const statuses = Object.entries(report.byStatus)
        .map(([status, count]) => `${status}=${count}`)
        .sort()
        .join(' ')
    return (
        `[email-health] ${report.status} window=${report.windowStart}..${report.windowEnd} ` +
        `scanned=${report.scanned} failed=${report.failed} delayed=${report.delayed} ` +
        `stuck=${report.stuckPending}${statuses ? ` (${statuses})` : ''}` +
        `${report.truncated ? ' truncated=true' : ''}` +
        `${report.reason ? ` reason=${report.reason}` : ''}`
    )
}
