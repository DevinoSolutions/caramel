// LIVE eval for the Caramel MCP server's agent-facing text: given the REAL
// server instructions and the REAL registered tool ids, titles and
// descriptions (src/lib/mcp/server.ts and tools/registry.ts, imported, never
// copied), does a model pick the right tool for what a user asks? A tool
// description that sends agents to the wrong tool (or to none) is the MCP
// equivalent of a broken button, and this is the only check that reads the
// descriptions the way an agent does.
//
// Scored deterministically: each case lists the tool ids that are a correct
// first call; the model answers {"tool": "<id>"} and a case passes when that
// id is in the list. Gate: >= TOOL_CHOICE_THRESHOLD of the cases.
//
// NOT collected by the unit suite (vitest.config.ts excludes **/*.eval.*);
// run by .github/workflows/ai-evals.yml's "MCP tool choice eval" job and by
// `pnpm eval` locally. Costs ~30 short completions at temperature 0.
// No tool ever runs here: the registry is imported for its text only.
import { env } from '@/lib/env'
import { firstJsonObject } from '@/lib/llmJson'
import { MCP_PRODUCT_INSTRUCTIONS, registeredTools } from '@/lib/mcp/server'
import { chat } from '@/lib/openrouter'
import { beforeAll, expect, it } from 'vitest'
import { redactSecrets } from './scorers'

const TOOL_CHOICE_THRESHOLD = 0.85

interface ToolChoiceCase {
    name: string
    prompt: string
    /** Tool ids that are a correct FIRST call for the prompt. */
    accept: readonly string[]
}

const CASES: readonly ToolChoiceCase[] = [
    {
        name: 'store codes',
        prompt: 'Any coupon codes for nike.com?',
        accept: ['get_store_deals', 'search_coupons'],
    },
    {
        name: 'best deal at a store',
        prompt: "What's the best deal at Walmart right now?",
        accept: ['get_store_deals', 'search_coupons'],
    },
    {
        name: 'keyword search',
        prompt: 'Find me a free shipping code for running shoes, any store.',
        accept: ['search_coupons'],
    },
    {
        name: 'store coverage',
        prompt: 'Does Caramel cover a store called Glossier?',
        accept: ['search_stores'],
    },
    {
        name: 'top stores',
        prompt: 'Which stores have the most coupons on Caramel?',
        accept: ['list_top_stores'],
    },
    {
        name: 'recently worked',
        prompt: 'Show me codes people confirmed worked in the last little while.',
        accept: ['list_recently_worked_coupons'],
    },
    {
        name: 'catalog totals',
        prompt: 'How many active coupon codes does Caramel have in total?',
        accept: ['get_catalog_overview'],
    },
    {
        name: 'coupon sources',
        prompt: 'Which websites does Caramel get its codes from?',
        accept: ['list_coupon_sources'],
    },
    {
        name: 'one coupon',
        prompt: 'Tell me the terms and expiry of coupon id 8f2c1a.',
        accept: ['get_coupon'],
    },
    {
        name: 'save a store',
        prompt: 'Save target.com to my favorite stores.',
        accept: ['add_favorite_store'],
    },
    {
        name: 'unsave a store',
        prompt: 'Remove Amazon from my saved stores.',
        accept: ['remove_favorite_store'],
    },
    {
        name: 'list saved stores',
        prompt: 'Which stores have I starred?',
        accept: ['list_favorite_stores', 'get_account_overview'],
    },
    {
        name: 'rename',
        prompt: 'Change my first name on Caramel to Ada.',
        accept: ['update_profile'],
    },
    {
        name: 'account email',
        prompt: 'What email address is my Caramel account under?',
        accept: ['get_profile'],
    },
    {
        name: 'money saved',
        prompt: 'How much money have I saved with Caramel so far?',
        accept: ['get_account_overview'],
    },
    {
        name: 'read settings',
        prompt: 'Is savings sync turned on for me?',
        accept: ['get_settings'],
    },
    {
        name: 'change settings',
        prompt: 'Turn off the tips and prompts Caramel shows me.',
        accept: ['update_settings'],
    },
    {
        name: 'export',
        prompt: 'Give me a full download of everything Caramel stores about me.',
        accept: ['export_data'],
    },
    {
        name: 'erase data, keep account',
        prompt: 'Wipe my savings history and saved stores, but keep my account.',
        accept: ['delete_my_data'],
    },
    {
        name: 'delete account',
        prompt: 'Delete my Caramel account for good.',
        accept: ['delete_account'],
    },
    {
        name: 'plan',
        prompt: 'Am I paying for Caramel? What plan am I on?',
        accept: ['billing_status'],
    },
    {
        name: 'granted permissions',
        prompt: 'What are you allowed to do on my Caramel account through this connection?',
        accept: ['list_granted_scopes'],
    },
    {
        name: 'more permissions',
        prompt: 'I want you to be able to change my settings too. How do I give you that permission?',
        accept: ['request_scopes'],
    },
    {
        name: 'connected apps',
        prompt: 'Which AI apps are connected to my Caramel account?',
        accept: ['list_connections'],
    },
    {
        name: 'disconnect',
        prompt: 'Disconnect yourself from my Caramel account.',
        accept: ['disconnect'],
    },
    {
        name: 'support',
        prompt: "The extension stopped finding codes at checkout. Tell Caramel's team.",
        accept: ['create_support_ticket'],
    },
    {
        name: 'submit a code',
        prompt: 'I found a code SAVE20 that works at bestbuy.com, add it to Caramel.',
        accept: ['submit_coupon'],
    },
    {
        name: 'report a code',
        prompt: 'The code WELCOME10 at nike.com did not work for me, let Caramel know.',
        accept: ['report_coupon'],
    },
    {
        name: 'request a store',
        prompt: 'Please ask Caramel to start supporting etsy.com.',
        accept: ['request_store'],
    },
    {
        name: 'request a source',
        prompt: 'Ask Caramel to start collecting codes from the coupon site dealsforyou.example.',
        accept: ['request_coupon_source'],
    },
]

