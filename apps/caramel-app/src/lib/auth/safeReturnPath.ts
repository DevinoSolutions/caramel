/**
 * Validate a `?next=` return path against open-redirect attacks.
 *
 * Accepts ONLY relative paths on this origin: must start with `/`, must not
 * start with `//` (protocol-relative URL), must not contain a `:` before the
 * first `/` (scheme injection), and must not point at the login/signup pages
 * (redirect loop). Everything else falls back to `/`.
 */
export function safeReturnPath(raw: string | undefined | null): string {
    if (!raw) return '/'
    const trimmed = raw.trim()
    if (!trimmed.startsWith('/')) return '/'
    if (trimmed.startsWith('//')) return '/'
    if (/^\/[^/]*:/.test(trimmed)) return '/'
    const lower = trimmed.toLowerCase()
    if (lower.startsWith('/login') || lower.startsWith('/signup')) return '/'
    return trimmed
}
