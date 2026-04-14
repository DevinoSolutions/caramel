import { couponsSql } from '@/lib/couponsDb'
import { checkRateLimit } from '@/lib/rateLimit'
import { NextRequest, NextResponse } from 'next/server'

function getBaseDomain(raw: string): string | null {
    let hostname = raw
    try {
        const u = new URL(raw.startsWith('http') ? raw : `https://${raw}`)
        hostname = u.hostname
    } catch {
        return null
    }
    // Hostnames must be ASCII letters, digits, dots, and hyphens only
    if (!/^[a-z0-9.-]+$/i.test(hostname)) return null
    const parts = hostname.split('.')
    return parts.length > 2 ? parts.slice(-2).join('.') : hostname
}

export async function GET(req: NextRequest) {
    const limited = await checkRateLimit(req, 'read')
    if (limited) return limited

    const url = new URL(req.url)
    const site = url.searchParams.get('site') || undefined
    const rawPage = parseInt(url.searchParams.get('page') || '1', 10)
    const rawLimit = parseInt(url.searchParams.get('limit') || '10', 10)
    // Cap page at 500 so scrapers can't walk the catalog indefinitely
    // with `page=999999`. Real users never paginate that far.
    const page =
        Number.isFinite(rawPage) && rawPage > 0 ? Math.min(rawPage, 500) : 1
    const limit =
        Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 50) : 10
    // Cap search + keyword params to keep ILIKE patterns cheap.
    const search =
        (url.searchParams.get('search') || '').slice(0, 100) || undefined
    const type = url.searchParams.get('type') || undefined
    const keyWords =
        (url.searchParams.get('key_words') || '').slice(0, 200) || undefined

    try {
        const conditions = [couponsSql`expired = FALSE`]

        if (site) {
            const base = getBaseDomain(site)
            if (!base) {
                return NextResponse.json(
                    { error: 'Invalid site parameter' },
                    { status: 400 },
                )
            }
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

        // 60s edge cache with a 60s grace window. Coupons change on a
        // scrape cycle (minutes-hours), so 60s staleness is invisible
        // to users and offloads almost all scraping traffic to CDN.
        return NextResponse.json(
            { coupons, page, limit, total, hasMore },
            {
                headers: {
                    'Cache-Control':
                        'public, s-maxage=60, stale-while-revalidate=60',
                },
            },
        )
    } catch (error) {
        console.error('Error fetching coupons:', error)
        return NextResponse.json(
            { error: 'Error fetching coupons.' },
            { status: 500 },
        )
    }
}
