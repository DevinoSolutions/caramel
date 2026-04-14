import { couponsSql } from '@/lib/couponsDb'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(req: NextRequest) {
    const url = new URL(req.url)
    const id = url.searchParams.get('id')
    if (!id) {
        return NextResponse.json(
            { error: 'Invalid or missing coupon ID' },
            { status: 400 },
        )
    }

    try {
        const rows = await couponsSql`
            UPDATE coupons
            SET times_used = times_used + 1,
                last_time_used = NOW(),
                updated_at = NOW()
            WHERE id = ${id}
            RETURNING id, code, site,
                      times_used AS "timesUsed",
                      last_time_used AS "last_time_used"
        `
        if (rows.length === 0) {
            return NextResponse.json(
                { error: 'Coupon not found' },
                { status: 404 },
            )
        }
        return NextResponse.json(rows[0])
    } catch (error) {
        console.error('Error incrementing coupon usage:', error)
        return NextResponse.json(
            { error: 'Error updating coupon usage.' },
            { status: 500 },
        )
    }
}
