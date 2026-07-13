import { env } from '@/lib/env'
import { NextRequest, NextResponse } from 'next/server'

function base64Encode(str: string) {
    if (typeof Buffer !== 'undefined')
        return Buffer.from(str, 'utf-8').toString('base64')
    // Fallback for edge runtimes without Buffer
    // @ts-ignore
    return btoa(str)
}

function xorWithBase64(text: string, key: string) {
    const base64Key = base64Encode(key)
    const keyBytes = Array.from(base64Key, c => c.charCodeAt(0))
    const textBytes = Array.from(text, c => c.charCodeAt(0))
    const out: number[] = Array.from({ length: textBytes.length })
    for (let i = 0; i < textBytes.length; i++)
        out[i] = textBytes[i] ^ keyBytes[i % keyBytes.length]
    return String.fromCharCode(...out)
}

function encrypt(text: string, key: string) {
    return base64Encode(xorWithBase64(text, key))
}

function buildKeyFromHeaders(req: NextRequest) {
    // domain without port
    const host = (req.headers.get('host') || '').replace(/:\d+$/, '')
    const ua = req.headers.get('user-agent') || ''
    return host + ua
}

export function nextApiResponse(
    req: NextRequest,
    statusCode: number,
    message?: string,
    data: unknown = null,
    error: unknown = null,
) {
    const payload = {
        status: statusCode >= 400 ? 'error' : 'success',
        ...(message && { message }),
        // `data ? {data} : {}` (not `data && {data}`) — spreading a
        // possibly-`unknown` value fails tsc (TS2698 "Spread types may
        // only be created from object types"); the ternary keeps every
        // branch an object type while staying runtime-identical to the
        // old truthy-spread idiom (object spread of any falsy primitive
        // — 0, '', false, null, undefined, NaN — contributes zero
        // properties either way; pinned in apiResponseNext.test.ts).
        ...(data ? { data } : {}),
        ...(error ? { error } : {}),
    }

    if (env.API_ENCRYPTION_ENABLED !== 'true') {
        return NextResponse.json(payload, { status: statusCode })
    }

    const key = buildKeyFromHeaders(req)
    const encrypted = encrypt(JSON.stringify(payload), key)
    return NextResponse.json({ response: encrypted }, { status: statusCode })
}
