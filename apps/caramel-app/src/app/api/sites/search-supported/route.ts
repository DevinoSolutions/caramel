import prisma from '@/lib/prisma'
import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
    let body: any = {}
    try {
        body = await req.json()
    } catch {}
    const q = String((body?.query ?? '') as string).trim()
    if (!q) return NextResponse.json({ sites: [] })
    const likePattern = `%${q}%`
    try {
        const rows = await prisma.$queryRaw<
            { site: string; sim_score: number }[]
        >`
      SELECT DISTINCT c.site,
             COALESCE(similarity(c.site, ${q}), 0) as sim_score
      FROM "Coupon" c
      WHERE c.site ILIKE ${likePattern}
         OR similarity(c.site, ${q}) > 0.25
      ORDER BY sim_score DESC, c.site ASC
    `
        const sites = rows.map(r => r.site)
        return NextResponse.json({ sites })
    } catch (err: any) {
        return NextResponse.json(
            { error: 'Search failed', details: err?.message },
            { status: 500 },
        )
    }
}
