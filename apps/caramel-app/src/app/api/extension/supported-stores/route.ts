import { couponsSql } from '@/lib/couponsDb'
import { NextRequest, NextResponse } from 'next/server'

const EXTENSION_API_KEY = process.env.EXTENSION_API_KEY

function unauthorized() {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}

function validateApiKey(req: NextRequest): boolean {
    if (!EXTENSION_API_KEY) return false
    const header = req.headers.get('x-api-key')
    if (!header || header.length !== EXTENSION_API_KEY.length) return false
    // Constant-time comparison to avoid timing-based key probing
    let mismatch = 0
    for (let i = 0; i < header.length; i++) {
        mismatch |= header.charCodeAt(i) ^ EXTENSION_API_KEY.charCodeAt(i)
    }
    return mismatch === 0
}

type Row = {
    store_name: string
    show_input_xpath: string | null
    dismiss_button_xpath: string | null
    coupon_input_xpath: string | null
    apply_button_xpath: string | null
    price_container_xpath: string | null
}

export async function GET(req: NextRequest) {
    if (!validateApiKey(req)) return unauthorized()

    try {
        // One row per store, highest-priority active config that has xpath
        // selectors (excludes API-only configs which the extension can't use).
        const rows = (await couponsSql`
            SELECT DISTINCT ON (s.store_name)
                s.store_name,
                cfg.show_input_xpath,
                cfg.dismiss_button_xpath,
                cfg.coupon_input_xpath,
                cfg.apply_button_xpath,
                cfg.price_container_xpath
            FROM store_verification_configs cfg
            JOIN verification_stores s ON s.id = cfg.store_id
            WHERE cfg.is_active = TRUE
              AND cfg.coupon_input_xpath IS NOT NULL
              AND cfg.apply_button_xpath IS NOT NULL
            ORDER BY s.store_name, cfg.priority DESC, cfg.updated_at DESC
        `) as Row[]

        const supported = rows.map(r => ({
            domain: r.store_name,
            couponInput: r.coupon_input_xpath,
            couponSubmit: r.apply_button_xpath,
            priceContainer: r.price_container_xpath ?? undefined,
            showInput: r.show_input_xpath ?? undefined,
            dismissButton: r.dismiss_button_xpath ?? undefined,
        }))

        return NextResponse.json(
            { supported },
            {
                headers: {
                    'Cache-Control':
                        'public, s-maxage=300, stale-while-revalidate=300',
                },
            },
        )
    } catch (error) {
        console.error('[API][extension/supported-stores] error', error)
        return NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 },
        )
    }
}
