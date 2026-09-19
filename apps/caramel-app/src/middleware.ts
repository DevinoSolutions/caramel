// Canonical-origin redirects, owned by the app since the 2026-08-08 compose
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
//
// A www + http request redirects ONCE, straight to the https apex.
import { NextResponse, type NextRequest } from 'next/server'

// Cloudflare's documented shape is exactly `{"scheme":"http"}`; matched with
// a regex rather than JSON.parse so an unexpected value can never throw
// inside the edge path — an unparseable header just means "not plain http".
const CF_VISITOR_PLAIN_HTTP = /"scheme"\s*:\s*"http"/

export function middleware(request: NextRequest) {
    const host = request.headers.get('host') ?? ''
    const isWww = host.startsWith('www.')
    const isPlainHttp = CF_VISITOR_PLAIN_HTTP.test(
        request.headers.get('cf-visitor') ?? '',
    )
    if (!isWww && !isPlainHttp) {
        return NextResponse.next()
    }
    const url = request.nextUrl.clone()
    url.host = isWww ? host.slice('www.'.length) : host
    url.protocol = 'https'
    url.port = ''
    return NextResponse.redirect(url, 308)
}

export const config = {
    // Skip Next internals and static assets; everything else (pages + API)
    // must redirect so no client ever operates on the www or http origin.
    matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
