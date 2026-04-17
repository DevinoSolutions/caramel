import { classifyCart, type CartSignals } from '@/lib/cartClassifier'
import { OpenRouterError } from '@/lib/openrouter'
import {
    checkRateLimit,
    forbiddenOrigin,
    isOriginAllowed,
} from '@/lib/rateLimit'
import { NextRequest, NextResponse } from 'next/server'

// Cap payload size to protect the route from noisy senders.
const MAX_BODY_BYTES = 8 * 1024

function sanitize(body: unknown): CartSignals | null {
    if (!body || typeof body !== 'object') return null
    const b = body as Record<string, unknown>
    const domain =
        typeof b.domain === 'string' ? b.domain.trim().toLowerCase() : ''
    if (!domain || !/^[a-z0-9.-]{3,120}$/.test(domain)) return null

    const str = (v: unknown, max: number) =>
        typeof v === 'string' ? v.slice(0, max) : undefined
    const arr = (v: unknown, maxN: number, maxLen: number) =>
        Array.isArray(v)
            ? v
                  .filter(x => typeof x === 'string')
                  .map(x => (x as string).slice(0, maxLen))
                  .slice(0, maxN)
            : undefined

    return {
        domain,
        url_path: str(b.url_path, 200),
        title: str(b.title, 200),
        meta_description: str(b.meta_description, 400),
        og_site_name: str(b.og_site_name, 80),
        og_type: str(b.og_type, 40),
        cart_items: arr(b.cart_items, 6, 160),
        platform_hints:
            b.platform_hints && typeof b.platform_hints === 'object'
                ? (Object.fromEntries(
                      (
                          Object.entries(
                              b.platform_hints as Record<string, unknown>,
                          ).filter(([, v]) => typeof v === 'boolean') as [
                              string,
                              boolean,
                          ][]
                      ).slice(0, 10),
                  ) as Record<string, boolean>)
                : undefined,
    }
}

export async function POST(req: NextRequest) {
    if (!isOriginAllowed(req)) return forbiddenOrigin()
    const limited = await checkRateLimit(req, 'mutation')
    if (limited) return limited

    const contentLength = Number(req.headers.get('content-length') || 0)
    if (contentLength > MAX_BODY_BYTES) {
        return NextResponse.json(
            { error: 'payload too large' },
            { status: 413 },
        )
    }

    const raw = await req.json().catch(() => null)
    const signals = sanitize(raw)
    if (!signals) {
        return NextResponse.json({ error: 'invalid payload' }, { status: 400 })
    }

    try {
        const result = await classifyCart(signals)
        return NextResponse.json(result, {
            headers: {
                'Cache-Control': 'private, no-store',
            },
        })
    } catch (error) {
        const status = error instanceof OpenRouterError ? 502 : 500
        console.error('[classify-cart] failed', error)
        return NextResponse.json(
            {
                error:
                    error instanceof Error
                        ? error.message
                        : 'classification failed',
            },
            { status },
        )
    }
}
