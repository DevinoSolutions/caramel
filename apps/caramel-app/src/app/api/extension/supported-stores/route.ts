import prisma from '@/lib/prisma'
import { NextRequest, NextResponse } from 'next/server'

const EXTENSION_API_KEY = process.env.EXTENSION_API_KEY

function unauthorized() {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}

function validateApiKey(req: NextRequest): boolean {
    if (!EXTENSION_API_KEY) return false
    const header = req.headers.get('x-api-key')
    if (!header || header.length !== EXTENSION_API_KEY.length) return false
    // Constant-time comparison
    let mismatch = 0
    for (let i = 0; i < header.length; i++) {
        mismatch |= header.charCodeAt(i) ^ EXTENSION_API_KEY.charCodeAt(i)
    }
    return mismatch === 0
}

export async function GET(req: NextRequest) {
    if (!validateApiKey(req)) return unauthorized()

    try {
        const configs = await prisma.storeVerificationConfig.findMany({
            where: { isActive: true },
            select: {
                store: { select: { storeName: true } },
                showInputXpath: true,
                dismissButtonXpath: true,
                couponInputXpath: true,
                applyButtonXpath: true,
                priceContainerXpath: true,
            },
            orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
        })

        // Group by store and pick the highest-priority config per store
        const seen = new Set<string>()
        const supported: Array<Record<string, string | undefined>> = []

        for (const cfg of configs) {
            const domain = cfg.store.storeName
            if (seen.has(domain)) continue
            // Only include stores that have at least couponInput + couponSubmit
            if (!cfg.couponInputXpath || !cfg.applyButtonXpath) continue
            seen.add(domain)
            supported.push({
                domain,
                couponInput: cfg.couponInputXpath,
                couponSubmit: cfg.applyButtonXpath,
                priceContainer: cfg.priceContainerXpath ?? undefined,
                showInput: cfg.showInputXpath ?? undefined,
                dismissButton: cfg.dismissButtonXpath ?? undefined,
            })
        }

        return NextResponse.json({ supported })
    } catch (error) {
        console.error('[API][extension/supported-stores] error', error)
        return NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 },
        )
    }
}
