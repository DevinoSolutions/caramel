import { couponsSql } from '@/lib/couponsDb'
import { checkRateLimit } from '@/lib/rateLimit'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(req: NextRequest) {
    const limited = await checkRateLimit(req, 'read')
    if (limited) return limited

    const url = new URL(req.url)
    const includeSitesParam = url.searchParams.get('includeSites')
    const includeSites = includeSitesParam !== 'false'
    const rawLimit = parseInt(url.searchParams.get('sitesLimit') || '20', 10)
    const sitesLimit = Math.min(Math.max(rawLimit, 0), 100)

    try {
        const sitesPromise: Promise<Array<{ site: string }>> =
            includeSites && sitesLimit > 0
                ? couponsSql<Array<{ site: string }>>`
                      SELECT DISTINCT site FROM coupons
                      WHERE expired = FALSE AND site IS NOT NULL
                      ORDER BY site ASC
                      LIMIT ${sitesLimit}
                  `
                : Promise.resolve([])

        const typesPromise = couponsSql<Array<{ discount_type: string }>>`
            SELECT DISTINCT discount_type FROM coupons
            WHERE expired = FALSE AND discount_type IS NOT NULL
        `

        const [sitesRaw, discountTypesRaw] = await Promise.all([
            sitesPromise,
            typesPromise,
        ])

        const sites = sitesRaw
            .map(s => s.site)
            .filter(Boolean)
            .sort((a, b) => a.localeCompare(b))
        const discountTypes = Array.from(
            new Set(discountTypesRaw.map(d => d.discount_type).filter(Boolean)),
        )

        return NextResponse.json({ sites, discountTypes })
    } catch (error) {
        console.error('Failed to load coupon filter metadata:', error)
        return NextResponse.json(
            { error: 'Failed to load coupon filter metadata' },
            { status: 500 },
        )
    }
}
