// src/lib/mcp/knownMcpClients.ts
//
// Fleet registry of known MCP clients, copied verbatim from the fleet
// reference (handoff known-mcp-clients/known-mcp-clients.ts, owner ruling
// 2026-11-01). Decides how the consent screen and the connected-apps list
// NAME a client; consent stays required for every tier. Update it only by
// re-copying the fleet file.
/**
 * Known MCP clients — reference registry for the fleet consent screens.
 * Spec: ~/.claude/handoff/known-mcp-clients/SPEC.md (owner ruling 2026-11-01).
 *
 * Three display tiers, decided from the STORED registration at render time:
 *   verified   — every redirect URI is one vendor's hosted https callback
 *                (exact string or anchored pattern). Our name + badge, no warning.
 *   recognized — client_name matches a known local client AND every redirect
 *                URI is loopback http, that vendor's custom scheme, or that
 *                vendor's hosted https. Our name, no warning, "runs on your
 *                computer" line, no "Verified" badge.
 *   unverified — anything else. Existing caution unchanged.
 *
 * Display only. Consent stays required for every tier.
 */

export type KnownMcpClientId =
    | 'claude'
    | 'claude-code'
    | 'chatgpt'
    | 'codex'
    | 'cursor'
    | 'vscode'
    | 'windsurf'
    | 'gemini-cli'
    | 'gemini-enterprise'
    | 'antigravity'
    | 'cline'
    | 'zed'
    | 'opencode'
    | 'goose'
    | 'kiro'
    | 'continue'
    | 'copilot-cli'
    | 'jetbrains'
    | 'warp'
    | 'raycast'
    | 'mcp-inspector'
    | 'mcp-cli-proxy'
    | 'mcpjam'
    | 'perplexity'
    | 'smithery'
    | 'glama'
    | 'n8n'
    | 'microsoft-copilot'
    | 'zapier'
    | 'mistral'
    | 'grok'
    | 'canva'
    | 'adobe-express'
    | 'mcp-market'

export type KnownMcpClient = {
    id: KnownMcpClientId
    /** OUR display name. Never the registration's client_name. */
    name: string
    homepage: string
    /** Exact hosted https callbacks (string equality). */
    hostedUris?: readonly string[]
    /** Anchored patterns for hosted callbacks that carry a per-connector id. */
    hostedPatterns?: readonly RegExp[]
    /** Exact custom-scheme callbacks this vendor's local app registers. */
    schemeUris?: readonly string[]
    /** Anchored patterns over the trimmed client_name that this LOCAL client registers. Absent = never recognized via loopback. */
    namePatterns?: readonly RegExp[]
    /**
     * The hosted callback is SHARED by every third-party app built on this platform
     * (any Canva/Zapier/Copilot Studio app receives codes there), so a match proves
     * the code goes to the platform, not that the requester is the platform.
     * Such a match is tier "recognized" (no warning, no Verified badge), never "verified".
     */
    sharedPlatform?: true
}

