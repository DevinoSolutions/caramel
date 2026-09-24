// src/lib/agentSetup/agentSetup.config.ts
//
// ONE manifest for "Onboard your agent to Caramel" (fleet agent-onboarding
// spec, Amin 2026-09-22). Three surfaces render from it and can therefore
// never drift: the raw `/agent-setup/prompt.md` an agent executes
// (app/agent-setup/prompt.md/route.ts), the human `/agent-setup` pages, and
// the copy pill (components/growth/AgentSetupPill.tsx).
//
// WHAT CARAMEL ACTUALLY HAS (audit 2026-09-22 — the spec says "wire up the
// richest integration the app actually has", and forbids a watered-down
// generic snippet, so this is the honest inventory):
//   - NO MCP server, NO SDK, NO CLI, NO webhooks, NO docs subdomain.
//   - A PUBLIC, unauthenticated, read-only coupon API: `GET /api/coupons`
//     (site/search/page/limit — src/app/api/coupons/route.ts, rate-limited
//     `read`, no origin gate) plus `/api/coupons/stores` and
//     `/api/coupons/[id]`. Verified from a plain `curl` on 2026-09-22.
//   - A Claude Code plugin + agent skill in THIS repo (`plugins/caramel/`,
//     marketplace at `.claude-plugin/marketplace.json`) that teaches an
//     agent to look codes up through that API before a purchase.
//   - The browser extension for four browsers (the human's install, listed
//     on /apps) — an agent cannot install it, so prompt.md points the user.
// So "set me up for Caramel" = install the skill (Claude Code: plugin;
// everyone else: `npx skills add`), know the API, verify with one call.
import { GITHUB_REPO_URL } from '@/lib/brandLinks'
import { BASE_URL } from '@/lib/env.client'

export const APP_NAME = 'Caramel'

const origin = BASE_URL.replace(/\/+$/, '')

/** The app domain doubles as the docs host: Caramel has no docs subdomain. */
export const DOCS_ORIGIN = origin
export const PROMPT_MD_PATH = '/agent-setup/prompt.md'
export const PROMPT_MD_URL = `${DOCS_ORIGIN}${PROMPT_MD_PATH}`
export const AGENT_SETUP_PATH = '/agent-setup'

/** The exact sentence the pill copies (spec §1). */
export const AGENT_SETUP_COPY_TEXT = `Fetch and execute the appropriate instructions to set me up for ${APP_NAME} from ${PROMPT_MD_URL}`

export const AGENT_SETUP_TOAST = 'Copied. Paste into any AI coding agent.'

/** GitHub `owner/repo` that hosts the marketplace + skill. */
export const SKILLS_REPO = 'DevinoSolutions/caramel'
export const MARKETPLACE_NAME = 'devino-caramel'
export const PLUGIN_NAME = 'caramel'
export const SKILL_NAME = 'caramel-coupons'

/** The public API an agent calls. */
export const API = {
    base: `${origin}/api`,
    coupons: `${origin}/api/coupons`,
    stores: `${origin}/api/coupons/stores`,
    /** One call, no key, proves the setup works. */
    verifyUrl: `${origin}/api/coupons?site=nike.com&limit=1`,
    verifyExpectation:
        'HTTP 200 with a JSON body whose `coupons` array holds one object carrying `code`, `site` and `title`, and a numeric `total`.',
} as const

export type AgentId =
    | 'claude-code'
    | 'codex'
    | 'cursor'
    | 'opencode'
    | 'github-copilot'

export type AgentGuide = {
    id: AgentId
    name: string
    /** One-line "what you get". */
    summary: string
    /** Shell commands the agent runs, in order (empty when config-file only). */
    commands: readonly string[]
    /** A config file to write, when the agent is configured by file. */
    configFile?: { path: string; contents: string }
    /** What the human still has to do after the agent finishes. */
    userFollowUp: readonly string[]
}

// Without `--agent`, `skills add --yes` installs into EVERY agent it
// detects; each guide names its own target. The generic fallback ("any
// other agent") deliberately keeps the detect-all behaviour.
const skillsCliInstall = `npx -y skills add ${SKILLS_REPO} --skill ${SKILL_NAME} --yes --global`
const skillsCliInstallFor = (agent: string) =>
    `${skillsCliInstall} --agent ${agent}`

/**
 * Per-agent instructions. Claude Code gets the plugin (marketplace +
 * install); everyone else gets the same skill through the `skills` CLI,
 * which places SKILL.md where that agent reads it. No MCP entries: there is
 * no Caramel MCP server, and an invented endpoint would 404.
 */
export const AGENT_GUIDES: readonly AgentGuide[] = [
    {
        id: 'claude-code',
        name: 'Claude Code',
        summary:
            'The Caramel plugin: a skill that looks up coupon codes for any store through the public API before you buy.',
        commands: [
            `claude plugin marketplace add ${SKILLS_REPO}`,
            `claude plugin install ${PLUGIN_NAME}@${MARKETPLACE_NAME}`,
        ],
        userFollowUp: [
            'Run /reload-plugins in Claude Code so the new skill is picked up.',
        ],
    },
    {
        id: 'codex',
        name: 'Codex',
        summary:
            'The Caramel coupon skill installed globally for Codex via the skills CLI.',
        commands: [skillsCliInstallFor('codex')],
        userFollowUp: ['Start a new Codex session so the skill is loaded.'],
    },
    {
        id: 'cursor',
        name: 'Cursor',
        summary:
            'The Caramel coupon skill installed for Cursor via the skills CLI.',
        commands: [skillsCliInstallFor('cursor')],
        userFollowUp: ['Reload the Cursor window so the skill is loaded.'],
    },
    {
        id: 'opencode',
        name: 'OpenCode',
        summary:
            'The Caramel coupon skill installed for OpenCode via the skills CLI.',
        commands: [skillsCliInstallFor('opencode')],
        userFollowUp: ['Start a new OpenCode session so the skill is loaded.'],
    },
    {
        id: 'github-copilot',
        name: 'GitHub Copilot',
        summary:
            'The Caramel coupon skill installed for GitHub Copilot via the skills CLI.',
        commands: [skillsCliInstallFor('github-copilot')],
        userFollowUp: ['Reload VS Code so Copilot picks the skill up.'],
    },
]

