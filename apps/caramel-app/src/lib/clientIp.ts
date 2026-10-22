// src/lib/clientIp.ts
//
// The ONE place that knows which request headers carry the visitor's IP, and
// in what order to trust them. Everything that needs a client IP goes through
// here: our own rate limiter (rateLimit.ts getClientIp), the agent-setup
// fetch id, and Better Auth's per-IP auth rate limit
// (auth.ts `advanced.ipAddress.ipAddressHeaders`). Reading these headers by
// hand anywhere else is a lint error (caramel/no-raw-client-ip-header).
//
// Deliberately free of imports (no env, no Next) so auth.ts can use it
// without dragging the rate limiter in.

/**
 * Trusted client-IP headers, most trustworthy first. The ordering is
 * load-bearing.
 *
 * grabcaramel.com is proxied by Cloudflare, and Traefik behind it sets
 * X-Real-IP to ITS OWN peer: the Cloudflare edge, not the visitor. Preferring
 * X-Real-IP therefore handed every visitor on earth the SAME rate-limit key,
 * i.e. one global bucket. Measured on dev 2026-08-08 with a clean 75s window:
 * a 30-request burst from a proxy exit returned 429s, and the very next
 * request from a DIFFERENT machine that had been idle was also 429. Both
 * directions of that are bad: 20 requests in 2s from one host could 429 the
 * API for every real user (a trivial DoS), while a scraper rotating IPs got
 * no per-client throttle at all. Better Auth hit the same wall (#256): its
 * default is `x-forwarded-for` alone, which behind Cloudflare + Traefik is a
 * multi-hop list it refuses to parse, so it keyed every auth path on one
 * shared bucket.
 *
 * Cloudflare always sets CF-Connecting-IP to the true client and strips any
 * client-supplied copy, so it is the only header here a caller cannot forge
 * through the edge. X-Real-IP / X-Forwarded-For stay as fallbacks for
 * topologies without Cloudflare (local dev, direct origin hits), where they
 * are only as trustworthy as whatever fronts the app. Residual risk: if the
 * origin were reachable bypassing Cloudflare, a caller could forge
 * CF-Connecting-IP too.
 */
export const CLIENT_IP_HEADERS = [
    'cf-connecting-ip',
    'x-real-ip',
    'x-forwarded-for',
] as const

/**
 * The visitor's IP from the first non-blank header in CLIENT_IP_HEADERS, or
 * null when none identifies the caller (the caller picks its own fallback:
 * the rate limiter meters unknown callers under one shared key). For
 * X-Forwarded-For (a comma list) the first entry is the original client.
 */
export function readClientIp(headers: Headers): string | null {
    for (const name of CLIENT_IP_HEADERS) {
        const raw = headers.get(name)
        if (!raw) continue
        const value =
            name === 'x-forwarded-for' ? raw.split(',')[0]?.trim() : raw.trim()
        if (value) return value
    }
    return null
}

/**
 * The visitor's IP as the Cloudflare edge reports it, or null when the request
 * did not carry CF-Connecting-IP. For identities that must not be forgeable
 * (the coupon report quorum, couponReportDedupe.ts): Cloudflare overwrites a
 * client-supplied CF-Connecting-IP, so a value here came from the edge, while
 * X-Real-IP and X-Forwarded-For are plain client input on any request that
 * did not pass through a proxy that rewrites them. A null means the request
 * reached the app without the edge (a direct origin hit, local dev, e2e); the
 * caller must not mint an identity from the fallback headers. A present value
 * that is not an IP address is treated as missing too. The residual
 * risk named on CLIENT_IP_HEADERS stays: a caller that bypasses Cloudflare can
 * still forge this header, which only the origin firewall closes.
 */
export function readEdgeClientIp(headers: Headers): string | null {
    const value = headers.get(CLIENT_IP_HEADERS[0])?.trim()
    return value && isIpAddress(value) ? value : null
}

const IPV4 =
    /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

/**
 * Is `value` a bare IPv4 or IPv6 address? Import-free on purpose (this module
 * is shared with auth.ts): IPv6 is checked by asking the URL parser to accept
 * it as a bracketed host, which only a real IPv6 literal survives. A zone id
 * (`%eth0`) or a port is not a bare address and is refused.
 */
function isIpAddress(value: string): boolean {
    if (IPV4.test(value)) return true
    if (!value.includes(':') || value.includes('%')) return false
    try {
        // The parser throws on anything that is not an IPv6 literal.
        return new URL(`http://[${value}]/`).hostname.startsWith('[')
    } catch {
        return false
    }
}

/**
 * Copy every client-IP header present on `from` onto `to`. For a server-side
 * hop that re-issues the visitor's request to our own API (the Safari OAuth
 * shim's exchange call): the inner request is metered by readClientIp too, so
 * it carries the original headers rather than none. Best effort only: if the
 * hop leaves through Cloudflare, Cloudflare overwrites CF-Connecting-IP (see
 * the TODO on completeSafariOauth in the oauth redirect route).
 */
export function forwardClientIpHeaders(from: Headers, to: Headers): void {
    for (const name of CLIENT_IP_HEADERS) {
        const value = from.get(name)
        if (value) to.set(name, value)
    }
}
