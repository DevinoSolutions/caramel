import prisma from '@/lib/prisma'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(req: NextRequest) {
    const url = new URL(req.url)
    const id = url.searchParams.get('id')
    if (!id)
        return NextResponse.json(
            { error: 'Invalid or missing coupon ID' },
            { status: 400 },
        )
    try {
        const updatedCoupon = await prisma.coupon.update({
            where: { id },
            data: {
                timesUsed: { increment: 1 },
                last_time_used: new Date().toISOString(),
            },
        })
        return NextResponse.json(updatedCoupon)
    } catch (error) {
        return NextResponse.json(
            { error: 'Error updating coupon usage.' },
            { status: 500 },
        )
    }
}
