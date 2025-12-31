import prisma from '@/lib/prisma'
import { NextResponse } from 'next/server'

export async function GET() {
    try {
        const [total, expired] = await Promise.all([
            prisma.coupon.count(),
            prisma.coupon.count({
                where: {
                    expired: true,
                },
            }),
        ])

        return NextResponse.json({
            total,
            expired,
            active: total - expired,
        })
    } catch (error) {
        console.error('Failed to fetch coupon stats:', error)
        return NextResponse.json(
            { error: 'Failed to fetch stats' },
            { status: 500 },
        )
    }
}
