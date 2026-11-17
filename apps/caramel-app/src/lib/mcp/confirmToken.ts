// src/lib/mcp/confirmToken.ts
//
// Two-step confirmation for destructive MCP calls (fleet MCP contract
// section 5). The first call (no confirmToken) is refused with
// CONFIRMATION_REQUIRED and next.args = the same arguments plus a token. The
// token is an HMAC over (user | AI client | tool | the exact arguments | expiry
// | nonce), so it confirms that one call and nothing else; it lives 10 minutes
// and is single use: spending it inserts its nonce into mcp_confirm_nonces,
// whose primary key refuses a second spend.
//
// The HMAC key is derived from BETTER_AUTH_SECRET (authSecret()) under its own
// label, so it can never collide with a better-auth signature.
import { authSecret } from '@/lib/authSecret'
import { McpDenialError } from '@/lib/mcp/denial'
import prisma from '@/lib/prisma'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const CONFIRM_TOKEN_TTL_MS = 10 * 60_000

export type ConfirmBinding = {
    userId: string
    clientId: string
    tool: string
    /** The call's arguments WITHOUT confirmToken. */
    args: Record<string, unknown>
}

export type NonceStore = {
    /** True when the nonce was unspent and is now spent. */
    claim: (nonce: string, expiresAt: Date) => Promise<boolean>
}

let lastSweepAt = 0
async function sweepExpiredNonces(now: number): Promise<void> {
    if (now - lastSweepAt < 60_000) return
    lastSweepAt = now
    await prisma.mcpConfirmNonce.deleteMany({
        where: { expiresAt: { lt: new Date(now) } },
    })
}

export const prismaNonceStore: NonceStore = {
    async claim(nonce, expiresAt) {
        await sweepExpiredNonces(Date.now())
        try {
            await prisma.mcpConfirmNonce.create({ data: { nonce, expiresAt } })
            return true
        } catch (error) {
            if ((error as { code?: unknown }).code === 'P2002') return false
            throw error
        }
    },
}

function confirmSecret(): string {
    return createHmac('sha256', authSecret())
        .update('caramel-mcp-confirm-v1')
        .digest('hex')
}

/** JSON with sorted keys and undefined dropped: one spelling per value. */
export function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value ?? null)
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
        .filter(key => record[key] !== undefined)
        .sort()
        .map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
        .join(',')}}`
}

function signature(b: ConfirmBinding, exp: number, nonce: string): string {
    return createHmac('sha256', confirmSecret())
        .update(
            [
                b.userId,
                b.clientId,
                b.tool,
                stableStringify(b.args),
                exp,
                nonce,
            ].join('|'),
        )
        .digest('hex')
}

export function issueConfirmToken(
    b: ConfirmBinding,
    now: number = Date.now(),
): string {
    const nonce = randomBytes(16).toString('hex')
    const exp = now + CONFIRM_TOKEN_TTL_MS
    return `${exp}.${nonce}.${signature(b, exp, nonce)}`
}

const CANONICAL_TOKEN = /^([1-9][0-9]{0,15})\.([0-9a-f]{32})\.([0-9a-f]{64})$/

/** The nonce a token names, or null when it is not spelled as issued. */
export function confirmTokenNonce(token: string): string | null {
    return CANONICAL_TOKEN.exec(token)?.[2] ?? null
}

/**
 * Spend a confirm token for exactly this call. Returns its nonce; throws
 * CONFIRMATION_REQUIRED (whose next.args is the same call without the token,
 * i.e. "ask again") when it is malformed, expired, for another call, or spent.
 */
export async function consumeConfirmToken(
    token: string,
    b: ConfirmBinding,
    store: NonceStore = prismaNonceStore,
    now: number = Date.now(),
): Promise<string> {
    const next = { tool: b.tool, args: b.args }
    const refuse = (details: string): never => {
        throw new McpDenialError({
            code: 'CONFIRMATION_REQUIRED',
            details,
            next,
        })
    }
    const match = CANONICAL_TOKEN.exec(token)
    if (!match) {
        return refuse(
            'That confirmToken is malformed. Call again without it to get a new one.',
        )
    }
    const [, expText = '', nonce = '', sig = ''] = match
    const exp = Number(expText)
    if (!Number.isSafeInteger(exp) || exp < now) {
        return refuse(
            'That confirmation expired. Call again without confirmToken to get a new one.',
        )
    }
    const expected = signature(b, exp, nonce)
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
        return refuse(
            'That confirmToken was issued for a different call. Call again without it to get a new one.',
        )
    }
    if (!(await store.claim(nonce, new Date(exp)))) {
        return refuse(
            'That confirmToken was already used. Call again without it to get a new one.',
        )
    }
    return nonce
}
