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

/**
 * `host` + `pathname` of a URL, nothing else. A URL that does not parse prints
 * as a fixed marker rather than as the raw string, which could carry a query.
 */
export function sanitizedUrl(raw: string): string {
    let parsed: URL
    try {
        parsed = new URL(raw)
    } catch {
        return '(unparseable url)'
    }
    const shown = `${parsed.host}${parsed.pathname}`
    return shown.length > MAX_PATH_LENGTH
        ? `${shown.slice(0, MAX_PATH_LENGTH)}...`
        : shown
}

/** Chunk and document requests are the ones that decide whether a page hydrates. */
export function isHydrationCritical(entry: RequestEvidence): boolean {
    return (
        entry.resourceType === 'document' ||
        new URL(entry.url, 'http://invalid.example').pathname.startsWith(
            '/_next/',
        )
    )
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
    for (const entry of entries.slice(0, MAX_EVIDENCE_LINES)) {
        lines.push(
            `[request-evidence]   ${entry.method} ${sanitizedUrl(entry.url)} -> ${entry.outcome} (${entry.resourceType})`,
        )
    }
    if (entries.length > MAX_EVIDENCE_LINES) {
        lines.push(
            `[request-evidence]   ... and ${entries.length - MAX_EVIDENCE_LINES} more`,
        )
    }
    return lines
}
