// src/lib/emailDeliveryHealth.ts
//
// ASYNC transactional-email delivery health.
//
// The SYNCHRONOUS half of email failure is already loud: sendEmail() throws and
// src/lib/auth/auth.ts reports the throw to Sentry, flushes, and rethrows. That
// only covers the request/response with Sendly. It does NOT cover the failure
// mode that actually loses mail: the provider 2xx-ACCEPTS the send (Sendly
// answers 202 PENDING), the mail goes on to SES, and the message is later
// marked BOUNCED / FAILED / REJECTED / complained, or simply never leaves
// PENDING/SENDING. (On the previous provider, useSend, grabcaramel.com had 55
// BOUNCED and 2 FAILED rows that reached no Sentry issue, no log line and no
// human — that is the gap this module exists to close.)
//
// This module is the read side of that gap: it asks Sendly's OWN email list
// what happened to the mail we handed it in the last window, and turns a bad
// window into exactly ONE Sentry event with counts. It is deliberately:
//
//   * PII-free — the list rows carry `subject` (and, on some reads, `to`).
//     Those fields are dropped at the parse boundary (toEmailLogEntry) and
//     never enter a report, a log line or a Sentry event. Only ids,
//     timestamps, statuses, the sender DOMAIN and counts travel.
//   * config-injected — no `@/lib/env` import, no `server-only`. The caller
//     (the boot monitor, or scripts/email-delivery-health.ts) supplies the
//     credentials, so the same code is usable from the Next server, from a
//     one-shot ops run, and from unit tests with a fake fetch.
//   * never-throwing at the top level — checkEmailDeliveryHealth() returns a
//     report with status 'error' instead of blowing up a boot or an interval.
//
// SHARED PROJECT: grabcaramel.com lives in the Sendly "Devino" project, which
// also sends for other Devino apps, and a Sendly key cannot be scoped to one
// domain. So this check is ALWAYS filtered to the configured sender:
//
//   * the provider query is narrowed with the list endpoint's `from` filter
//     (checked 2026-10-20 against the live API: an EXACT, case-sensitive match
//     on the bare sender address; a domain-only value matches nothing), so
//     other apps' mail cannot eat the page budget;
//   * every returned row is ALSO filtered to the sender DOMAIN here, so a
//     provider that ever loosens that match cannot leak another app's mail in;
//   * with no usable sender (empty / not an address) the check REFUSES to run
//     (status 'error') rather than falling back to scanning the whole project.
//
// If the page budget runs out before the window start is reached, the window
// was not fully covered: that reports 'incomplete' (reported to Sentry, non-zero
// CLI exit), never 'ok' - a gap in coverage must not read as a clean bill.
//
// The Sendly API this speaks to (sendly-sdk 1.1.0, `sendly.emails.list`):
//   GET /api/emails?limit=<n>&cursor=<c>&from=<address> -> { data: Email[], nextCursor? }
//        newest-first, cursor-paginated. Row fields used: id, createdAt,
//        status, from, complainedAt.
// It needs a key with the `emails:read` scope (sending uses `emails:send`).
import { Sendly } from 'sendly-sdk'

/** One Sendly email-list row, stripped to the fields that carry no PII. */
export interface EmailLogEntry {
    id: string
    createdAt: string
    /** Sendly's delivery status (PENDING, SENDING, SENT, DELIVERED, …). */
    latestStatus: string
    /** Lower-cased domain of the row's `from`; null when it cannot be read. */
    fromDomain: string | null
    /** `complainedAt` is set — a spam complaint, which is not a status. */
    complained: boolean
}

/**
 * Terminal statuses that mean the message did NOT reach the recipient. Every
 * one of these is a delivery failure we want a human to see. (Sendly's
 * EmailDeliveryStatus enum, failure subset; a spam COMPLAINT is not a status
 * there — it arrives as `complainedAt` and is counted as a failure separately.)
 */
export const EMAIL_FAILURE_STATUSES = [
    'FAILED',
    'BOUNCED',
    'REJECTED',
    'RENDERING_FAILURE',
] as const

/** Accepted-but-not-yet-resolved statuses. Stuck here = silently undelivered. */
export const EMAIL_PENDING_STATUSES = ['PENDING', 'SENDING', 'SENT'] as const

/** Provider says it is trying again. Not a failure yet, but worth a warning. */
export const EMAIL_DELAYED_STATUSES = ['DELIVERY_DELAY'] as const

