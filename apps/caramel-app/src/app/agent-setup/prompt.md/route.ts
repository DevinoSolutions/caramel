import { renderPromptMd } from '@/lib/agentSetup/agentSetup.config'
import { captureServerEvent } from '@/lib/analytics/posthogServer'
import { env } from '@/lib/env'
import { after } from 'next/server'
import { createHmac } from 'node:crypto'

// The file an AI coding agent fetches and executes (fleet agent-onboarding
// spec §2). Same family as llms.txt: a public text asset, deliberately NOT a
// `withRoute` handler (no auth, no CORS gate, no body — an agent's plain
// fetch must never be turned away), served with a 5-minute cache and a
// text/markdown content type so `curl -sI` shows exactly what the spec asks.
//
// Every fetch is captured server-side (`agent_setup_prompt_fetched` with
// user-agent + referer) so we can see which agents actually pull it. The
// capture runs in `after()`: posthog-node can spend seconds on timeouts and
// retries during a PostHog outage, and the agent's fetch must not wait on
// it. captureServerEvent reports its own failures to Sentry and resolves a
// boolean, so the work is still checked, just off the response path.
//
// The distinct id is an HMAC of UA + client IP keyed by the server's auth
// secret (env.ts guarantees one is set): stable per fetcher so repeat pulls
// group together, but not reversible by brute-forcing the IPv4 space the
// way a bare sha256 would be.

export const dynamic = 'force-dynamic'

function fetcherId(req: Request): string {
    const ua = req.headers.get('user-agent') ?? ''
    const ip =
        req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
        req.headers.get('x-real-ip') ??
        ''
    const key = env.BETTER_AUTH_SECRET ?? env.JWT_SECRET ?? ''
    const digest = createHmac('sha256', key)
        .update(`agent-setup|${ua}|${ip}`)
        .digest('hex')
        .slice(0, 32)
    return `agent-setup:${digest}`
}

export async function GET(req: Request): Promise<Response> {
    const body = renderPromptMd()
    const distinctId = fetcherId(req)
    const properties = {
        user_agent: req.headers.get('user-agent') ?? null,
        referer: req.headers.get('referer') ?? null,
        bytes: body.length,
    }
    after(() =>
        captureServerEvent({
            event: 'agent_setup_prompt_fetched',
            distinctId,
            properties,
        }),
    )
    return new Response(body, {
        status: 200,
        headers: {
            'Content-Type': 'text/markdown; charset=utf-8',
            'Cache-Control': 'public, max-age=300, s-maxage=300',
        },
    })
}
