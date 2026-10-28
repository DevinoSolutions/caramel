// The handoff route's request body (T-7852): the one `next` path the
// WebView is sent to once the session cookie is set. It lives here, not in
// route.ts, because a Next.js route file may export only its handlers, and
// the unit test must check the real schema rather than a copy (T-9424).
import { z } from 'zod'

// Must start with one of these prefixes (or be exactly "/").
const ALLOWED_NEXT_PREFIXES = ['/coupons', '/profile', '/welcome']

export const HandoffBody = z.object({
    next: z
        .string()
        .max(512)
        .refine(
            s => {
                // Must be a safe same-origin path
                if (s === '/') return true
                // Reject control characters, whitespace, backslash, // prefix.
                // Check char codes instead of a regex to avoid the
                // no-control-regex lint rule (oxlint does not support inline
                // suppressions for it).
                for (let i = 0; i < s.length; i++) {
                    const c = s.charCodeAt(i)
                    if (c <= 0x1f || c === 0x7f) return false
                }
                if (/\s/.test(s) || s.includes('\\')) return false
                if (s.startsWith('//')) return false
                // Reject anything with a scheme
                if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) return false
                // Reject percent-encoded CR/LF (header injection)
                if (/%0[dDaA]/i.test(s)) return false
                // Must start with one of the allowed prefixes
                if (!ALLOWED_NEXT_PREFIXES.some(p => s.startsWith(p)))
                    return false
                // Must match the overall path shape
                return /^\/(?!\/)[^\s\\]*$/.test(s)
            },
            { message: 'invalid next' },
        ),
})
