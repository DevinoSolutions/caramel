import prisma from '@/lib/prisma'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(req: NextRequest) {
    const url = new URL(req.url)
    const q = url.searchParams.get('q')?.trim() || ''
    const rawLimit = parseInt(url.searchParams.get('limit') || '20', 10)
    const limit = Math.min(Math.max(rawLimit, 1), 50)

    const filters: any = { expired: false }
    if (q) {
        filters.OR = [
            { site: { contains: q, mode: 'insensitive' } },
            { site: { startsWith: q, mode: 'insensitive' } },
        ]
    }

    try {
        const sitesRaw = await prisma.coupon.findMany({
            where: filters,
            distinct: ['site'],
            select: { site: true },
            take: limit,
            orderBy: { site: 'asc' },
        })

        const sites = sitesRaw.map(s => s.site).filter(Boolean)

        return NextResponse.json({ sites })
    } catch (error) {
        console.error('Failed to load store options:', error)
        return NextResponse.json(
            { error: 'Failed to load store options' },
            { status: 500 },
        )
    }
}
