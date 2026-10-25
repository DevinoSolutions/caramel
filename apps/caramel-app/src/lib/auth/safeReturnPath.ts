/**
 * Validate a `?next=` return path against open-redirect attacks.
 *
 * Parses against a placeholder origin so the browser's own URL logic does the
 * normalisation (backslashes, control characters, percent-encoded separators).
 * Rejects anything that resolves to a different origin or points at login/signup.
 */
const PLACEHOLDER = 'https://placeholder.invalid'

export function safeReturnPath(raw: string | undefined | null): string {
    if (!raw) return '/'
    const trimmed = raw.trim()
    if (!trimmed.startsWith('/')) return '/'
    // Reject backslashes and control characters before parsing — browsers
    // normalise these into path separators or strip them silently.
    if (/[\\\x00-\x1f]/.test(trimmed)) return '/'
    try {
        const parsed = new URL(trimmed, PLACEHOLDER)
        if (parsed.origin !== PLACEHOLDER) return '/'
        if (!parsed.pathname.startsWith('/')) return '/'
        // Reject scheme-like first segments (/javascript:..., /data:...)
        if (/^\/[^/]*:/.test(parsed.pathname)) return '/'
        const lower = parsed.pathname.toLowerCase()
        if (lower.startsWith('/login') || lower.startsWith('/signup'))
            return '/'
        return parsed.pathname + parsed.search + parsed.hash
    } catch {
        return '/'
    }
}
