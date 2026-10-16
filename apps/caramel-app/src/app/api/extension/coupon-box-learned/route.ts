import { handleRouteError } from '@/lib/api/handleRouteError'
import { preflight, withRoute } from '@/lib/api/withRoute'
import {
    couponBoxLearnedEnabled,
    handOverLearnedStore,
    hashInstallId,
    hashNetwork,
    learnedBoxReportSchema,
    recordLearnedBoxReport,
} from '@/lib/couponBoxLearned'
import { hasServedStoreConfig } from '@/lib/couponsRepo'
import { getClientIp } from '@/lib/rateLimit'
import * as Sentry from '@sentry/nextjs'
import { NextResponse, type NextRequest } from 'next/server'

// POST /api/extension/coupon-box-learned — the extension reports a coupon box
// it found itself on a store with no served config: `confirmed` once it typed
// a code there and the store answered, `failed` when a box it was pointed at
// did not work. Enough independent confirmations make the box servable by
// POST /api/extension/coupon-box-pick (src/lib/couponBoxLearned.ts has the
// rules and the privacy line).
//
// Answers (every one a 200 the extension can ignore, except refusals):
//   { recorded: true }
//   { recorded: false, reason: 'disabled' }       feature off, body never read
//   { recorded: false, reason: 'served_config' }  the store has a config
//   { recorded: false, reason: 'unknown_box' }    a failure for a box nobody
//                                                 confirmed: nothing to count
//   { recorded: false, reason: 'ignored' }        a cap refused it (new
//                                                 reporters per network, per
//                                                 box, boxes per store)
//   400 invalid · 413 too large · 403 non-extension Origin · 429 rate limit

// A report is four short selectors and a few enums: 4 KiB is generous.
const MAX_BODY_BYTES = 4 * 1024

const NO_STORE = { 'Cache-Control': 'private, no-store' } as const

type LearnedAnswer =
    | { recorded: true }
    | {
          recorded: false
          reason: 'disabled' | 'served_config' | 'unknown_box' | 'ignored'
      }

function json(body: LearnedAnswer | { error: string }, status = 200) {
    return NextResponse.json(body, { status, headers: NO_STORE })
}

export const OPTIONS = preflight({
    cors: 'extension',
    methods: 'POST, OPTIONS',
})

export const POST = withRoute(
    {
        method: 'POST',
        routeName: 'extension/coupon-box-learned',
        rateLimit: 'mutation',
        cors: 'extension',
        // Extension-only, like coupon-box-pick: the Origin must be present
        // AND a browser-extension protocol. Any HTTP client can forge it, so
        // the real defence is the serving rule (several installs on several
        // networks, couponBoxLearned.ts), not this gate.
        origin: 'extension',
        // Parses its own body: the size cap must run before the JSON parse.
        body: null,
    },
    async ({ req }) => handleReport(req),
)

async function handleReport(req: NextRequest): Promise<NextResponse> {
    if (!couponBoxLearnedEnabled()) {
        return json({ recorded: false, reason: 'disabled' })
    }

    const contentLength = Number(req.headers.get('content-length') || 0)
    if (contentLength > MAX_BODY_BYTES) {
        return json({ error: 'payload too large' }, 413)
    }
    // A chunked body carries no Content-Length: measure what arrived.
    const text = await req.text()
    if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
        return json({ error: 'payload too large' }, 413)
    }
    let raw: unknown
    try {
        raw = JSON.parse(text)
    } catch {
        return json({ error: 'invalid payload' }, 400)
    }
    const parsed = learnedBoxReportSchema.safeParse(raw)
    if (!parsed.success) {
        return json({ error: 'invalid payload' }, 400)
    }
    const report = parsed.data

    try {
        // A store with a served config never reads or writes learned boxes.
        if (await hasServedStoreConfig(report.domain)) {
            return json({ recorded: false, reason: 'served_config' })
        }
        const result = await recordLearnedBoxReport({
            report,
            installHash: hashInstallId(report.installId, report.domain),
            networkHash: hashNetwork(getClientIp(req), report.domain),
        })
        if (!result.recorded) {
            return json({ recorded: false, reason: result.reason })
        }
        // Once per store ever and capped per day (handOverLearnedStore), so
        // asking on every servable report also retries one refused by the cap.
        if (result.servable) await feedStorePipeline(report.domain)
        return json({ recorded: true })
    } catch (error) {
        console.error('[coupon-box-learned] report failed', error, {
            domain: report.domain,
        })
        return handleRouteError(error, {
            req,
            message:
                error instanceof Error
                    ? error.message
                    : 'learned coupon box report failed',
            status: 500,
        })
    }
}

/** The box is servable: hand the store to the coupons pipeline
 * (couponBoxLearned.handOverLearnedStore). Its failure is reported, never
 * allowed to undo or fail the report that is already committed. */
async function feedStorePipeline(domain: string): Promise<void> {
    try {
        const result = await handOverLearnedStore(domain)
        if (result.created) {
            console.info('[coupon-box-learned] store handed to the pipeline', {
                domain,
            })
        } else if (result.reason === 'daily_cap') {
            console.warn(
                '[coupon-box-learned] pipeline hand-over deferred: daily cap reached',
                { domain },
            )
        }
    } catch (error) {
        console.error(
            '[coupon-box-learned] could not record the store for the pipeline',
            error,
            { domain },
        )
        Sentry.captureException(error, {
            tags: {
                surface: 'coupon-box-learned',
                operation: 'auto_detect_suggestion',
            },
            extra: { domain },
        })
    }
}
