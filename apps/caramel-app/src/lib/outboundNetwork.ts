import dns from 'node:dns'
import net from 'node:net'

// Outbound connections from the server: IPv4 first, and no 250 ms cut-off.
//
// Node 22 connects with "happy eyeballs" on by default: it tries each address
// a hostname resolves to for `autoSelectFamilyAttemptTimeout` (250 ms), then
// ABANDONS that attempt and moves to the next one. The production host has no
// IPv6 route, so for a dual-stack provider (Google, OpenRouter behind
// Cloudflare) the next address fails at once with ENETUNREACH and the whole
// request dies as `TypeError: fetch failed`:
//
//   connect ETIMEDOUT 74.125.197.95:443                     (IPv4 cut at 250 ms)
//   connect ENETUNREACH 2607:f8b0:4020:c0b::5f:443 - Local (:::0)
//
// That is one lost SYN (the kernel retransmits after about 1 s) away from
// failing, and it did: a Google sign-in (POST /api/extension/oauth), the cart
// classifier and the coupon-box pick, all in production, all this shape.
//
// So: resolve IPv4 first, and connect to that one address with the normal
// connect timeout instead of racing families. A hostname with no A record still
// resolves to its AAAA record, so an IPv6-only service keeps working.
export function configureOutboundNetwork(): {
    autoSelectFamily: boolean
    resultOrder: string
} {
    dns.setDefaultResultOrder('ipv4first')
    net.setDefaultAutoSelectFamily(false)
    return {
        autoSelectFamily: net.getDefaultAutoSelectFamily(),
        resultOrder: dns.getDefaultResultOrder(),
    }
}
