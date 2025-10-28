import prisma from '@/lib/prisma'
import { NextResponse } from 'next/server'

export async function GET() {
    try {
        const topSites = await prisma.coupon.groupBy({
            by: ['site'],
            _count: { id: true },
            orderBy: { _count: { id: 'desc' } },
            take: 4,
        })
        const sites = topSites.map(i => i.site)
        return NextResponse.json({ sites })
    } catch (err) {
        return NextResponse.json(
            { error: 'Failed to fetch top sites' },
            { status: 500 },
        )
    }
}
