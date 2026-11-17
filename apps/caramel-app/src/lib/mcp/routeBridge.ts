// src/lib/mcp/routeBridge.ts
//
// Runs a Caramel API route handler in-process for an MCP tool call, as the
// user the OAuth token belongs to. See routeBridgeContext.ts for why tools go
// through the routes instead of re-implementing them.
//
// The synthetic request:
//   - carries the site's own Origin and Host: the MCP server is a
//     first-party surface of grabcaramel.com, so it passes withRoute's
//     same-origin gate (isOriginAllowed compares Origin with Host) exactly as
//     the website does, and routes that accept a source only from the website
//     (coupons/submit `manual`) treat it the same way;
//   - carries no cookie or bearer: withRoute takes the bridged session;
//   - is rate-limited per USER, not per network: every Claude or ChatGPT user
//     arrives from the same few vendor addresses, so the vendor IP would put
//     all of them in one bucket. The limiter key is `mcp:<userId>`, set on a
//     fallback IP header that readEdgeClientIp (the forgery-resistant identity
//     used for anonymous coupon reports) never reads.
import { CLIENT_IP_HEADERS } from '@/lib/clientIp'
import { BASE_URL } from '@/lib/env.client'
import { McpDenialError, type DenialCode } from '@/lib/mcp/denial'
import {
    runAsBridgedSession,
    type BridgedSession,
} from '@/lib/mcp/routeBridgeContext'
import prisma from '@/lib/prisma'
import { NextRequest, type NextResponse } from 'next/server'

/** A route module's exported method handler (withRoute's return value). */
export type RouteHandlerFn = (req: NextRequest) => Promise<NextResponse>

export type RouteCall = {
    handler: RouteHandlerFn
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
    /** Path under the app origin, e.g. `/api/account/favorites/amazon.com`. */
    path: string
    query?: Record<string, string | number | boolean | undefined>
    body?: unknown
}

export type RouteResult = { status: number; body: unknown }

const BRIDGE_USER_AGENT = 'Caramel MCP'
const RATE_LIMIT_KEY_HEADER = CLIENT_IP_HEADERS[1]

/**
 * The better-auth session shape for a user, built from the users row, or null
 * when the user no longer exists (deleted) or is soft-deleted.
 */
export async function loadBridgedSession(args: {
    userId: string
    clientId: string
    expiresAt: Date
    issuedAt: Date
}): Promise<BridgedSession | null> {
    const user = await prisma.user.findUnique({ where: { id: args.userId } })
    if (!user || user.deletedAt) return null
    const session: BridgedSession = {
        session: {
            id: `mcp:${args.clientId}`,
            token: '',
            userId: user.id,
            expiresAt: args.expiresAt,
            createdAt: args.issuedAt,
            updatedAt: args.issuedAt,
            ipAddress: null,
            userAgent: BRIDGE_USER_AGENT,
        },
        user: {
            id: user.id,
            name: user.name ?? '',
            email: user.email ?? '',
            emailVerified: user.emailVerified,
            image: user.image,
            createdAt: user.createdAt,
            updatedAt: user.updatedAt,
            username: user.username,
            firstName: user.firstName,
            lastName: user.lastName,
            role: user.role,
            status: user.status,
            encodedPictureUrl: user.encodedPictureUrl,
            growthPromptsEnabled: user.growthPromptsEnabled,
        },
    }
    return session
}

function buildUrl(call: RouteCall): URL {
    const url = new URL(call.path, BASE_URL)
    for (const [key, value] of Object.entries(call.query ?? {})) {
        if (value !== undefined) url.searchParams.set(key, String(value))
    }
    return url
}

/** Call one route handler as `session` and read its JSON answer. */
export async function callRoute(
    session: BridgedSession,
    call: RouteCall,
): Promise<RouteResult> {
    const headers = new Headers({
        accept: 'application/json',
        origin: new URL(BASE_URL).origin,
        host: new URL(BASE_URL).host,
        'user-agent': BRIDGE_USER_AGENT,
        [RATE_LIMIT_KEY_HEADER]: `mcp:${session.user.id}`,
    })
    const hasBody = call.body !== undefined
    if (hasBody) headers.set('content-type', 'application/json')
    const req = new NextRequest(buildUrl(call), {
        method: call.method,
        headers,
        body: hasBody ? JSON.stringify(call.body) : undefined,
    })
    const res = await runAsBridgedSession(session, () => call.handler(req))
    const text = await res.text()
    let body: unknown = null
    if (text.length > 0) {
        try {
            body = JSON.parse(text)
        } catch {
            body = text
        }
    }
    return { status: res.status, body }
}

function errorMessageOf(body: unknown): string | null {
    if (body && typeof body === 'object') {
        const { error, message } = body as {
            error?: unknown
            message?: unknown
        }
        if (typeof error === 'string' && error.length > 0) return error
        if (typeof message === 'string' && message.length > 0) return message
    }
    return null
}

function denialCodeFor(status: number): DenialCode {
    if (status === 400 || status === 413 || status === 422)
        return 'VALIDATION_ERROR'
    if (status === 404) return 'NOT_FOUND'
    if (status === 409) return 'CONFLICT'
    if (status === 429) return 'RATE_LIMITED'
    return 'TOOL_FAILED'
}

/**
 * The route's JSON body when it answered 2xx; otherwise throws the coded
 * denial the status maps to, with the route's own error text.
 */
export function expectOk<T>(result: RouteResult): T {
    if (result.status >= 200 && result.status < 300) return result.body as T
    const code = denialCodeFor(result.status)
    const routeText = errorMessageOf(result.body)
    const details =
        code === 'RATE_LIMITED'
            ? 'Too many requests. Wait a minute and try again.'
            : (routeText ?? `The request failed (HTTP ${result.status}).`)
    throw new McpDenialError({ code, details })
}

/** callRoute + expectOk. */
export async function callRouteOk<T>(
    session: BridgedSession,
    call: RouteCall,
): Promise<T> {
    return expectOk<T>(await callRoute(session, call))
}
