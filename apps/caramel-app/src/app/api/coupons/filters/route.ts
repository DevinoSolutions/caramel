import prisma from '@/lib/prisma'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(req: NextRequest) {
    const url = new URL(req.url)
    const includeSitesParam = url.searchParams.get('includeSites')
    const includeSites = includeSitesParam !== 'false'
    const rawLimit = parseInt(url.searchParams.get('sitesLimit') || '20', 10)
    const sitesLimit = Math.min(Math.max(rawLimit, 0), 100)

    try {
        const queries: Promise<any>[] = []

        if (includeSites && sitesLimit > 0) {
            queries.push(
                prisma.coupon.findMany({
                    where: { expired: false },
                    distinct: ['site'],
                    select: { site: true },
                    orderBy: { site: 'asc' },
                    take: sitesLimit,
                }),
            )
        } else {
            queries.push(Promise.resolve([]))
        }

        queries.push(
            prisma.coupon.findMany({
                where: { expired: false },
                distinct: ['discount_type'],
                select: { discount_type: true },
            }),
        )

        const [sitesRaw, discountTypesRaw] = await Promise.all(queries)

        const sites = sitesRaw
            .map((s: any) => s.site)
            .filter(Boolean)
            .sort((a: string, b: string) => a.localeCompare(b))
        const discountTypes = Array.from(
            new Set(
                discountTypesRaw
                    .map((d: any) => d.discount_type)
                    .filter(Boolean),
            ),
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
