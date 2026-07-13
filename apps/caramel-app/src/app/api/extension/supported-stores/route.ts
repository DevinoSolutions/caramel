import { handleRouteError } from '@/lib/api/handleRouteError'
import { withRoute } from '@/lib/api/withRoute'
import { listSupportedStoreConfigs } from '@/lib/couponsRepo'
import { NextResponse } from 'next/server'

// Public read: the payload is xpath selectors already shipped to every
// extension install (background.js), so gating it behind a key has no
// secrecy value (F-003). Rate-limited like any other public read route. A
// stale x-api-key header from a pre-F-003 extension build is simply
// ignored — no cutover required, see PLAN-F-003.md §Breaking. KEYLESS by
// design post-F-003 — CR-8: no apiKey concern on this route.
export const GET = withRoute(
    {
        method: 'GET',
        routeName: 'extension/supported-stores',
        rateLimit: 'read',
    },
    async ({ req }) => {
        try {
            // One row per store, highest-priority active config that has xpath
            // selectors (excludes API-only configs which the extension can't use).
            const rows = await listSupportedStoreConfigs()

            const supported = rows.map(r => ({
                domain: r.store_name,
                couponInput: r.coupon_input_xpath,
                couponSubmit: r.apply_button_xpath,
                priceContainer: r.price_container_xpath ?? undefined,
                showInput: r.show_input_xpath ?? undefined,
                dismissButton: r.dismiss_button_xpath ?? undefined,
                successIndicator: r.success_indicator_xpath ?? undefined,
                errorIndicator: r.error_indicator_xpath ?? undefined,
                couponRemove: r.coupon_remove_xpath ?? undefined,
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
            return handleRouteError(error, {
                req,
                message: 'Internal server error',
            })
        }
    },
)
