// src/lib/mcp/codeMode.ts
//
// Code Mode: the default Caramel MCP surface serves TWO tools instead of one
// per operation (fleet MCP contract, Code Mode):
//
//   search_tools({ query? })      the operations this connection can reach, as
//                                 `declare function external_<id>(...)` stubs
//   execute_typescript({ code })  runs a short program in an in-process
//                                 QuickJS sandbox that calls those functions
//
// Every external_* call runs through the same guard as a named call
// (guard.ts): scope, validation, confirmation, audit. A tool outside the
// granted tiers is not listed by search_tools, and calling it anyway is
// refused with SCOPE_MISSING. A confirmToken handed out inside a program is
// refused inside that same program.
import {
    createCodeModeTool,
    createTool,
    generateStubs,
} from '@mastra/core/tools'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { recordMcpCall } from './audit'
import { CpuBudgetedQuickJsTransport } from './cpuBudget'
import {
    endCodeModeProgram,
    isReachable,
    principalOf,
    registerCodeModeProgram,
    type CodeModeProgram,
    type RegisteredTool,
} from './guard'
import type { McpTier } from './oauthConfig'

export const CODE_MODE_TIMEOUT_MS = 30_000

const codeModeTransport = new CpuBudgetedQuickJsTransport({
    memoryLimitMb: 64,
})

/** The bracket tag search_tools prints before each description. */
export function toolTag(tool: RegisteredTool): string {
    if (tool.annotations.destructiveHint) return 'destructive'
    if (tool.annotations.readOnlyHint) return 'read-only'
    return tool.tier === 'write' ? 'write' : tool.tier
}

function annotatedDescription(tool: RegisteredTool): string {
    return `${tool.title} [${toolTag(tool)}] ${tool.description}`
}

/**
 * The tools a query names: ids separated by spaces pick exactly those;
 * anything else is matched as words against id, title and description, best
 * match first. No query = everything.
 */
export function selectTools(
    tools: readonly RegisteredTool[],
    query: string | undefined,
): RegisteredTool[] {
    const words = (query ?? '')
        .toLowerCase()
        .split(/[\s,]+/)
        .filter(word => word.length > 0)
    if (words.length === 0) return [...tools]
    const byId = new Map(tools.map(tool => [tool.id, tool]))
    if (words.every(word => byId.has(word))) {
        return words.flatMap(word => {
            const tool = byId.get(word)
            return tool ? [tool] : []
        })
    }
    const scored = tools
        .map(tool => {
            const haystack =
                `${tool.id} ${tool.title} ${tool.description}`.toLowerCase()
            const score = words.filter(word => haystack.includes(word)).length
            return { tool, score }
        })
        .filter(entry => entry.score > 0)
    scored.sort((a, b) => b.score - a.score)
    return scored.map(entry => entry.tool)
}

const SEARCH_TOOLS_ANNOTATIONS = {
    title: 'Search Tools',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
}

const EXECUTE_TYPESCRIPT_ANNOTATIONS = {
    title: 'Execute TypeScript',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
}

type ToolContextLike = { requestContext?: { get(key: string): unknown } }

