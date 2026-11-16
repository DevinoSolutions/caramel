import { BASE_URL } from '@/lib/env.client'
import { MCP_RESOURCE } from '@/lib/mcp/oauthConfig'

// RFC 9727 API catalog: where an agent looks first for a site's public APIs.
// Caramel publishes two: the MCP server (OAuth, the user's account; its
// server card and RFC 9728 metadata as service-meta) and the read-only coupon
// API that llms.txt documents
// (/api/coupons?site=<domain>|?search=<text>, /api/coupons/stores?q=<prefix>).
// The write endpoints beside it (submit, report, increment, expire) serve the
// extension and are not a supported integration surface, so they are not
// listed. There is no OpenAPI document, so each entry names its prose docs:
// llms.txt and the agent-setup prompt.
//
// Like security.txt, a static public document rather than a withRoute /api
// handler: no input, no auth, no DB.
const origin = BASE_URL.replace(/\/+$/, '')

const SERVICE_DOCS = [
    { href: `${origin}/llms.txt`, type: 'text/plain' },
    { href: `${origin}/agent-setup/prompt.md`, type: 'text/markdown' },
]

const API_CATALOG = {
    linkset: [
        {
            anchor: MCP_RESOURCE,
            'service-doc': [{ href: `${origin}/docs#mcp`, type: 'text/html' }],
            'service-meta': [
                {
                    href: `${origin}/.well-known/mcp/server-card.json`,
                    type: 'application/json',
                },
                {
                    href: `${origin}/.well-known/oauth-protected-resource`,
                    type: 'application/json',
                },
            ],
        },
        {
            anchor: `${origin}/api/coupons`,
            'service-doc': SERVICE_DOCS,
        },
        {
            anchor: `${origin}/api/coupons/stores`,
            'service-doc': SERVICE_DOCS,
        },
    ],
}

const API_CATALOG_CONTENT_TYPE =
    'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"'

export function GET(): Response {
    return new Response(`${JSON.stringify(API_CATALOG, null, 2)}\n`, {
        headers: {
            'Content-Type': API_CATALOG_CONTENT_TYPE,
            'Cache-Control': 'public, max-age=3600',
        },
    })
}

// RFC 9727 §2: a HEAD on the well-known URI answers with a Link to itself.
export function HEAD(): Response {
    return new Response(null, {
        headers: {
            'Content-Type': API_CATALOG_CONTENT_TYPE,
            Link: `<${origin}/.well-known/api-catalog>; rel="api-catalog"`,
        },
    })
}
