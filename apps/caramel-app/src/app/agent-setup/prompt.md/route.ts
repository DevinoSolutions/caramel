import { renderPromptMd } from '@/lib/agentSetup/agentSetup.config'
import { captureServerEvent } from '@/lib/analytics/posthogServer'
import { createHash } from 'node:crypto'

// The file an AI coding agent fetches and executes (fleet agent-onboarding
// spec §2). Same family as llms.txt: a public text asset, deliberately NOT a
// `withRoute` handler (no auth, no CORS gate, no body — an agent's plain
// fetch must never be turned away), served with a 5-minute cache and a
// text/markdown content type so `curl -sI` shows exactly what the spec asks.
//
// Every fetch is captured server-side (`agent_setup_prompt_fetched` with
// user-agent + referer) so we can see which agents actually pull it. The
// distinct id is a hash of UA + client IP, never the raw address; a capture
// failure is reported by captureServerEvent itself and never blocks the
// response.

export const dynamic = 'force-dynamic'

function fetcherId(req: Request): string {
    const ua = req.headers.get('user-agent') ?? ''
    const ip =
        req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
        req.headers.get('x-real-ip') ??
        ''
    return `agent-setup:${createHash('sha256').update(`${ua}|${ip}`).digest('hex').slice(0, 32)}`
}

export async function GET(req: Request): Promise<Response> {
    const body = renderPromptMd()
    await captureServerEvent({
        event: 'agent_setup_prompt_fetched',
        distinctId: fetcherId(req),
        properties: {
            user_agent: req.headers.get('user-agent') ?? null,
            referer: req.headers.get('referer') ?? null,
            bytes: body.length,
        },
    })
    return new Response(body, {
        status: 200,
        headers: {
            'Content-Type': 'text/markdown; charset=utf-8',
            'Cache-Control': 'public, max-age=300, s-maxage=300',
        },
    })
}
