// src/lib/anonymousWriteQuota.ts
//
// A per-IP HOURLY quota for the two anonymous routes that write a row on
// behalf of a stranger (T-6224, T-6225): POST /api/sites/suggest and
// POST /api/sources. The shared 'mutation' bucket (30/min) lets one address
// fill the global daily caps in minutes (1000 suggestions in ~35 min, 500
// source requests in ~17 min), which would lock every honest visitor out
// until the window rolls. This quota keeps one address from spending the
// shared budget.
//
// In-memory and per process, like rateLimit.ts (single instance by design).
// TODO(T-6224): swap for a shared store if the app is ever scaled past one
// instance.
import { readClientIp } from '@/lib/clientIp'
import type { NextRequest } from 'next/server'
import { isIP } from 'node:net'
import { RateLimiterMemory, type RateLimiterRes } from 'rate-limiter-flexible'

const HOUR_SECONDS = 60 * 60

/**
 * The bucket key for a client address. IPv4 is the address itself. IPv6 is
 * its /64: a single host or customer is routinely handed a whole /64, so
 * keying on the full address would give one machine 2^64 fresh quotas.
 * An IPv4-mapped IPv6 address (`::ffff:1.2.3.4`) is the IPv4 address.
 * Anything that is not an IP (or no address at all) shares the 'unknown'
 * bucket, the same stance rateLimit.ts takes.
 */
export function quotaKeyFor(address: string | null): string {
    if (!address) return 'unknown'
    const ip = address
        .trim()
        .replace(/^\[|\]$/g, '')
        .split('%')[0]!
    const family = isIP(ip)
    if (family === 4) return ip
    if (family !== 6) return 'unknown'

    const lower = ip.toLowerCase()
    const mapped = /^(?:0{0,4}:){0,5}:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(
        lower,
    )
    if (mapped && isIP(mapped[1]!) === 4) return mapped[1]!

    // Expand `::` and an embedded IPv4 tail into eight 16-bit groups.
    let text = lower
    const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text)
    if (tail) {
        const hi = ((Number(tail[1]) << 8) | Number(tail[2])).toString(16)
        const lo = ((Number(tail[3]) << 8) | Number(tail[4])).toString(16)
        text = `${text.slice(0, tail.index)}${hi}:${lo}`
    }
    const [head = '', rest, extra] = text.split('::')
    if (extra !== undefined) return 'unknown'
    const left = head === '' ? [] : head.split(':')
    const right = rest === undefined || rest === '' ? [] : rest.split(':')
    const zeros =
        rest === undefined ? 0 : Math.max(0, 8 - left.length - right.length)
    const groups = [...left, ...Array<string>(zeros).fill('0'), ...right]
    if (groups.length !== 8) return 'unknown'
    return `${groups
        .slice(0, 4)
        .map(group => parseInt(group, 16).toString(16))
        .join(':')}::/64`
}

// Generous for a human (a handful of stores in an hour), useless for a flood.
function createQuotas() {
    return {
        'sites/suggest': new RateLimiterMemory({
            points: 10,
            duration: HOUR_SECONDS,
        }),
        sources: new RateLimiterMemory({
            points: 5,
            duration: HOUR_SECONDS,
        }),
    }
}

let quotas = createQuotas()

export type AnonymousWriteRoute = keyof ReturnType<typeof createQuotas>

export type AnonymousWriteQuota =
    { allowed: true } | { allowed: false; retryAfterSec: number }

/** Spend one write from this caller's hourly quota for `route`. */
export async function consumeAnonymousWriteQuota(
    req: NextRequest,
    route: AnonymousWriteRoute,
): Promise<AnonymousWriteQuota> {
    try {
        await quotas[route].consume(quotaKeyFor(readClientIp(req.headers)), 1)
        return { allowed: true }
    } catch (error) {
        // rate-limiter-flexible rejects with a RateLimiterRes once the quota
        // is spent. Anything else is a real fault and must surface, not read
        // as "over quota".
        if (error instanceof Error) throw error
        const res = error as RateLimiterRes
        return {
            allowed: false,
            retryAfterSec: Math.max(1, Math.ceil(res.msBeforeNext / 1000)),
        }
    }
}

/** Forget every counter (tests). */
export function resetAnonymousWriteQuotas(): void {
    quotas = createQuotas()
}
