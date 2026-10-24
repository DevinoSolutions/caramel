import { handleRouteError } from '@/lib/api/handleRouteError'
import { readBodyCapped } from '@/lib/api/readBodyCapped'
import { preflight, withRoute } from '@/lib/api/withRoute'
import { couponBoxDomainSchema } from '@/lib/couponBoxPick'
import {
    couponBoxSaveEnabled,
    couponBoxSaveRequestSchema,
    recordBoxProposal,
    resolveSaveStoreName,
    type BoxBudgetScope,
} from '@/lib/couponBoxSave'
import { hasServedStoreConfig } from '@/lib/couponsRepo'
import * as Sentry from '@sentry/nextjs'
import { NextResponse, type NextRequest } from 'next/server'

// POST /api/extension/coupon-box-save — the extension background proposes a
// promo box it found and proved on a store with no config as that store's
// config (src/lib/couponBoxSave.ts has the rules). Signed-in installs only
// (bearer); a proposal is served only once enough distinct users proposed the
// same box (T-6221). Body:
//   { host, box: { input, apply | null, toggle | null, total | null } }
// (CSS selectors only.) Answers, checked in this order:
//   401 { error: 'Unauthorized' }                     no signed-in session
//                                                     (withRoute, before all)
//   404 { saved: false, reason: 'disabled' }          COUPON_BOX_SAVE_ENABLED
//                                                     off, body never read
//   413 { saved: false, reason: 'too_large' }         body over the cap
//   400 { saved: false, reason: 'invalid_selector' }  body or a selector
//                                                     outside the grammar
//   404 { saved: false, reason: 'unknown_store' }     the host is no store
//                                                     the catalog knows
//   409 { saved: false, reason: 'has_config' }        the store has a served
//                                                     config, or any row
//   429 { saved: false, reason: 'user_budget' | 'store_budget' |
//                              'global_budget' }      a 24-hour write cap
//   200 { saved: true, store, status: 'pending' }     recorded, NOT served yet
//   200 { saved: true, store, status: 'published' }   corroborated and served
// withRoute answers a non-extension Origin (403) and the rate limit (429).

// A body is four short selectors and a host: 4 KiB is generous.
const MAX_BODY_BYTES = 4 * 1024

const NO_STORE = { 'Cache-Control': 'private, no-store' } as const

type SaveAnswer =
    | { saved: true; store: string; status: 'pending' | 'published' }
    | {
          saved: false
          reason:
              | 'disabled'
              | 'too_large'
              | 'invalid_selector'
              | 'unknown_store'
              | 'has_config'
              | BudgetReason
      }

type BudgetReason = `${BoxBudgetScope}_budget`

// How often real boxes are refused is worth seeing (the selector gates are
// strict on purpose, T-6221), without a message per request: ONE Sentry
// message per hour per process, with the host only, never a selector value.
const REFUSAL_REPORT_INTERVAL_MS = 60 * 60 * 1000
let nextRefusalReportAt = 0

function reportInvalidSelector(raw: unknown): void {
    const now = Date.now()
    if (now < nextRefusalReportAt) return
    nextRefusalReportAt = now + REFUSAL_REPORT_INTERVAL_MS
    const rawHost =
        typeof raw === 'object' && raw !== null && 'host' in raw
            ? raw.host
            : undefined
    const host = couponBoxDomainSchema.safeParse(rawHost)
    Sentry.captureMessage('coupon-box-save refused a save: invalid_selector', {
        level: 'info',
        tags: {
            route: 'extension/coupon-box-save',
            reason: 'invalid_selector',
        },
        extra: { host: host.success ? host.data : null },
    })
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
        // Origin is only a filter. The gate is the session: better-auth's
        // bearer plugin resolves the extension's token (cookie sessions work
        // too), no session is 401. Behind it, the rules in couponBoxSave.ts:
        // selectors only, a submit-control denylist, a corroboration quorum
        // before anything is served, a write budget, never over an existing
        // row, and a pipeline config always replaces a saved one.
        origin: 'extension',
        auth: 'session',
        // Parses its own body: the size cap must run before the JSON parse.
        body: null,
    },
    async ({ req, session }) => {
        // withRoute 401s a missing session before this runs; the check is for
        // the type, and fails loudly rather than saving for nobody.
        const userId = session?.user?.id
        if (!userId) throw new Error('coupon-box-save: session without a user')
        return handleSave(req, userId)
    },
)

async function handleSave(
    req: NextRequest,
    userId: string,
): Promise<NextResponse> {
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
        reportInvalidSelector(null)
        return json({ saved: false, reason: 'invalid_selector' }, 400)
    }
    const parsed = couponBoxSaveRequestSchema.safeParse(raw)
    if (!parsed.success) {
        reportInvalidSelector(raw)
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
        const outcome = await recordBoxProposal({
            storeName: store,
            host,
            box,
            userId,
        })
        if (outcome.kind === 'over_budget') {
            return json(
                { saved: false, reason: `${outcome.scope}_budget` },
                429,
            )
        }
        if (outcome.kind === 'has_config') {
            return json({ saved: false, reason: 'has_config' }, 409)
        }
        // The cache is NOT reset here: it reaches the new row within its TTL
        // (minutes), installed extensions cache the store list for an hour
        // anyway, and a reset per accepted save would let callers force one
        // full rebuild of the list (seconds of blocked event loop) per
        // request.
        console.info('[coupon-box-save] recorded a coupon box proposal', {
            store,
            host,
            status: outcome.kind,
        })
        return json({ saved: true, store, status: outcome.kind }, 200)
    } catch (error) {
        console.error('[coupon-box-save] save failed', error, { host })
        return handleRouteError(error, {
            req,
            // Never the error's own text: it can carry database host, driver
            // and SQL detail.
            message: 'coupon box save failed',
            status: 500,
        })
    }
}
