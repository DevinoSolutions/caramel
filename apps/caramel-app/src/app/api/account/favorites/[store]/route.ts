import {
    addFavoriteStore,
    normalizeFavoriteStoreKey,
    removeFavoriteStore,
} from '@/lib/account/favoriteStores'
import { withRoute } from '@/lib/api/withRoute'
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

// PUT /api/account/favorites/:store   — follow a store   (idempotent upsert)
// DELETE /api/account/favorites/:store — unfollow a store (idempotent delete)
//
// PUT/DELETE rather than POST/POST because both are genuinely idempotent: the
// star is a toggle two surfaces can fire (the extension popup header and the
// /coupons/[store] page), the web page removes optimistically with an undo, and
// none of that may depend on how many times a request actually landed. A repeat
// PUT is 200, a repeat DELETE is 200 — never a 404 the caller has to special-case.
//
// The store key travels in the PATH, so both methods carry no body and the
// response always echoes the NORMALIZED key the server actually wrote, which is
// what a client should store (see favoriteStores.ts's vocabulary header — the
// popup sends the tab's hostname and gets back the registrable domain).
//
// Same route-config idiom as extension/me + coupons/[id]/report: session-gated,
// origin-gated, mutation-rate-limited, no CORS/OPTIONS (host_permissions fetch).
const routeConfig = {
    routeName: 'account/favorites/store',
    rateLimit: 'mutation',
    origin: true,
    auth: 'session',
} as const

function invalidStore(): NextResponse {
    return NextResponse.json({ error: 'Invalid store' }, { status: 422 })
}

/**
 * The `:store` path segment, normalized to a real store key — or null when the
 * segment names no store.
 *
 * withRoute deliberately does not thread Next's dynamic `params` to handlers (a
 * path param is route-specific data, not a cross-cutting concern), so the
 * segment is read off the URL exactly as coupons/[id]/report reads its id: the
 * LAST segment of `/api/account/favorites/<store>`. It arrives
 * percent-encoded from every caller (`encodeURIComponent`), so it is decoded
 * before normalization — a raw `decodeURIComponent` throws on a malformed
 * escape, which would otherwise become a 500 for what is plainly a 422.
 */
function storeKeyFromUrl(req: NextRequest): string | null {
    const segments = new URL(req.url).pathname.split('/')
    const raw = segments[segments.length - 1] ?? ''
    if (!raw) return null
    let decoded: string
    try {
        decoded = decodeURIComponent(raw)
    } catch {
        return null
    }
    return normalizeFavoriteStoreKey(decoded)
}

export const PUT = withRoute(
    { ...routeConfig, method: 'PUT' },
    async ({ req, session }) => {
        if (!session?.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }
        const store = storeKeyFromUrl(req)
        if (!store) return invalidStore()

        await addFavoriteStore(session.user.id, store)
        return NextResponse.json({ ok: true, store, favorited: true })
    },
)

export const DELETE = withRoute(
    { ...routeConfig, method: 'DELETE' },
    async ({ req, session }) => {
        if (!session?.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }
        const store = storeKeyFromUrl(req)
        if (!store) return invalidStore()

        await removeFavoriteStore(session.user.id, store)
        return NextResponse.json({ ok: true, store, favorited: false })
    },
)
