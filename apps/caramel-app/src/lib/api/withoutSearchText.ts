// src/lib/api/withoutSearchText.ts
//
// What a shopper typed into a store search must not reach a log line or a
// Sentry event (T-7505; the policy keeps search text no longer than the logs).
// Request URLs and bodies are scrubbed by sentryPiiScrub.ts, but a caught error
// is free text: a driver or database message can echo the value that made a
// statement fail. The three search routes pass their caught error through here
// before it is logged or handed to handleRouteError.
//
// Returns a NEW Error with the same name and `code`, with every occurrence of
// each typed value replaced in the MESSAGE and in the stack's header lines (the
// text before the first "    at " frame). The stack FRAMES are left byte for
// byte as they were: they hold file paths and function names, and rewriting
// them (a search for "coupon" inside "couponsRepo.ts") breaks source maps and
// issue grouping. The original error object is not modified. A non-Error throw
// becomes a generic Error: its text is unknown, so none of it is kept.
import { likeLiteral } from '@/lib/likeLiteral'

const FILTERED_SEARCH = '[Filtered search text]'

/** One-character values would turn every message into noise; the shortest
 * search the routes act on is two characters (MIN_SEARCH_TERM_LENGTH). */
const MIN_VALUE_LENGTH = 2

/** Where a V8 stack's header (name + message, possibly multi-line) ends. */
const FIRST_FRAME = '\n    at '

/** The forms one typed string can take in a message: as typed, trimmed,
 * URL-encoded, and LIKE-escaped (couponsRepo.ts builds `%my\_store%` from
 * `my_store` and a driver error echoes the pattern, not the typed text). */
function forms(value: string): string[] {
    return [
        value,
        value.trim(),
        encodeURIComponent(value),
        likeLiteral(value),
        likeLiteral(value.trim()),
    ]
}

function variants(values: ReadonlyArray<string | null | undefined>): string[] {
    const out = new Set<string>()
    for (const value of values) {
        if (!value || value.length < MIN_VALUE_LENGTH) continue
        for (const form of forms(value)) out.add(form)
        // `key_words` is a comma list and couponsRepo.ts matches each trimmed
        // token on its own (`red,blue` becomes `%red%`, `%blue%`).
        for (const token of value.split(',')) {
            const trimmed = token.trim()
            if (trimmed.length < MIN_VALUE_LENGTH) continue
            for (const form of forms(trimmed)) out.add(form)
        }
    }
    // Longest first, so a value that contains another is replaced whole.
    return Array.from(out)
        .filter(v => v.length >= MIN_VALUE_LENGTH)
        .sort((a, b) => b.length - a.length)
}

/** One left-to-right pass, longest needle first at each position. A needle
 * loop of split/join would re-scan the placeholder it just wrote: a typed
 * "red" matches inside "[Filtered search text]". No regex, so no typed
 * character needs escaping. */
function replaceAll(text: string, needles: readonly string[]): string {
    let out = ''
    let i = 0
    while (i < text.length) {
        const needle = needles.find(n => text.startsWith(n, i))
        if (needle) {
            out += FILTERED_SEARCH
            i += needle.length
        } else {
            out += text[i]
            i += 1
        }
    }
    return out
}

/** The stack with only its header scrubbed. The usual header is exactly
 * `${name}: ${message}`; when it ends with the original message, that tail is
 * swapped for the scrubbed message so the error NAME is never touched (a typed
 * "ma" must not turn PrismaClientKnownRequestError into "Pris[...]"). */
function scrubStack(
    stack: string,
    original: Error,
    safeMessage: string,
    needles: readonly string[],
): string {
    const frameAt = stack.indexOf(FIRST_FRAME)
    const header = frameAt === -1 ? stack : stack.slice(0, frameAt)
    const frames = frameAt === -1 ? '' : stack.slice(frameAt)
    const safeHeader =
        original.message && header.endsWith(original.message)
            ? header.slice(0, header.length - original.message.length) +
              safeMessage
            : replaceAll(header, needles)
    return safeHeader + frames
}

export function withoutSearchText(
    error: unknown,
    typedValues: ReadonlyArray<string | null | undefined>,
): Error {
    if (!(error instanceof Error)) {
        return new Error('non-Error thrown in a search route (text dropped)')
    }
    const needles = variants(typedValues)
    const safeMessage = replaceAll(error.message, needles)
    const safe = new Error(safeMessage)
    safe.name = error.name
    if (error.stack) {
        safe.stack = scrubStack(error.stack, error, safeMessage, needles)
    }
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string') {
        Object.assign(safe, { code })
    }
    return safe
}
