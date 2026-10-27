// Sanitized failure evidence for the E2E log (T-9427).
//
// Why this exists: when a deployed-site test fails because its page never
// hydrated, the question is always "which request broke it": a /_next/static
// chunk answering 404 (HTML and JS from different builds, i.e. a prod deploy
// swapped containers mid-run) or a net:: error (a network event on the runner)
// or a chunk that never finished. Playwright traces answer that but hold the
// test account's cookies and request bodies, and this repo is PUBLIC, so traces
// and test-results are never uploaded. The job LOG carries the answer instead,
// and this module is what keeps the log safe: it only ever sees a request's
// method, URL, resource type and outcome, and it prints the URL as host + path.
// No query string, no fragment, no headers, no cookies, no bodies.

export interface RequestEvidence {
    method: string
    url: string
    resourceType: string
    /** HTTP status, a `net::ERR_*` text, or `pending` (started, never finished). */
    outcome: string
}

/** Longest URL path shown; the rest is cut with an ellipsis. */
const MAX_PATH_LENGTH = 120
/** Evidence lines printed per failed test; the remainder is counted, not shown. */
export const MAX_EVIDENCE_LINES = 30

/** Schemes whose "path" is a payload or a script: only the scheme is printed. */
const SCHEME_ONLY_PROTOCOLS = new Set(['blob:', 'data:', 'javascript:'])
/** A path segment this long and made only of token characters is masked. */
const TOKEN_LIKE_SEGMENT = /^[A-Za-z0-9_-]{20,}$/
/** Everything after one of these path segments is a one-time token. */
const TOKEN_PARENT_SEGMENTS = new Set(['reset-password', 'verify-email'])
const REDACTED = '<redacted>'

function maskedPath(pathname: string): string {
    let afterTokenParent = false
    return pathname
        .split('/')
        .map(segment => {
            if (afterTokenParent && segment !== '') return REDACTED
            if (TOKEN_PARENT_SEGMENTS.has(segment)) afterTokenParent = true
            return TOKEN_LIKE_SEGMENT.test(segment) ? REDACTED : segment
        })
        .join('/')
}

/**
 * `host` + masked `pathname` of a URL, nothing else: no query, no fragment, no
 * credentials. blob:/data:/javascript: URLs print their scheme only, path
 * segments that look like tokens print as `<redacted>`, and a URL that does not
 * parse prints as a fixed marker rather than as the raw string, which could
 * carry a query.
 */
export function sanitizedUrl(raw: string): string {
    let parsed: URL
    try {
        parsed = new URL(raw)
    } catch {
        return '(unparseable url)'
    }
    if (SCHEME_ONLY_PROTOCOLS.has(parsed.protocol)) return parsed.protocol
    const shown = `${parsed.host}${maskedPath(parsed.pathname)}`
    return shown.length > MAX_PATH_LENGTH
        ? `${shown.slice(0, MAX_PATH_LENGTH)}...`
        : shown
}

function pathnameOf(entry: RequestEvidence): string {
    return new URL(entry.url, 'http://invalid.example').pathname
}

/** Chunk and document requests are the ones that decide whether a page hydrates. */
export function isHydrationCritical(entry: RequestEvidence): boolean {
    return (
        entry.resourceType === 'document' ||
        pathnameOf(entry).startsWith('/_next/')
    )
}

/**
 * The signal that explains a page that never hydrated: any /_next/static
 * request that failed or answered 4xx/5xx (only those are recorded), and any
 * /_next/ or document request still pending when the test ended. These print
 * first, so the line cap can never cut them off.
 */
function isStalledOrBrokenChunk(entry: RequestEvidence): boolean {
    if (entry.outcome === 'pending') return isHydrationCritical(entry)
    return pathnameOf(entry).startsWith('/_next/static/')
}

/** Critical entries first (order kept within each group), duplicates merged. */
function orderedUniqueEvidence(
    entries: readonly RequestEvidence[],
): { entry: RequestEvidence; count: number }[] {
    const merged = new Map<string, { entry: RequestEvidence; count: number }>()
    for (const entry of entries) {
        const key = `${entry.method} ${sanitizedUrl(entry.url)} ${entry.outcome} ${entry.resourceType}`
        const existing = merged.get(key)
        if (existing) existing.count += 1
        else merged.set(key, { entry, count: 1 })
    }
    const all = Array.from(merged.values())
    return [
        ...all.filter(item => isStalledOrBrokenChunk(item.entry)),
        ...all.filter(item => !isStalledOrBrokenChunk(item.entry)),
    ]
}

export function formatRequestEvidence(
    header: string,
    entries: readonly RequestEvidence[],
): string[] {
    const lines = [`[request-evidence] ${header}`]
    if (entries.length === 0) {
        lines.push(
            '[request-evidence]   no failed, 4xx/5xx, or unfinished request and no document request was seen',
        )
        return lines
    }
    const ordered = orderedUniqueEvidence(entries)
    for (const { entry, count } of ordered.slice(0, MAX_EVIDENCE_LINES)) {
        const repeated = count > 1 ? ` x${count}` : ''
        lines.push(
            `[request-evidence]   ${entry.method} ${sanitizedUrl(entry.url)} -> ${entry.outcome} (${entry.resourceType})${repeated}`,
        )
    }
    if (ordered.length > MAX_EVIDENCE_LINES) {
        lines.push(
            `[request-evidence]   ... and ${ordered.length - MAX_EVIDENCE_LINES} more`,
        )
    }
    return lines
}
