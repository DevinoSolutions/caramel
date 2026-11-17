import { describe, expect, it, vi } from 'vitest'

// The discovery documents an MCP client reads before its first call
// (src/lib/mcp/discovery.ts and the /.well-known routes): the protected
// resource names the real issuer and Caramel's scopes and never advertises
// DPoP; the authorization server lets public clients revoke; the server card
// points at both MCP surfaces; the ChatGPT challenge is 404 until configured.

vi.mock('@/lib/prisma', () => ({ default: {} }))

const { envMock } = vi.hoisted(() => ({
    envMock: { OPENAI_APPS_CHALLENGE_TOKEN: undefined as string | undefined },
}))
vi.mock('@/lib/env', async importOriginal => {
    const actual = await importOriginal<typeof import('@/lib/env')>()
    return {
        env: new Proxy(actual.env, {
            get: (t, k) =>
                k in envMock
                    ? envMock[k as keyof typeof envMock]
                    : t[k as keyof typeof t],
        }),
    }
})

import { GET as serverCard } from '@/app/.well-known/mcp/server-card.json/route'
import { GET as protectedResourceForPath } from '@/app/.well-known/oauth-protected-resource/api/mcp/route'
import { GET as protectedResource } from '@/app/.well-known/oauth-protected-resource/route'
import { GET as challenge } from '@/app/.well-known/openai-apps-challenge/route'
import { auth } from '@/lib/auth/auth'
import { BASE_URL } from '@/lib/env.client'
import {
    buildMcpServerCard,
    withPublicClientRevocation,
} from '@/lib/mcp/discovery'
import { MCP_RESOURCE, MCP_SCOPES } from '@/lib/mcp/oauthConfig'

const origin = BASE_URL.replace(/\/+$/, '')

describe('protected-resource metadata (RFC 9728)', () => {
    it.each([
        ['bare', protectedResource],
        ['resource-path', protectedResourceForPath],
    ])(
        '%s: names the MCP resource, the real issuer and the scopes',
        async (_name, get) => {
            const doc = (await (await get()).json()) as Record<string, unknown>
            expect(doc.resource).toBe(MCP_RESOURCE)
            expect(doc.authorization_servers).toEqual([
                (await auth.$context).baseURL,
            ])
            expect(String((doc.authorization_servers as string[])[0])).toMatch(
                /\/api\/auth$/,
            )
            expect(doc.scopes_supported).toEqual([
                ...MCP_SCOPES,
                'offline_access',
            ])
            expect(doc.bearer_methods_supported).toEqual(['header'])
            expect(doc).not.toHaveProperty('dpop_signing_alg_values_supported')
        },
    )
})

describe('authorization-server metadata correction', () => {
    it('appends "none" to the revocation auth methods once', () => {
        const fixed = withPublicClientRevocation({
            revocation_endpoint_auth_methods_supported: ['client_secret_basic'],
        })
        expect(fixed.revocation_endpoint_auth_methods_supported).toEqual([
            'client_secret_basic',
            'none',
        ])
        expect(withPublicClientRevocation(fixed)).toEqual(fixed)
    })

    it('leaves a document without the key untouched', () => {
        expect(withPublicClientRevocation({ issuer: 'x' })).toEqual({
            issuer: 'x',
        })
    })
})

describe('MCP server card', () => {
    it('lists both surfaces behind the protected-resource metadata', async () => {
        const card = (await serverCard().json()) as ReturnType<
            typeof buildMcpServerCard
        >
        expect(card.title).toBe('Caramel')
        expect(card.endpoint).toBe(`${origin}/api/mcp`)
        expect(card.remotes.map(remote => remote.url)).toEqual([
            `${origin}/api/mcp`,
            `${origin}/api/mcp?tools=directory`,
        ])
        for (const remote of card.remotes) {
            expect(remote.authentication.resourceMetadata).toBe(
                `${origin}/.well-known/oauth-protected-resource`,
            )
        }
    })
})

describe('ChatGPT apps domain challenge', () => {
    it('is 404 until a token is configured', async () => {
        envMock.OPENAI_APPS_CHALLENGE_TOKEN = '   '
        expect(challenge().status).toBe(404)
    })

    it('answers the token alone as text/plain', async () => {
        envMock.OPENAI_APPS_CHALLENGE_TOKEN = 'challenge-token-1'
        const res = challenge()
        expect(res.status).toBe(200)
        expect(res.headers.get('content-type')).toContain('text/plain')
        expect(await res.text()).toBe('challenge-token-1')
    })
})
