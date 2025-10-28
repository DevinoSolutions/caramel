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
    const skip = url.searchParams.get('skip') || '0'
    const limit = url.searchParams.get('limit') || '10'
    const key_words = url.searchParams.get('key_words') || undefined

    try {
        const filters: any = { expired: false }
        if (site) {
            const base = getBaseDomain(site)
            filters.AND = [
                { OR: [{ site: base }, { site: { endsWith: `.${base}` } }] },
            ]
        }
        if (key_words) {
            const keywordsArray = key_words.split(',').map(k => k.trim())
            filters.OR = keywordsArray.map(keyword => ({
                description: { contains: keyword, mode: 'insensitive' },
            }))
        }
        const coupons = await prisma.coupon.findMany({
            where: filters,
            skip: parseInt(skip, 10),
            take: parseInt(limit, 10),
            orderBy: [{ createdAt: 'desc' }],
        })
        return NextResponse.json(coupons)
    } catch (error) {
        return NextResponse.json(
            { error: 'Error fetching coupons.' },
            { status: 500 },
        )
    }
}