const FAILURE_SET: ReadonlySet<string> = new Set(EMAIL_FAILURE_STATUSES)
const PENDING_SET: ReadonlySet<string> = new Set(EMAIL_PENDING_STATUSES)
const DELAYED_SET: ReadonlySet<string> = new Set(EMAIL_DELAYED_STATUSES)

export const DEFAULT_WINDOW_MINUTES = 60
/** A send still PENDING/SENDING/SENT this long after creation is stuck. */
export const DEFAULT_STUCK_AFTER_MINUTES = 30
/**
 * Rows per page. Sendly's list endpoint caps `limit` at 100 (the MCP tool for
 * the same endpoint answers "expected number to be <=100" at 101 — checked
 * 2026-10-20); 50 stays well inside it. Enforced here rather than trusted to
 * the caller: an over-cap page would make EVERY run come back `status:
 * 'error'`, i.e. exactly the silently-never-ran failure this monitor ends.
 */
export const MAX_PAGE_SIZE = 50
/** Hard ceiling so a pathological log can never turn this into a crawl. */
export const DEFAULT_MAX_PAGES = 10

/**
 * ok         every row in the window was read and none is bad.
 * degraded   a bad row exists (failed / complained / stuck / delayed).
 * incomplete the page budget ran out before the window start: coverage gap.
 * error      the check could not run (provider error, unusable sender).
 * skipped    Sendly is not configured.
 */
export type EmailDeliveryHealthStatus =
    | 'ok'
    | 'degraded'
    | 'incomplete'
    | 'error'
    | 'skipped'

export interface EmailDeliveryHealthReport {
    status: EmailDeliveryHealthStatus
    /** Why the run was skipped or errored. Never carries a credential. */
    reason?: string
    windowStart: string
    windowEnd: string
    /** Rows created inside the window (after the sender-domain filter). */
    scanned: number
    failed: number
    delayed: number
    stuckPending: number
    /** Count per raw Sendly status, for the Sentry event and the log line. */
    byStatus: Record<string, number>
    /**
     * Sender domain the window was filtered to. null only when the check
     * REFUSED to run (no usable sender address) - it never means "unfiltered".
     */
    senderDomain: string | null
    pagesFetched: number
    /** True when maxPages was hit before the window was fully covered (status 'incomplete'). */
    truncated: boolean
}

export interface EmailDeliveryHealthConfig {
    /** Sendly API key with the `emails:read` scope (required to list). */
    apiKey: string
    /** Override the Sendly API base (staging); undefined → SDK default. */
    baseUrl?: string
    /**
     * Bare sender address (`no_reply@grabcaramel.com`). REQUIRED in practice:
     * it narrows the provider query and selects which sends are ours in the
     * shared Sendly project. Empty / not an address -> the check errors out.
     */
    fromEmail?: string
    windowMinutes?: number
    stuckAfterMinutes?: number
    pageSize?: number
    maxPages?: number
    now?: Date
    fetchImpl?: typeof fetch
}

/** `"Caramel <no_reply@grabcaramel.com>"` / `"no_reply@x"` -> the bare address. */
function bareAddress(address: string): string {
    const match = /<([^>]+)>/.exec(address)
    return (match ? match[1] : address).trim()
}

/** `"Caramel <no_reply@grabcaramel.com>"` / `"no_reply@x"` -> `"x"`. */
export function extractEmailDomain(address: string): string | null {
    const bare = bareAddress(address)
    const at = bare.lastIndexOf('@')
    if (at === -1 || at === bare.length - 1) return null
    return bare.slice(at + 1).toLowerCase()
}

/**
 * The sender identity the check is pinned to, or null when `fromEmail` is not
 * a usable address (empty, no local part, no dotted domain, or any whitespace).
 */
function resolveSender(
    fromEmail: string | undefined,
): { address: string; domain: string } | null {
    if (!fromEmail) return null
    const address = bareAddress(fromEmail)
    if (/\s/.test(address)) return null
    const at = address.lastIndexOf('@')
    if (at < 1) return null
    const domain = extractEmailDomain(address)
    if (!domain || !domain.includes('.') || domain.startsWith('.')) return null
    return { address, domain }
}

/**
 * Narrow a raw Sendly row to the PII-free shape. Returns null for anything
 * that does not carry the three fields the summary needs — a shape change in
 * the provider becomes "0 rows scanned", never a crash mid-interval.
 */
