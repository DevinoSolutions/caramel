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
    if (hasBackslashOrControl(trimmed)) return '/'
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

function hasBackslashOrControl(s: string): boolean {
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i)
        if (c === 0x5c || c < 0x20) return true
    }
    return false
}
