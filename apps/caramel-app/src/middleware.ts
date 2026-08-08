// Canonical-host redirect: www.grabcaramel.com -> grabcaramel.com (308).
//
// Until the 2026-08-08 compose cutover this redirect lived in the proxy layer
// (a traefik redirect attached to the old Dokploy application); compose-type
// services carry no proxy redirects, so the app now owns its own canonical
// host. Host-based matching is impossible in next.config redirects(), hence
// middleware. BETTER_AUTH_URL / NEXT_PUBLIC_BASE_URL are the apex, so auth
// cookies and OAuth callbacks assume the apex host — serving pages on www
// would fork sessions across two origins.
import { NextResponse, type NextRequest } from 'next/server'

export function middleware(request: NextRequest) {
    const host = request.headers.get('host') ?? ''
    if (host.startsWith('www.')) {
        const url = request.nextUrl.clone()
        url.host = host.slice('www.'.length)
        url.protocol = 'https'
        url.port = ''
        return NextResponse.redirect(url, 308)
    }
    return NextResponse.next()
}

export const config = {
    // Skip Next internals and static assets; everything else (pages + API)
    // must redirect so no client ever operates on the www origin.
    matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
