import { couponsSql } from '@/lib/couponsDb'
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
    const keyWords = url.searchParams.get('key_words') || undefined

    try {
        const conditions = [couponsSql`expired = FALSE`]

        if (site) {
            const base = getBaseDomain(site)
            conditions.push(
                couponsSql`(site = ${base} OR site LIKE ${'%.' + base})`,
            )
        }

        if (search) {
            const s = `%${search}%`
            conditions.push(
                couponsSql`(site ILIKE ${s} OR title ILIKE ${s} OR description ILIKE ${s} OR code ILIKE ${s})`,
            )
        }

        if (keyWords) {
            const patterns = keyWords
                .split(',')
                .map(k => `%${k.trim()}%`)
                .filter(k => k.length > 2)
            if (patterns.length > 0) {
                conditions.push(couponsSql`description ILIKE ANY(${patterns})`)
            }
        }

        if (type && type !== 'all') {
            conditions.push(couponsSql`discount_type = ${type}`)
        }

        const whereClause = conditions.reduce(
            (acc, cond) => couponsSql`${acc} AND ${cond}`,
        )

        const skip = Math.max(0, (page - 1) * limit)

        const [coupons, totalRow] = await Promise.all([
            couponsSql`
                SELECT id, code, site, title, description, rating,
                       discount_type, discount_amount, expiry, expired,
                       times_used AS "timesUsed"
                FROM coupons
                WHERE ${whereClause}
                ORDER BY rating DESC, created_at DESC
                LIMIT ${limit} OFFSET ${skip}
            `,
            couponsSql`SELECT COUNT(*)::int AS total FROM coupons WHERE ${whereClause}`,
        ])

        const total = (totalRow[0] as { total: number } | undefined)?.total ?? 0
        const hasMore = skip + coupons.length < total

        return NextResponse.json({ coupons, page, limit, total, hasMore })
    } catch (error) {
        console.error('Error fetching coupons:', error)
        return NextResponse.json(
            { error: 'Error fetching coupons.' },
            { status: 500 },
        )
    }
}
