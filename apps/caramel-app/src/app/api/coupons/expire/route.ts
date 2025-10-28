import prisma from '@/lib/prisma'
import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
    const { ids = [] } = (await req.json().catch(() => ({}))) as {
        ids?: string[]
    }
    try {
        const updated = await prisma.coupon.updateMany({
            where: { id: { in: ids } },
            data: { expired: true, expiry: new Date().toISOString() },
        })
        return NextResponse.json({ count: updated.count })
    } catch (error) {
        return NextResponse.json(
            { error: 'Error marking coupons as expired.' },
            { status: 500 },
        )
    }
}