function systemPrompt(): string {
    const tools = registeredTools()
        .map(tool => `- ${tool.id} (${tool.title}): ${tool.description}`)
        .join('\n')
    return `You are an AI assistant connected to the Caramel MCP server.

Server instructions:
${MCP_PRODUCT_INSTRUCTIONS}

Tools:
${tools}

For the user's message, answer with the single tool you would call FIRST, as JSON only: {"tool": "<tool id>"}. Use one of the ids above exactly.`
}

interface CaseOutcome {
    name: string
    accept: readonly string[]
    picked: string | null
    error: string | null
    pass: boolean
}

function pickedTool(raw: string): string | null {
    const parsed = firstJsonObject(raw)
    if (parsed && typeof parsed === 'object' && 'tool' in parsed) {
        const tool = (parsed as { tool: unknown }).tool
        return typeof tool === 'string' ? tool.trim() : null
    }
    return null
}

let outcomes: CaseOutcome[] = []

beforeAll(async () => {
    const system = systemPrompt()
    // Sequential on purpose: polite to the provider's rate limits, as the
    // other eval suites are.
    for (const caseDef of CASES) {
        try {
            const raw = await chat(
                [
                    { role: 'system', content: system },
                    { role: 'user', content: caseDef.prompt },
                ],
                {
                    temperature: 0,
                    responseFormat: 'json_object',
                    // Reasoning models spend hidden tokens first (F-017).
                    maxTokens: 600,
                    timeoutMs: 20_000,
                },
            )
            const picked = pickedTool(raw)
            outcomes.push({
                name: caseDef.name,
                accept: caseDef.accept,
                picked,
                error: picked
                    ? null
                    : `unparsable answer: ${raw.slice(0, 120)}`,
                pass: picked !== null && caseDef.accept.includes(picked),
            })
        } catch (error) {
            outcomes.push({
                name: caseDef.name,
                accept: caseDef.accept,
                picked: null,
                error: redactSecrets(
                    error instanceof Error ? error.message : String(error),
                    [env.OPENROUTER_API_KEY],
                ),
                pass: false,
            })
        }
    }
    const passed = outcomes.filter(o => o.pass).length
    console.log(
        `[mcp-tool-choice-eval] model=${env.OPENROUTER_MODEL} cases=${outcomes.length} ` +
            `match_rate=${((passed / outcomes.length) * 100).toFixed(1)}% (${passed}/${outcomes.length})`,
    )
    for (const miss of outcomes.filter(o => !o.pass)) {
        console.log(
            `[mcp-tool-choice-eval] miss: ${miss.name} picked=${miss.picked ?? '-'} accept=${miss.accept.join('|')}${
                miss.error ? ` error=${miss.error}` : ''
            }`,
        )
    }
})

it('every case expects a tool the server registers', () => {
    const ids = new Set(registeredTools().map(tool => tool.id))
    for (const caseDef of CASES) {
        for (const id of caseDef.accept)
            expect(ids.has(id), caseDef.name).toBe(true)
    }
})

it(`picks the right tool for >=${TOOL_CHOICE_THRESHOLD} of the cases`, () => {
    const rate = outcomes.filter(o => o.pass).length / outcomes.length
    const misses = outcomes
        .filter(o => !o.pass)
        .map(o => `${o.name} (picked ${o.picked ?? 'nothing'})`)
    expect(
        rate,
        misses.length
            ? `match_rate=${(rate * 100).toFixed(1)}% — misses: ${misses.join(', ')}`
            : undefined,
    ).toBeGreaterThanOrEqual(TOOL_CHOICE_THRESHOLD)
})
