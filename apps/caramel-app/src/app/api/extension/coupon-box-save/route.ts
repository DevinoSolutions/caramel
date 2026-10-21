import { handleRouteError } from '@/lib/api/handleRouteError'
import { readBodyCapped } from '@/lib/api/readBodyCapped'
import { preflight, withRoute } from '@/lib/api/withRoute'
import { insertAutoDetectedStoreConfig } from '@/lib/catalog/applyCatalogRows'
import {
    couponBoxSaveEnabled,
    couponBoxSaveRequestSchema,
    resolveSaveStoreName,
    storeConfigFromBox,
} from '@/lib/couponBoxSave'
import { hasServedStoreConfig } from '@/lib/couponsRepo'
import { NextResponse, type NextRequest } from 'next/server'

// POST /api/extension/coupon-box-save — the extension background saves a
// promo box it found and proved on a store with no config as that store's
// config (src/lib/couponBoxSave.ts has the rules). Body:
//   { host, box: { input, apply | null, toggle | null, total | null } }
// (CSS selectors only.) Answers, checked in this order:
//   404 { saved: false, reason: 'disabled' }          COUPON_BOX_SAVE_ENABLED
//                                                     off, body never read
//   413 { saved: false, reason: 'too_large' }         body over the cap
//   400 { saved: false, reason: 'invalid_selector' }  body or a selector
//                                                     outside the grammar
//   404 { saved: false, reason: 'unknown_store' }     the host is no store
//                                                     the catalog knows
//   409 { saved: false, reason: 'has_config' }        the store has a served
//                                                     config, or any row
//   200 { saved: true, store: '<store_name>' }
// withRoute answers a non-extension Origin (403) and the rate limit (429).

// A body is four short selectors and a host: 4 KiB is generous.
const MAX_BODY_BYTES = 4 * 1024

const NO_STORE = { 'Cache-Control': 'private, no-store' } as const

type SaveAnswer =
    | { saved: true; store: string }
    | {
          saved: false
          reason:
              | 'disabled'
              | 'too_large'
              | 'invalid_selector'
              | 'unknown_store'
              | 'has_config'
      }

function json(body: SaveAnswer, status: number) {
    return NextResponse.json(body, { status, headers: NO_STORE })
}

export const OPTIONS = preflight({
    cors: 'extension',
    methods: 'POST, OPTIONS',
})

export const POST = withRoute(
    {
        method: 'POST',
        routeName: 'extension/coupon-box-save',
        rateLimit: 'mutation',
        cors: 'extension',
        // Extension-only, like coupon-box-pick: the Origin must be present
        // AND a browser-extension protocol. Any HTTP client can forge it, so
        // the real defences are the rules in couponBoxSave.ts: selectors
        // only, never over an existing row, and a pipeline config always
        // replaces a saved one.
        origin: 'extension',
        // Parses its own body: the size cap must run before the JSON parse.
        body: null,
    },
    async ({ req }) => handleSave(req),
)

async function handleSave(req: NextRequest): Promise<NextResponse> {
    if (!couponBoxSaveEnabled()) {
        return json({ saved: false, reason: 'disabled' }, 404)
    }

    // Read no further than the cap, chunked bodies included.
    const body = await readBodyCapped(req, MAX_BODY_BYTES)
    if (!body.ok) return json({ saved: false, reason: 'too_large' }, 413)
    let raw: unknown
    try {
        raw = JSON.parse(body.text)
    } catch {
        return json({ saved: false, reason: 'invalid_selector' }, 400)
    }
    const parsed = couponBoxSaveRequestSchema.safeParse(raw)
    if (!parsed.success) {
        return json({ saved: false, reason: 'invalid_selector' }, 400)
    }
    const { host, box } = parsed.data

    try {
        const store = await resolveSaveStoreName(host)
        if (!store) {
            return json({ saved: false, reason: 'unknown_store' }, 404)
        }
        if (await hasServedStoreConfig(host)) {
            return json({ saved: false, reason: 'has_config' }, 409)
        }
        const { inserted } = await insertAutoDetectedStoreConfig(
            storeConfigFromBox(store, box),
        )
        if (!inserted) {
            return json({ saved: false, reason: 'has_config' }, 409)
        }
        // The cache is NOT reset here: it reaches the new row within its TTL
        // (minutes), installed extensions cache the store list for an hour
        // anyway, and a reset per accepted save would let anonymous callers
        // force one full rebuild of the list (seconds of blocked event loop)
        // per request.
        console.info('[coupon-box-save] saved an auto-detected coupon box', {
            store,
            host,
        })
        return json({ saved: true, store }, 200)
    } catch (error) {
        console.error('[coupon-box-save] save failed', error, { host })
        return handleRouteError(error, {
            req,
            // Never the error's own text: it can carry database host, driver
            // and SQL detail, and this route answers anonymous callers.
            message: 'coupon box save failed',
            status: 500,
        })
    }
}