export const KNOWN_MCP_CLIENTS: readonly KnownMcpClient[] = [
    {
        id: 'claude',
        name: 'Claude',
        homepage: 'https://claude.ai',
        hostedUris: [
            'https://claude.ai/api/mcp/auth_callback',
            'https://claude.com/api/mcp/auth_callback',
        ],
    },
    {
        id: 'claude-code',
        name: 'Claude Code',
        homepage: 'https://claude.com/claude-code',
        // Observed: "Claude Code (superbooks)", "Claude Code (plugin:superbooks:superbooks)".
        namePatterns: [/^Claude Code( \(.{1,120}\))?$/],
    },
    {
        id: 'chatgpt',
        name: 'ChatGPT',
        homepage: 'https://chatgpt.com',
        hostedUris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
        // Per-connector form used when the AS does not advertise RFC 9207 iss.
        hostedPatterns: [
            /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]{1,128}$/,
        ],
    },
    {
        id: 'codex',
        name: 'Codex',
        homepage: 'https://openai.com/codex',
        // Observed: "Codex" → http://127.0.0.1:PORT/callback (may carry a callback-id segment).
        namePatterns: [/^Codex( CLI| \(.{1,120}\))?$/],
    },
    {
        id: 'cursor',
        name: 'Cursor',
        homepage: 'https://cursor.com',
        hostedUris: [
            'https://www.cursor.com/agents/mcp/oauth/callback',
            'https://cursor.com/agents/mcp/oauth/callback',
            'https://www.cursor.com/bot/mcp/oauth/callback',
            'https://cursor.com/bot/mcp/oauth/callback',
        ],
        schemeUris: [
            'cursor://anysphere.cursor-mcp/oauth/callback',
            'com.anysphere.cursor:/oauth/callback',
            'cursor://anysphere.cursor-retrieval/oauth/callback',
        ],
        namePatterns: [/^Cursor( \(.{1,120}\))?$/],
    },
    {
        id: 'vscode',
        name: 'Visual Studio Code',
        homepage: 'https://code.visualstudio.com',
        hostedUris: [
            'https://vscode.dev/redirect',
            'https://insiders.vscode.dev/redirect',
        ],
        schemeUris: [
            'vscode://ms-vscode.mcp/authorize',
            'vscode-insiders://ms-vscode.mcp/authorize',
        ],
        namePatterns: [
            /^(Visual Studio Code|VS Code|Code - OSS|VSCodium)( .{1,120})?$/,
        ],
    },
    {
        id: 'windsurf',
        name: 'Windsurf',
        homepage: 'https://windsurf.com',
        namePatterns: [/^(Windsurf|Devin Desktop|Cascade)( .{1,120})?$/],
    },
    {
        id: 'gemini-cli',
        name: 'Gemini CLI',
        homepage: 'https://geminicli.com',
        // Source: google-gemini/gemini-cli packages/core/src/mcp — "Gemini CLI (…)" variants.
        namePatterns: [/^Gemini (CLI|Code Assist)( \(.{1,120}\))?$/],
    },
    {
        id: 'gemini-enterprise',
        name: 'Gemini Enterprise',
        homepage: 'https://cloud.google.com/gemini/enterprise',
        hostedUris: ['https://vertexaisearch.cloud.google.com/oauth-redirect'],
    },
    {
        id: 'antigravity',
        name: 'Antigravity',
        homepage: 'https://antigravity.google',
        hostedUris: ['https://antigravity.google/oauth-callback'],
        namePatterns: [/^Antigravity( .{1,120})?$/],
    },
    {
        id: 'cline',
        name: 'Cline',
        homepage: 'https://cline.bot',
        // Source: cline/cline sdk/packages/core/src/extensions/mcp/oauth.ts — client_name "Cline".
        namePatterns: [/^Cline( .{1,120})?$/],
    },
    {
        id: 'zed',
        name: 'Zed',
        homepage: 'https://zed.dev',
        // Source: zed-industries/zed crates/context_server/src/oauth.rs — client_name "Zed".
        namePatterns: [/^Zed( .{1,120})?$/],
    },
    {
        id: 'opencode',
        name: 'OpenCode',
        homepage: 'https://opencode.ai',
        // Observed: "OpenCode" → http://127.0.0.1:PORT/mcp/oauth/callback.
        namePatterns: [/^OpenCode( .{1,120})?$/],
    },
    {
        id: 'goose',
        name: 'Goose',
        homepage: 'https://block.github.io/goose',
        namePatterns: [/^Goose( .{1,120})?$/],
    },
    {
        id: 'kiro',
        name: 'Kiro',
        homepage: 'https://kiro.dev',
        namePatterns: [/^Kiro( .{1,120})?$/],
    },
    {
        id: 'continue',
        name: 'Continue',
        homepage: 'https://continue.dev',
        namePatterns: [/^Continue( .{1,120})?$/],
    },
    {
        id: 'copilot-cli',
        name: 'GitHub Copilot',
        homepage: 'https://github.com/features/copilot',
        namePatterns: [/^(GitHub Copilot|Copilot)( .{1,120})?$/],
    },
    {
        id: 'jetbrains',
        name: 'JetBrains AI Assistant',
        homepage: 'https://www.jetbrains.com/ai',
        namePatterns: [/^(JetBrains|IntelliJ|Junie)( .{1,120})?$/],
    },
    {
        id: 'warp',
        name: 'Warp',
        homepage: 'https://www.warp.dev',
        namePatterns: [/^Warp( .{1,120})?$/],
    },
    {
        id: 'raycast',
        name: 'Raycast',
        homepage: 'https://www.raycast.com',
        namePatterns: [/^Raycast( .{1,120})?$/],
    },
    {
        id: 'mcp-inspector',
        name: 'MCP Inspector',
        homepage: 'https://github.com/modelcontextprotocol/inspector',
        // Source: modelcontextprotocol/inspector core/auth/providers.ts — client_name "MCP Inspector".
        namePatterns: [/^MCP Inspector( .{1,120})?$/],
    },
    {
        id: 'mcp-cli-proxy',
        name: 'MCP CLI Proxy',
        homepage: 'https://github.com/modelcontextprotocol/mcp-cli',
        namePatterns: [/^MCP CLI Proxy$/],
    },
    {
        id: 'mcpjam',
        name: 'MCPJam',
        homepage: 'https://www.mcpjam.com',
        namePatterns: [/^MCPJam( .{1,120})?$/],
    },
    {
        id: 'perplexity',
        name: 'Perplexity',
        homepage: 'https://www.perplexity.ai',
        hostedUris: [
            'https://www.perplexity.ai/rest/connections/oauth_callback',
            'https://enterprise.perplexity.ai/rest/connections/oauth_callback',
        ],
    },
    {
        id: 'smithery',
        name: 'Smithery',
        homepage: 'https://smithery.ai',
        hostedUris: ['https://connect.smithery.ai/oauth/callback'],
    },
    {
        id: 'glama',
        name: 'Glama',
        homepage: 'https://glama.ai',
        hostedUris: [
            'https://glama.ai/api/app/mcp/oauth/callback',
            'https://glama.ai/mcp/inspector/oauth/callback',
        ],
        // Glama registers its hosted callback PLUS a loopback one; the name match lets that pass as recognized.
        namePatterns: [/^Glama( MCP Inspector)?$/],
    },
    {
        id: 'n8n',
        name: 'n8n',
        homepage: 'https://n8n.io',
        hostedUris: ['https://oauth.n8n.cloud/oauth2/callback'],
    },
    {
        id: 'microsoft-copilot',
        sharedPlatform: true,
        name: 'Microsoft Copilot',
        homepage: 'https://copilot.microsoft.com',
        hostedUris: [
            'https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect',
            'https://global.consent.azure-apim.net/redirect',
        ],
        hostedPatterns: [
            /^https:\/\/global\.consent\.azure-apim\.net\/redirect\/[A-Za-z0-9-]{1,128}$/,
        ],
    },
    {
        id: 'zapier',
        sharedPlatform: true,
        name: 'Zapier',
        homepage: 'https://zapier.com',
        hostedPatterns: [
            /^https:\/\/zapier\.com\/dashboard\/auth\/oauth\/return\/[A-Za-z0-9]{1,64}\/$/,
        ],
    },
    {
        id: 'mistral',
        name: 'Mistral',
        homepage: 'https://mistral.ai',
        hostedUris: [
            'https://callback.mistral.ai/v1/integrations_auth/oauth2_callback',
        ],
    },
    {
        id: 'grok',
        name: 'Grok',
        homepage: 'https://grok.com',
        hostedUris: ['https://grok.com/connectors-oauth-exchange-code/'],
    },
    {
        id: 'canva',
        sharedPlatform: true,
        name: 'Canva',
        homepage: 'https://www.canva.com',
        hostedUris: ['https://www.canva.com/apps/oauth/authorized'],
    },
    {
        id: 'adobe-express',
        sharedPlatform: true,
        name: 'Adobe Express',
        homepage: 'https://express.adobe.com',
        hostedUris: [
            'https://express.adobe.com/static/oauth-redirect.html',
            'https://new.express.adobe.com/static/oauth-redirect.html',
        ],
    },
    {
        id: 'mcp-market',
        name: 'MCP Market',
        homepage: 'https://mcpmarket.com',
        hostedUris: ['https://mcpmarket.com/auth/mcp/callback'],
    },
]

