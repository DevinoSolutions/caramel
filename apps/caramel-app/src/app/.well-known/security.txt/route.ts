// Like llms.txt, this is a public text document, not an /api handler:
// it accepts no input and needs none of withRoute's auth/CORS/body policies.
// Keep the expiry tied to each request rather than the build timestamp.
export const dynamic = 'force-dynamic'

const EXPIRY_WINDOW_MS = 180 * 24 * 60 * 60 * 1000

export function GET(): Response {
    const expires = new Date(Date.now() + EXPIRY_WINDOW_MS).toISOString()
    // /support is Caramel's existing public contact form, including for
    // anonymous visitors. No security-specific mailbox or policy is invented.
    const body = `Contact: https://grabcaramel.com/support
Expires: ${expires}
Canonical: https://grabcaramel.com/.well-known/security.txt
Preferred-Languages: en
`

    return new Response(body, {
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
        },
    })
}
