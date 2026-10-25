// src/lib/api/withoutSearchText.ts
//
// What a shopper typed into a store search must not reach a log line or a
// Sentry event (T-7505; the policy keeps search text no longer than the logs).
// Request URLs and bodies are scrubbed by sentryPiiScrub.ts, but a caught error
// is free text: a driver or database message can echo the value that made a
// statement fail. The three search routes pass their caught error through here
// before it is logged or handed to handleRouteError.
//
// Returns a NEW Error with the same name, `code` and stack shape, with every
// occurrence of each typed value (raw and URL-encoded) replaced. The original
// error object is not modified. A non-Error throw becomes a generic Error: its
// text is unknown, so none of it is kept.

const FILTERED_SEARCH = '[Filtered search text]'

/** One-character values would turn every message into noise; the shortest
 * search the routes act on is two characters (MIN_SEARCH_TERM_LENGTH). */
const MIN_VALUE_LENGTH = 2

function variants(values: ReadonlyArray<string | null | undefined>): string[] {
    const out = new Set<string>()
    for (const value of values) {
        if (!value || value.length < MIN_VALUE_LENGTH) continue
        out.add(value)
        out.add(encodeURIComponent(value))
        out.add(value.trim())
    }
    // Longest first, so a value that contains another is replaced whole.
    return Array.from(out)
        .filter(v => v.length >= MIN_VALUE_LENGTH)
        .sort((a, b) => b.length - a.length)
}

function replaceAll(text: string, needles: readonly string[]): string {
    let out = text
    for (const needle of needles) out = out.split(needle).join(FILTERED_SEARCH)
    return out
}

export function withoutSearchText(
    error: unknown,
    typedValues: ReadonlyArray<string | null | undefined>,
): Error {
    if (!(error instanceof Error)) {
        return new Error('non-Error thrown in a search route (text dropped)')
    }
    const needles = variants(typedValues)
    const safe = new Error(replaceAll(error.message, needles))
    safe.name = error.name
    if (error.stack) safe.stack = replaceAll(error.stack, needles)
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string') {
        Object.assign(safe, { code })
    }
    return safe
}