export type KnownMcpClientMatch =
    | { tier: 'verified'; client: KnownMcpClient }
    | { tier: 'recognized'; client: KnownMcpClient }
    | { tier: 'unverified'; client: null }

/** Loopback http redirect: localhost / 127.0.0.1 / [::1], any port, any path. Never https, never another host. */
export function isLoopbackRedirect(uri: string): boolean {
    return /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?(\/[^\s]*)?$/.test(
        uri,
    )
}

function isHosted(client: KnownMcpClient, uri: string): boolean {
    return (
        (client.hostedUris?.includes(uri) ?? false) ||
        (client.hostedPatterns?.some(p => p.test(uri)) ?? false)
    )
}

/**
 * Decide the display tier from the STORED registration. Exact string matching
 * for every hosted and scheme URI; no normalisation. An empty redirect list is
 * never verified or recognized.
 */
export function matchKnownMcpClient(reg: {
    clientName: string | null | undefined
    redirectUris: readonly string[]
}): KnownMcpClientMatch {
    const uris = reg.redirectUris
    if (uris.length === 0) return { tier: 'unverified', client: null }

    // Tier 1: every URI hosted by ONE vendor. A shared-platform callback
    // (Canva, Zapier, Copilot Studio…) only proves the platform, so it is
    // "recognized", never "verified".
    for (const client of KNOWN_MCP_CLIENTS) {
        if (!client.hostedUris && !client.hostedPatterns) continue
        if (uris.every(u => isHosted(client, u))) {
            return {
                tier: client.sharedPlatform ? 'recognized' : 'verified',
                client,
            }
        }
    }

    // Tier 2: name matches a local client AND every URI is loopback / its scheme / its hosted.
    const name = (reg.clientName ?? '').trim()
    if (name.length > 0 && name.length <= 160) {
        for (const client of KNOWN_MCP_CLIENTS) {
            if (!client.namePatterns?.some(p => p.test(name))) continue
            const ok = uris.every(
                u =>
                    isLoopbackRedirect(u) ||
                    (client.schemeUris?.includes(u) ?? false) ||
                    isHosted(client, u),
            )
            if (ok) return { tier: 'recognized', client }
        }
    }

    return { tier: 'unverified', client: null }
}
