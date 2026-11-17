import { GET, HEAD } from '@/app/.well-known/api-catalog/route'
import { BASE_URL } from '@/lib/env.client'
import { describe, expect, it } from 'vitest'

// RFC 9727: the agent-surface contract (T-5785) asks every app with a public
// API to list it at /.well-known/api-catalog. Caramel's is the read-only coupon
// API that llms.txt documents.

const origin = BASE_URL.replace(/\/+$/, '')
const RFC9727_TYPE =
    'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"'

type Linkset = {
    linkset: { anchor: string; 'service-doc': { href: string }[] }[]
}

describe('/.well-known/api-catalog', () => {
    it('answers a non-empty RFC 9727 linkset with the linkset+json profile type', async () => {
        const response = GET()
        const catalog = (await response.json()) as Linkset

        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe(RFC9727_TYPE)
        expect(catalog.linkset.length).toBeGreaterThan(0)
    })

    it('lists the MCP server and exactly the read-only coupon endpoints llms.txt documents, never the extension write routes', async () => {
        const catalog = (await GET().json()) as Linkset
        const anchors = catalog.linkset.map(entry => entry.anchor)

        expect(anchors).toEqual([
            `${origin}/api/mcp`,
            `${origin}/api/coupons`,
            `${origin}/api/coupons/stores`,
        ])
        for (const anchor of anchors) {
            expect(anchor).not.toMatch(/submit|report|increment|expire/)
        }
    })

    it('points the MCP server at its docs, server card and resource metadata', async () => {
        const catalog = (await GET().json()) as Linkset
        const mcp = catalog.linkset[0] as Linkset['linkset'][number] & {
            'service-meta': { href: string }[]
        }
        expect(mcp['service-doc'].map(doc => doc.href)).toEqual([
            `${origin}/docs#mcp`,
        ])
        expect(mcp['service-meta'].map(doc => doc.href)).toEqual([
            `${origin}/.well-known/mcp/server-card.json`,
            `${origin}/.well-known/oauth-protected-resource`,
        ])
    })

    it('points every coupon endpoint at docs this app serves on its own origin', async () => {
        const catalog = (await GET().json()) as Linkset

        for (const entry of catalog.linkset.slice(1)) {
            expect(entry['service-doc'].map(doc => doc.href)).toEqual([
                `${origin}/llms.txt`,
                `${origin}/agent-setup/prompt.md`,
            ])
        }
    })

    it('answers HEAD with a Link to itself under rel="api-catalog" and no body', async () => {
        const response = HEAD()

        expect(response.status).toBe(200)
        expect(response.headers.get('link')).toBe(
            `<${origin}/.well-known/api-catalog>; rel="api-catalog"`,
        )
        expect(await response.text()).toBe('')
    })
})
