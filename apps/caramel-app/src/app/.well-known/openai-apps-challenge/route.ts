// ChatGPT apps domain verification: the OpenAI platform fetches this path on
// the MCP host and expects the submission's token back as text/plain, the
// token alone. Env-driven (OPENAI_APPS_CHALLENGE_TOKEN) so a new token needs
// no code change; unset or blank answers 404, which the portal reads as "not
// configured yet" rather than "wrong token".
import { env } from '@/lib/env'

export const dynamic = 'force-dynamic'

export function GET(): Response {
    const token = env.OPENAI_APPS_CHALLENGE_TOKEN?.trim()
    if (!token) return new Response('Not Found', { status: 404 })
    return new Response(token, {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
}