export function agentGuide(id: string): AgentGuide | null {
    return AGENT_GUIDES.find(guide => guide.id === id) ?? null
}

export const RESOURCES = {
    home: origin,
    apps: `${origin}/apps`,
    faq: `${origin}/faq`,
    llms: `${origin}/llms.txt`,
    llmsFull: `${origin}/llms-full.txt`,
    coupons: `${origin}/coupons`,
    support: `${origin}/support`,
    repo: GITHUB_REPO_URL,
    skill: `${GITHUB_REPO_URL}/blob/main/plugins/caramel/skills/${SKILL_NAME}/SKILL.md`,
} as const

/**
 * The raw prompt.md body (spec §2). Rendered ONCE from this manifest; the
 * route serves it as text/markdown. Every command here is one the agent can
 * run itself — the browser extension is the single thing it must hand back
 * to the human, and it says so.
 */
export function renderPromptMd(): string {
    const guides = AGENT_GUIDES.map(guide => {
        const commands = guide.commands.length
            ? ['```bash', ...guide.commands, '```'].join('\n')
            : ''
        const config = guide.configFile
            ? [
                  `Write \`${guide.configFile.path}\`:`,
                  '```json',
                  guide.configFile.contents,
                  '```',
              ].join('\n')
            : ''
        return [
            `### ${guide.name}`,
            '',
            guide.summary,
            '',
            commands,
            config,
            'After it finishes, tell the user:',
            ...guide.userFollowUp.map(line => `- ${line}`),
        ]
            .filter(line => line !== '')
            .join('\n')
    }).join('\n\n')

    return `# Set up ${APP_NAME} for an AI coding agent

These are official instructions from ${APP_NAME} to set up an AI development environment for ${APP_NAME}, the free, open-source browser extension that finds and applies coupon codes at checkout, and its public coupon API. All commands are validated by ${APP_NAME}. Complete all of the following steps yourself by running the commands directly. Do not ask the user to run any of these commands.

Steps:

1. Confirm which agent you are and follow ONLY that agent's section below.
2. Install the ${APP_NAME} coupon skill for that agent.
3. Verify the public coupon API answers.
4. Print the completion message.

## 1. Credentials

None. The ${APP_NAME} coupon API is public and read-only; there is no API key, no OAuth and no environment variable to set. Never ask the user for a key.

## 2. Install the skill for your agent

${guides}

### Any other agent

\`\`\`bash
${skillsCliInstall}
\`\`\`

If \`npx\` is unavailable, fetch ${RESOURCES.skill} and place its contents where your agent reads skills.

## 3. What the skill gives you

- \`GET ${API.coupons}?site=<store domain>&limit=<n>\` returns coupon codes for a store (limit defaults to 10, caps at 50; \`page=<n>\` pages). Each \`coupons[]\` object carries \`id\`, \`code\`, \`site\`, \`title\`, \`description\`, \`rating\`, \`discount_type\` (uppercase, e.g. \`PERCENTAGE\`, or null), \`discount_amount\` (number or null), \`expiry\` (an opaque display string such as \`"-"\`, or null; do not parse it as a date), \`expired\`, \`timesUsed\`, \`status\` (the latest verification result, e.g. \`valid\`, \`pending\`, \`retry\`, \`invalid\`), \`verificationMessage\` and \`lastWorkedAt\` (ISO time or null). \`total\`, \`page\`, \`limit\` and \`hasMore\` describe the page.
- \`GET ${API.coupons}?search=<text>&limit=<n>\` matches the text (up to 100 characters) against store domain, title, description and code across every store.
- \`GET ${API.stores}?q=<text>&limit=<n>\` returns \`{ "sites": [...] }\`, store domains containing the text, sorted alphabetically. Use it to turn what the user calls a shop into the \`site\` value above.
- Rate-limited per client IP as a public read endpoint; be polite (one call per question, cache within a session).
- Codes are found by ${APP_NAME}'s pipeline and reported on by real shoppers; none is guaranteed to work. The browser extension tries them at checkout automatically.

## 4. Verify

Run:

\`\`\`bash
curl -s "${API.verifyUrl}"
\`\`\`

Success: ${API.verifyExpectation}

## 5. Completion message

Print exactly this, filling the brackets:

> ${APP_NAME} is set up for [agent name]. Installed: the \`${SKILL_NAME}\` skill (looks up coupon codes through ${API.coupons}). Verified: the public API answered for nike.com. Still yours to do: [the follow-up lines for your agent]. To have codes applied automatically while you shop, install the ${APP_NAME} extension for your browser from ${RESOURCES.apps} (an agent cannot install a browser extension for you).

## Resources

- Home: ${RESOURCES.home}
- Get the extension (Chrome, Firefox, Edge, Safari): ${RESOURCES.apps}
- FAQ: ${RESOURCES.faq}
- llms.txt: ${RESOURCES.llms} (full version: ${RESOURCES.llmsFull})
- Coupon API: ${API.coupons}
- Browse coupons: ${RESOURCES.coupons}
- Source code and issues: ${RESOURCES.repo}
- Support: ${RESOURCES.support}
`
}
