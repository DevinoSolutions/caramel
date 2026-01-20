import { nextApiResponse } from '@/lib/apiResponseNext'
import prisma from '@/lib/prisma'
import { Coupon } from '@/types/coupon'
import { NextRequest } from 'next/server'
import type { Prisma } from '@prisma/client'


export async function GET(req: NextRequest) {
    try {
        const sources = await prisma.source.findMany({
            where: { status: 'ACTIVE' },
            include: { coupons: true },
        })
        const sourcesWithMetrics = sources.map((src) => {
            const totalUsed = src.coupons.reduce(
                (acc: number, c: { timesUsed: number }) => acc + c.timesUsed,
                0,
            )
            const totalFail = src.coupons.filter((c: Coupon) => c.expired).length
            const successRate =
                totalUsed + totalFail === 0
                    ? 0
                    : (totalUsed / (totalUsed + totalFail)) * 100
            return {
                id: src.id,
                source: src.source,
                websites: src.websites,
                numberOfCoupons: src.coupons.length,
                successRate: parseFloat(successRate.toFixed(2)),
                status: src.status,
            }
        })
        sourcesWithMetrics.sort(
            (a: { successRate: number }, b: { successRate: number }) => b.successRate - a.successRate)
        return nextApiResponse(req, 200, 'sources', sourcesWithMetrics)
    } catch (error) {
        return nextApiResponse(req, 500, 'Error fetching sources.', null)
    }
}

export async function POST(req: NextRequest) {
    try {
        const body = (await req.json().catch(() => ({}))) as {
            website?: string
        }
        const website = body.website?.trim()
        if (!website)
            return nextApiResponse(req, 400, 'Missing required fields.', null)
        await prisma.source.create({
            data: { source: website, status: 'REQUESTED' },
        })
        return nextApiResponse(
            req,
            200,
            'Source submission requested successfully!',
        )
    } catch (error) {
        return nextApiResponse(req, 500, 'Error creating source.', null)
    }
}
