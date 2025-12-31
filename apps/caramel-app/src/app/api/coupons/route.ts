import prisma from '@/lib/prisma'
import { NextRequest, NextResponse } from 'next/server'

function getBaseDomain(raw: string): string {
    let hostname = raw
    try {
        const u = new URL(raw.startsWith('http') ? raw : `https://${raw}`)
        hostname = u.hostname
    } catch {
        throw new Error('Could not find base domain')
    }
    const parts = hostname.split('.')
    return parts.length > 2 ? parts.slice(-2).join('.') : hostname
}

export async function GET(req: NextRequest) {
    const url = new URL(req.url)
    const site = url.searchParams.get('site') || undefined
    const rawPage = parseInt(url.searchParams.get('page') || '1', 10)
    const rawLimit = parseInt(url.searchParams.get('limit') || '10', 10)
    const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1
    const limit =
        Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 50) : 10
    const search = url.searchParams.get('search') || undefined
    const type = url.searchParams.get('type') || undefined
    const key_words = url.searchParams.get('key_words') || undefined

    try {
        const filters: any = { expired: false }

        // Site filter
        if (site) {
            const base = getBaseDomain(site)
            filters.AND = [
                { OR: [{ site: base }, { site: { endsWith: `.${base}` } }] },
            ]
        }

        // Search filter (searches across site, title, description)
        if (search) {
            filters.OR = [
                { site: { contains: search, mode: 'insensitive' } },
                { title: { contains: search, mode: 'insensitive' } },
                { description: { contains: search, mode: 'insensitive' } },
                { code: { contains: search, mode: 'insensitive' } },
            ]
        }

        // Keywords filter
        if (key_words) {
            const keywordsArray = key_words.split(',').map(k => k.trim())
            if (!filters.OR) {
                filters.OR = []
            }
            filters.OR.push(
                ...keywordsArray.map(keyword => ({
                    description: { contains: keyword, mode: 'insensitive' },
                })),
            )
        }

        // Discount type filter
        if (type && type !== 'all') {
            filters.discount_type = type
        }

        const skip = Math.max(0, (page - 1) * limit)

        console.info('[API][coupons] request', {
            page,
            limit,
            skip,
            site,
            search,
            type,
            key_words,
        })

        const [coupons, total] = await prisma.$transaction([
            prisma.coupon.findMany({
                where: filters,
                skip,
                take: limit,
                orderBy: [{ rating: 'desc' }, { createdAt: 'desc' }],
                select: {
                    id: true,
                    code: true,
                    site: true,
                    title: true,
                    description: true,
                    rating: true,
                    discount_type: true,
                    discount_amount: true,
                    expiry: true,
                    expired: true,
                    timesUsed: true,
                },
            }),
            prisma.coupon.count({ where: filters }),
        ])

        const hasMore = skip + coupons.length < total

        console.info('[API][coupons] response', {
            returned: coupons.length,
            total,
            hasMore,
            page,
            limit,
        })

        return NextResponse.json({ coupons, page, limit, total, hasMore })
    } catch (error) {
        console.error('Error fetching coupons:', error)
        return NextResponse.json(
            { error: 'Error fetching coupons.' },
            { status: 500 },
        )
    }
}
