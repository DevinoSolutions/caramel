import { GET as getPromptMd } from '@/app/agent-setup/prompt.md/route'
import {
    AGENT_GUIDES,
    AGENT_SETUP_COPY_TEXT,
    API,
    PROMPT_MD_URL,
    SKILL_NAME,
    SKILLS_REPO,
    renderPromptMd,
} from '@/lib/agentSetup/agentSetup.config'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// The agent-onboarding contract (fleet spec §2/§5): prompt.md renders from
// the ONE manifest with no placeholder text, is served as text/markdown with
// a short cache, the plugin/skill files it installs exist in this repo and
// point at the same API, and every URL in it answers 200 on the live site.

const { captureMock } = vi.hoisted(() => ({
    captureMock: vi.fn(async () => true),
}))
vi.mock('@/lib/analytics/posthogServer', () => ({
    captureServerEvent: captureMock,
}))

const REPO_ROOT = path.resolve(__dirname, '../../../..')

describe('agent-setup prompt.md', () => {
    const body = renderPromptMd()

    it('has the spec structure, no placeholder text, and the exact copy sentence points at it', () => {
        expect(body.startsWith('# Set up Caramel for an AI coding agent')).toBe(
            true,
        )
        for (const heading of [
            '## 1. Credentials',
            '## 2. Install the skill for your agent',
            '## 3. What the skill gives you',
            '## 4. Verify',
            '## 5. Completion message',
            '## Resources',
        ]) {
            expect(body).toContain(heading)
        }
        for (const guide of AGENT_GUIDES) {
            expect(body).toContain(`### ${guide.name}`)
            for (const command of guide.commands) {
                expect(body).toContain(command)
            }
        }
        expect(body).toContain('Do not ask the user to run any of these commands.')
        // Placeholders the spec template uses; none may survive rendering.
        expect(body).not.toMatch(/<App>|<docs-host>|<app-domain>|TODO|lorem/i)
        // No invented integrations: Caramel has no MCP server or SDK.
        expect(body).not.toMatch(/mcp\.grabcaramel|claude mcp add|npm i /)
        expect(AGENT_SETUP_COPY_TEXT).toBe(
            `Fetch and execute the appropriate instructions to set me up for Caramel from ${PROMPT_MD_URL}`,
        )
        expect(body).toContain(API.verifyUrl)
    })

    it('is served as text/markdown with a 5-minute cache and records the fetch server-side', async () => {
        captureMock.mockClear()
        const res = await getPromptMd(
            new Request('https://grabcaramel.com/agent-setup/prompt.md', {
                headers: {
                    'user-agent': 'claude-code/2.0',
                    referer: 'https://grabcaramel.com/agent-setup',
                    'x-forwarded-for': '203.0.113.9',
                },
            }),
        )
        expect(res.status).toBe(200)
        expect(res.headers.get('content-type')).toBe(
            'text/markdown; charset=utf-8',
        )
        expect(res.headers.get('cache-control')).toContain('max-age=300')
        expect(await res.text()).toBe(body)
        expect(captureMock).toHaveBeenCalledTimes(1)
        const call = captureMock.mock.calls[0] as unknown as [
            { event: string; distinctId: string; properties: Record<string, unknown> },
        ]
        expect(call[0].event).toBe('agent_setup_prompt_fetched')
        expect(call[0].distinctId).toMatch(/^agent-setup:[0-9a-f]{32}$/)
        expect(call[0].distinctId).not.toContain('203.0.113.9')
        expect(call[0].properties.user_agent).toBe('claude-code/2.0')
    })

    it('installs a plugin + skill that actually exist in this repo and name the same API', () => {
        const marketplace = JSON.parse(
            fs.readFileSync(
                path.join(REPO_ROOT, '.claude-plugin/marketplace.json'),
                'utf8',
            ),
        ) as { name: string; plugins: { name: string; source: string }[] }
        expect(body).toContain(`claude plugin marketplace add ${SKILLS_REPO}`)
        expect(body).toContain(
            `claude plugin install ${marketplace.plugins[0].name}@${marketplace.name}`,
        )
        const pluginDir = path.join(REPO_ROOT, marketplace.plugins[0].source)
        expect(
            fs.existsSync(path.join(pluginDir, '.claude-plugin/plugin.json')),
        ).toBe(true)
        const skill = fs.readFileSync(
            path.join(pluginDir, 'skills', SKILL_NAME, 'SKILL.md'),
            'utf8',
        )
        expect(skill.startsWith(`---\nname: ${SKILL_NAME}\n`)).toBe(true)
        expect(skill).toContain(API.coupons)
        expect(skill).toContain(API.stores)
        expect(body).toContain(`--skill ${SKILL_NAME}`)
    })

    it('every URL in prompt.md answers 200 on the live site', async () => {
        const urls = Array.from(
            new Set(body.match(/https?:\/\/[^\s)`>"]+/g) ?? []),
        ).map(url => url.replace(/[.,]$/, ''))
        expect(urls.length).toBeGreaterThan(5)
        // Pages that only exist once this branch is deployed are checked by
        // the e2e suite instead; the live check covers everything else.
        const shippedInThisBranch = new Set([
            PROMPT_MD_URL,
            'https://grabcaramel.com/faq',
            'https://grabcaramel.com/agent-setup',
            'https://grabcaramel.com/apps',
            `https://github.com/DevinoSolutions/caramel/blob/main/plugins/caramel/skills/${SKILL_NAME}/SKILL.md`,
        ])
        const results = await Promise.all(
            urls
                .filter(url => !shippedInThisBranch.has(url))
                .map(async url => {
                    const res = await fetch(url, {
                        method: 'GET',
                        headers: { 'user-agent': 'caramel-agent-setup-test' },
                        signal: AbortSignal.timeout(15_000),
                    })
                    return { url, status: res.status }
                }),
        )
        for (const { url, status } of results) {
            expect(status, url).toBe(200)
        }
    }, 60_000)
})