export function toEmailLogEntry(row: unknown): EmailLogEntry | null {
    if (typeof row !== 'object' || row === null) return null
    const candidate = row as Record<string, unknown>
    const { id, createdAt, status, from, complainedAt } = candidate
    if (typeof id !== 'string') return null
    if (typeof createdAt !== 'string') return null
    if (typeof status !== 'string') return null
    return {
        id,
        createdAt,
        latestStatus: status,
        fromDomain: typeof from === 'string' ? extractEmailDomain(from) : null,
        complained: typeof complainedAt === 'string' && complainedAt !== '',
    }
}

interface WindowCollection {
    entries: EmailLogEntry[]
    pagesFetched: number
    truncated: boolean
}

function createSendlyClient(config: EmailDeliveryHealthConfig): Sendly {
    return new Sendly({
        apiKey: config.apiKey,
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
        ...(config.fetchImpl ? { fetch: config.fetchImpl } : {}),
    })
}

/**
 * Page the newest-first email list (narrowed server-side to the sender address)
 * until the rows predate `windowStart` or the page budget runs out, keeping
 * only the rows inside the window that were sent from our own domain.
 */
export async function collectEmailLogWindow(
    config: EmailDeliveryHealthConfig,
    options: {
        windowStart: Date
        windowEnd: Date
        senderAddress: string
        senderDomain: string
    },
): Promise<WindowCollection> {
    const client = createSendlyClient(config)
    const pageSize = Math.min(config.pageSize ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE)
    const maxPages = config.maxPages ?? DEFAULT_MAX_PAGES
    const entries: EmailLogEntry[] = []
    let pagesFetched = 0
    let reachedWindowStart = false
    let cursor: string | undefined

    for (let page = 1; page <= maxPages; page++) {
        const result = await client.emails.list({
            limit: pageSize,
            from: options.senderAddress,
            ...(cursor ? { cursor } : {}),
        })
        pagesFetched = page
        const rows: unknown[] = Array.isArray(result.data) ? result.data : []
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
            if (entry.fromDomain !== options.senderDomain) continue
            entries.push(entry)
        }
        if (reachedWindowStart) break
        if (!result.nextCursor) {
            // The list itself ended before the window did.
            reachedWindowStart = true
            break
        }
        cursor = result.nextCursor
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
        if (FAILURE_SET.has(entry.latestStatus) || entry.complained) {
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
    // The Sendly project is shared with other Devino apps, so the check is
    // always pinned to our sender. No usable sender -> refuse (see below).
    const sender = resolveSender(config.fromEmail)
    const senderDomain = sender?.domain ?? null
    const base: Pick<
        EmailDeliveryHealthReport,
        | 'windowStart'
        | 'windowEnd'
        | 'scanned'
        | 'failed'
        | 'delayed'
        | 'stuckPending'
        | 'byStatus'
        | 'senderDomain'
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
        senderDomain,
        pagesFetched: 0,
        truncated: false,
    }

    if (!config.apiKey) {
        return {
            ...base,
            status: 'skipped',
            reason: 'Sendly is not configured (SENDLY_API_KEY)',
        }
    }

    if (!sender) {
        return {
            ...base,
            status: 'error',
            reason:
                'refusing to run unfiltered: the sender address (SENDLY_FROM_EMAIL) is empty or not an email address, ' +
                'and the Sendly project is shared with other apps',
        }
    }

    try {
        const collected = await collectEmailLogWindow(config, {
            windowStart,
            windowEnd,
            senderAddress: sender.address,
            senderDomain: sender.domain,
        })
        const summary = summariseEmailDeliveryWindow(collected.entries, {
            now,
            stuckAfterMs,
        })
        const bad =
            summary.failed > 0 ||
            summary.stuckPending > 0 ||
            summary.delayed > 0
        // A bad row outranks a coverage gap (both are reported); a coverage
        // gap alone must never read as 'ok'.
        const status: EmailDeliveryHealthStatus = bad
            ? 'degraded'
            : collected.truncated
              ? 'incomplete'
              : 'ok'
        return {
            ...base,
            ...summary,
            pagesFetched: collected.pagesFetched,
            truncated: collected.truncated,
            status,
            ...(collected.truncated
                ? {
                      reason: `page budget exhausted after ${collected.pagesFetched} page(s) before the window start; older rows in the window were not read`,
                  }
                : {}),
        }
    } catch (error) {
        return {
            ...base,
            status: 'error',
            // Status/code only (SendlyError.message is the API's own text and
            // never echoes our request body); no credential is ever in it.
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
