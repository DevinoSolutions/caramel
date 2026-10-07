// Canonical-URL redirects, owned by the app since the 2026-08-08 compose
// cutover (compose-type Dokploy services carry no proxy redirects, and
// host/scheme matching is impossible in next.config redirects()).
//
// 1. www.grabcaramel.com -> grabcaramel.com (308). BETTER_AUTH_URL /
//    NEXT_PUBLIC_BASE_URL are the apex, so auth cookies and OAuth callbacks
//    assume the apex host — serving pages on www would fork sessions across
//    two origins.
// 2. http:// -> https:// (308), decided ONLY from Cloudflare's `cf-visitor`
//    header (`{"scheme":"http"}`). Measured 2026-09-11: `http://grabcaramel.com/`
//    served 200 with the full page because the zone's "Always Use HTTPS" is
//    off, and Search Console already indexes the http twin. NEVER key this on
//    `x-forwarded-proto`: Next synthesises it and Traefik rewrites it to the
//    origin-side scheme, so an x-forwarded-proto fallback redirect-loops behind
//    the proxy. No cf-visitor header (direct-to-origin, local, CI) = serve.
// 3. `/foo/` -> `/foo` (308), query preserved, for every path except `/` and
//    the first-party PostHog prefix. next.config.mjs turns Next's own
//    trailing-slash redirect OFF (`skipTrailingSlashRedirect`) because
//    posthog-js POSTs to trailing-slash endpoints under that prefix; this is
//    the replacement for everything else, so no page is served at two URLs.
//    The logic is src/lib/trailingSlash.ts (pure, unit-tested).
//
// Any combination redirects ONCE, straight to the final URL. The target origin
// is the visitor's public Host on https (see redirectOrigin), never the
// container's internal http origin.
import { trailingSlashRedirectPath } from '@/lib/trailingSlash'
import { NextResponse, type NextRequest } from 'next/server'

// Cloudflare's documented shape is exactly `{"scheme":"http"}`; matched with
// a regex rather than JSON.parse so an unexpected value can never throw
// inside the edge path — an unparseable header just means "not plain http".
const CF_VISITOR_PLAIN_HTTP = /"scheme"\s*:\s*"http"/

// `x-forwarded-proto` is used ONLY to pick the scheme of a redirect target
// (see redirectOrigin), never to decide WHETHER to redirect: that is the
// http -> https rule above, which stays keyed on cf-visitor alone.
function cameThroughHttpsProxy(request: NextRequest): boolean {
    if (request.headers.has('cf-visitor')) return true
    const forwardedProto = request.headers.get('x-forwarded-proto') ?? ''
    return forwardedProto.split(',')[0]?.trim().toLowerCase() === 'https'
}

// A plausible Host value (hostname or host:port). Anything else is ignored
// rather than trusted into a Location header.
const HOST_HEADER = /^[a-z0-9.-]+(:\d{1,5})?$/i

/**
 * The origin a redirect must point at. In the standalone container behind
 * Cloudflare -> Traefik, `request.url` is the INTERNAL origin (http://, TLS
 * ends upstream, possibly another host or port), so a redirect built from it
 * would add a hop to http:// or leak the internal host. Behind the proxy
 * (cf-visitor present, or x-forwarded-proto: https) the target is the Host
 * the visitor used, www stripped, on https. With neither signal (local dev,
 * CI, direct-to-origin) it is request.url's own origin, except that a www or
 * plain-http redirect always lands on https.
 */
function redirectOrigin(
    request: NextRequest,
    args: { hostHeader: string; isWww: boolean; forceHttps: boolean },
): URL {
    const { hostHeader, isWww, forceHttps } = args
    const incoming = new URL(request.url)
    const host = hostHeader || incoming.host
    const publicHost = isWww ? host.slice('www.'.length) : host
    if (cameThroughHttpsProxy(request) || isWww || forceHttps) {
        return new URL(`https://${publicHost}`)
    }
    return new URL(incoming.origin)
}

export function middleware(request: NextRequest) {
    const rawHost = request.headers.get('host') ?? ''
    const hostHeader = HOST_HEADER.test(rawHost) ? rawHost : ''
    const isWww = hostHeader.startsWith('www.')
    const isPlainHttp = CF_VISITOR_PLAIN_HTTP.test(
        request.headers.get('cf-visitor') ?? '',
    )
    const strippedPath = trailingSlashRedirectPath(request.nextUrl.pathname)
    if (!isWww && !isPlainHttp && strippedPath === null) {
        return NextResponse.next()
    }
    // Plain URLs, not `request.nextUrl.clone()`: NextURL remembers that the
    // ORIGINAL pathname ended in "/" and re-appends it on serialization, which
    // would turn `/foo/` into a redirect to `/foo/` (a loop).
    const incoming = new URL(request.url)
    const target = new URL(
        strippedPath ?? incoming.pathname,
        redirectOrigin(request, { hostHeader, isWww, forceHttps: isPlainHttp }),
    )
    target.search = incoming.search
    return NextResponse.redirect(target, 308)
}

export const config = {
    // Skip Next internals and static assets; everything else (pages + API)
    // must redirect so no client ever operates on the www or http origin, or
    // on a trailing-slash twin of a page. (The matcher must stay a static
    // literal — Next parses it at build time — so the telemetry exemption
    // lives in trailingSlashRedirectPath, not here.)
    matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
