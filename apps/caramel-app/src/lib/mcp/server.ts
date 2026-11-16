// src/lib/mcp/server.ts
//
// The Caramel MCP server: one @mastra/mcp MCPServer per (surface, granted
// tiers), built on first use and cached for the life of the process.
//
// Surfaces (fleet contract; never change what a published URL serves):
//   - /api/mcp                    Code Mode: search_tools + execute_typescript
//   - /api/mcp?tools=directory    every granted tool by name, for directories
//                                 (OpenAI refuses Code-Mode-only servers in new
//                                 app reviews)
//
// A server only carries the tools its tiers reach, so tools/list never shows
// a tool the connection cannot call.
import { APP_VERSION, BASE_URL } from '@/lib/env.client'
import { MCPServer } from '@mastra/mcp'
import { buildCodeModeTools, CODE_MODE_TIMEOUT_MS } from './codeMode'
import {
    isReachable,
    mastraValidationDenialText,
    type RegisteredTool,
} from './guard'
import type { McpTier } from './oauthConfig'
import { MCP_SERVER_NAME, MCP_TIERS } from './oauthConfig'
import { CARAMEL_TOOLS } from './tools/registry'

export type McpSurface = 'code_mode' | 'directory'

const origin = BASE_URL.replace(/\/+$/, '')

export const MCP_SERVER_ICONS = [
    {
        src: `${origin}/app/ios/512.png`,
        mimeType: 'image/png',
        sizes: ['512x512'],
    },
    { src: `${origin}/caramel.svg`, mimeType: 'image/svg+xml', sizes: ['any'] },
]

export const MCP_PRODUCT_INSTRUCTIONS =
    'Caramel is a free, open-source coupon finder: a catalog of coupon codes for online stores, ranked by whether shoppers recently confirmed they worked, plus the user\'s own Caramel account (saved stores, savings history, settings). Use this server when the user asks for coupon codes, discounts or deals for a store ("any codes for Nike?", "best deal at Walmart"), wants to save or unsave a store, check what they saved with Caramel, change their Caramel settings, submit or rate a code, ask Caramel to support a store, or contact Caramel support. Answer from Caramel data and say when it has no codes for a store. Destructive actions (deleting data, deleting the account, disconnecting) are answered first with CONFIRMATION_REQUIRED and a confirmToken: show the user exactly what will happen and, once they explicitly agree, repeat the call with the same arguments plus the confirmToken in a NEW call.'

const CODE_MODE_INSTRUCTIONS = `${MCP_PRODUCT_INSTRUCTIONS}

This server exposes two tools instead of one per operation:

1. search_tools({ query? }): finds the tools this connection can reach and returns them as "declare function external_<name>(...)" TypeScript signatures, each tagged [read-only], [write], [destructive], [account], [connections] or [support]. Omit query to list everything reachable.
2. execute_typescript({ code }): runs a short TypeScript program in an isolated sandbox that can call the external_* functions search_tools declared; they are already in scope, never import or redeclare them. Use "await Promise.all([...])" for independent calls. The program must "return" its result.

Every external_* call enforces the same scope, confirmation and audit rules as a direct call. A refused call throws an Error inside the program whose message is "<CODE>: <details>", followed by {"next":{"tool":"...","args":{...}}} when another call resolves it: SCOPE_MISSING (next is request_scopes), CONFIRMATION_REQUIRED, VALIDATION_ERROR, NOT_FOUND, CONFLICT, RATE_LIMITED or TOOL_FAILED. A confirmToken is never accepted in the same execute_typescript program that received it: end the program, tell the user exactly what the call will do, and once they confirm make the call in a NEW execute_typescript call. A program is stopped after ${CODE_MODE_TIMEOUT_MS / 1000} seconds, or with "CPU_BUDGET_EXCEEDED: ..." when it computes for more than 1.5 seconds without awaiting an external_* call.`

const DIRECTORY_INSTRUCTIONS = `${MCP_PRODUCT_INSTRUCTIONS}

A refused call answers "<CODE>: <details>", followed by {"next":{"tool":"...","args":{...}}} when another call resolves it: SCOPE_MISSING (next is request_scopes), CONFIRMATION_REQUIRED, VALIDATION_ERROR, NOT_FOUND, CONFLICT, RATE_LIMITED or TOOL_FAILED.`

/** Every tool, wrapped once. */
export function registeredTools(): readonly RegisteredTool[] {
    return CARAMEL_TOOLS
}

const servers = new Map<string, MCPServer>()

/** Canonical tier order, so equal grants share one cached server. */
function canonicalTiers(tiers: readonly McpTier[]): McpTier[] {
    return MCP_TIERS.filter(tier => tiers.includes(tier))
}

function buildServer(surface: McpSurface, tiers: McpTier[]): MCPServer {
    const all = registeredTools()
    const tools =
        surface === 'code_mode'
            ? buildCodeModeTools(all, tiers)
            : Object.fromEntries(
                  all
                      .filter(tool => isReachable(tool, tiers))
                      .map(tool => [tool.id, tool.toMastraTool('named')]),
              )
    return new MCPServer({
        id: surface === 'code_mode' ? 'caramel' : 'caramel-directory',
        name: MCP_SERVER_NAME,
        title: MCP_SERVER_NAME,
        version: APP_VERSION,
        description:
            'Coupon codes for online stores and your Caramel account, from your AI.',
        websiteUrl: origin,
        icons: MCP_SERVER_ICONS,
        instructions:
            surface === 'code_mode'
                ? CODE_MODE_INSTRUCTIONS
                : DIRECTORY_INSTRUCTIONS,
        tools,
        // 2025-era clients (Claude, ChatGPT today) open with `initialize`.
        legacy: 'stateless',
        toolResult: {
            // A named call whose arguments failed Mastra's own schema check
            // answers with the same VALIDATION_ERROR envelope as Code Mode.
            transform: ({ output }) => {
                const text = mastraValidationDenialText(output)
                return text
                    ? { isError: true, content: [{ type: 'text', text }] }
                    : undefined
            },
        },
    })
}

export function mcpServerFor(
    surface: McpSurface,
    tiers: readonly McpTier[],
): MCPServer {
    const canonical = canonicalTiers(tiers)
    const key = `${surface}:${canonical.join(',')}`
    let server = servers.get(key)
    if (!server) {
        server = buildServer(surface, canonical)
        servers.set(key, server)
    }
    return server
}