export function buildCodeModeTools(
    allTools: readonly RegisteredTool[],
    grantedTiers: readonly McpTier[],
) {
    const reachable = allTools.filter(tool => isReachable(tool, grantedTiers))
    // Stubs are generated from clones whose description carries title + tag.
    const stubSources = Object.fromEntries(
        reachable.map(tool => {
            const mastraTool = tool.toMastraTool('code_mode_external')
            mastraTool.description = annotatedDescription(tool)
            return [tool.id, mastraTool]
        }),
    )
    const stubs = generateStubs(stubSources)
    const stubById = new Map(stubs.map(stub => [stub.toolId, stub]))

    const searchTools = createTool({
        id: 'search_tools',
        description:
            'Find the Caramel operations this connection can use (coupon and store search, the user\'s account, settings, saved stores, support), as typed external_<id> TypeScript declarations for execute_typescript. Call it first. Filter with { query }: a word ("coupon"), or tool ids separated by spaces ("search_coupons get_store_deals").',
        inputSchema: z.object({
            query: z
                .string()
                .max(200)
                .optional()
                .describe(
                    'Words or tool ids separated by spaces. Omit to list every reachable tool.',
                ),
        }),
        mcp: { annotations: SEARCH_TOOLS_ANNOTATIONS },
        execute: async ({ query }) => ({
            tools: selectTools(reachable, query).flatMap(tool => {
                const stub = stubById.get(tool.id)
                return stub
                    ? [
                          {
                              id: tool.id,
                              external_name: `external_${stub.externalName}`,
                              declaration: stub.declaration,
                          },
                      ]
                    : []
            }),
        }),
    })

    // Every tool is callable from a program; the guard refuses the ones
    // outside the granted tiers with SCOPE_MISSING.
    const callable = Object.fromEntries(
        allTools.map(tool => [
            tool.id,
            tool.toMastraTool('code_mode_external'),
        ]),
    )
    const inner = createCodeModeTool(
        { tools: callable, timeout: CODE_MODE_TIMEOUT_MS },
        codeModeTransport,
    )
    const innerExecute = inner.execute
    if (!innerExecute) {
        throw new Error('Mastra Code Mode tool has no execute function')
    }
    const executeTypescript = Object.assign(
        Object.create(Object.getPrototypeOf(inner) as object) as typeof inner,
        inner,
    )
    executeTypescript.description = `Run a short TypeScript program that calls the external_* functions search_tools declared (already in scope; never import or redeclare them). Batch independent calls with Promise.all and \`return\` the result. A refused call throws "<CODE>: <details>" with any next step as trailing JSON. A program is stopped after ${CODE_MODE_TIMEOUT_MS / 1000} seconds, or with CPU_BUDGET_EXCEEDED when it computes for more than 1.5 seconds without awaiting an external_* call.`
    executeTypescript.mcp = {
        ...inner.mcp,
        annotations: EXECUTE_TYPESCRIPT_ANNOTATIONS,
    }
    executeTypescript.execute = async (input, context) => {
        if (!context) {
            throw new Error('execute_typescript ran without a tool context')
        }
        const startedAt = Date.now()
        const requestContext = (context as ToolContextLike).requestContext
        const program: CodeModeProgram = {
            externalCallCount: 0,
            confirmNoncesIssued: new Set<string>(),
        }
        if (requestContext) registerCodeModeProgram(requestContext, program)
        let outcome: 'ok' | 'refused' | 'error' = 'error'
        let errorCode: string | null = null
        try {
            const result: unknown = await innerExecute.call(
                inner,
                input,
                context,
            )
            const failure = programFailureCode(result)
            outcome = failure ? 'refused' : 'ok'
            errorCode = failure
            return result
        } finally {
            if (requestContext) endCodeModeProgram(requestContext)
            const principal = principalOf(context as ToolContextLike)
            if (principal) {
                await recordMcpCall({
                    principal,
                    tool: 'execute_typescript',
                    tier: 'code_mode',
                    argsHash: createHash('sha256')
                        .update(
                            typeof (input as { code?: unknown })?.code ===
                                'string'
                                ? (input as { code: string }).code
                                : '',
                        )
                        .digest('hex'),
                    confirmNonce: null,
                    outcome,
                    errorCode,
                    durationMs: Date.now() - startedAt,
                    surface: 'code_mode',
                    writesAudit: false,
                    externalCallCount: program.externalCallCount,
                })
            }
        }
    }

    return { search_tools: searchTools, execute_typescript: executeTypescript }
}

const PROGRAM_FAILURE_CODE = /^(?:[A-Za-z]*Error: )?([A-Z][A-Z0-9_]{2,63}): /

/** The CODE of a program that failed, PROGRAM_FAILED for an uncoded failure. */
function programFailureCode(result: unknown): string | null {
    if (!result || typeof result !== 'object') return null
    const { success, error } = result as {
        success?: unknown
        error?: { message?: unknown }
    }
    if (success !== false) return null
    const message = typeof error?.message === 'string' ? error.message : ''
    return PROGRAM_FAILURE_CODE.exec(message)?.[1] ?? 'PROGRAM_FAILED'
}
