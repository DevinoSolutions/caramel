import { getDomain, parse } from 'tldts'

/**
 * The registrable domain a coupon `site` belongs to, or null if the input
 * doesn't name a real store.
 *
 * WHY THIS EXISTS. Two copies of a hand-rolled `getBaseDomain` used to do:
 *
 *     const parts = hostname.split('.')
 *     return parts.length > 2 ? parts.slice(-2).join('.') : hostname
 *
 * "last two labels" is only the registrable domain under single-label public
 * suffixes. Under a multi-label suffix it collapses to the SUFFIX ITSELF:
 * `mymemory.co.uk` has three labels, so it became `co.uk`. couponsRepo then
 * matched `(site = 'co.uk' OR site LIKE '%.co.uk')` — every UK store in the
 * catalogue.
 *
 * Measured on 2026-08-05: a shopper checking out a £29.99 USB stick on
 * mymemory.co.uk was offered bareMinerals makeup codes. EVERY .co.uk and
 * .com.au host returned the same mixed bucket — 230 of 2,670 supported stores
 * (8.6%) — including `notarealstore12345.co.uk`, an invented domain that
 * cheerfully returned 50 coupons. The same helper feeds the public
 * /coupons/[store] pages, so those rendered as indexable pages for a fictional
 * store called "co.uk" carrying another brand's codes.
 *
 * tldts resolves against the real Public Suffix List, so co.uk, com.au, co.nz,
 * github.io and the rest are handled by data rather than by a label count.
 *
 * Returns null (rather than a bare suffix) when the input resolves to a public
 * suffix with no registrable label in front of it — `co.uk` is not a store, and
 * treating it as one is what produced the 50-coupon response above. Callers
 * must reject that, not query on it.
 */
export function resolveStoreDomain(raw: string): string | null {
    const input = String(raw ?? '').trim()
    if (!input) return null

    let hostname = input
    try {
        hostname = new URL(
            input.startsWith('http') ? input : `https://${input}`,
        ).hostname
    } catch {
        return null
    }

    // Keep the pre-existing character allowlist: this value reaches a SQL LIKE
    // pattern downstream, so anything outside hostname characters is refused
    // outright rather than sanitised.
    if (!/^[a-z0-9.-]+$/i.test(hostname)) return null

    const parsed = parse(hostname)
    // A bare public suffix ("co.uk", "com.au") names no store.
    if (parsed.isIcann === false && parsed.isPrivate === false) {
        // Unknown TLD (localhost, .test, an internal host) — not a store either.
        return null
    }
    if (!parsed.domain || parsed.domain === parsed.publicSuffix) return null

    const domain = getDomain(hostname)
    return domain ? domain.toLowerCase() : null
}
