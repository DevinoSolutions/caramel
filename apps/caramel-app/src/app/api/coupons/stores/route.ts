import { couponsSql } from '@/lib/couponsDb'
import { checkRateLimit } from '@/lib/rateLimit'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(req: NextRequest) {
    const limited = await checkRateLimit(req, 'read')
    if (limited) return limited

    const url = new URL(req.url)
    const q = url.searchParams.get('q')?.trim() || ''
    const rawLimit = parseInt(url.searchParams.get('limit') || '20', 10)
    const limit = Math.min(Math.max(rawLimit, 1), 50)

    try {
        const rows = q
            ? await couponsSql<Array<{ site: string }>>`
                  SELECT DISTINCT site FROM coupons
                  WHERE expired = FALSE
                    AND (site ILIKE ${'%' + q + '%'} OR site ILIKE ${q + '%'})
                  ORDER BY site ASC
                  LIMIT ${limit}
              `
            : await couponsSql<Array<{ site: string }>>`
                  SELECT DISTINCT site FROM coupons
                  WHERE expired = FALSE
                  ORDER BY site ASC
                  LIMIT ${limit}
              `

        const sites = rows.map(s => s.site).filter(Boolean)

        return NextResponse.json(
            { sites },
            {
                headers: {
                    'Cache-Control':
                        'public, s-maxage=120, stale-while-revalidate=120',
                },
            },
        )
    } catch (error) {
        console.error('Failed to load store options:', error)
        return NextResponse.json(
            { error: 'Failed to load store options' },
            { status: 500 },
        )
    }
}
