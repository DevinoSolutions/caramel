// src/lib/mcp/tools/defineTool.ts
//
// The ONE shape every Caramel MCP tool is written in. Adding a tool = one
// `defineTool({...})` in a file under src/lib/mcp/tools/ plus its entry in
// registry.ts; the guard (guard.ts) adds scope gating, the confirm flow, the
// audit row and analytics, and the server serves it both as a named tool and
// as an external_* function in Code Mode. Tools never check scopes or tokens
// themselves.
import type { McpTier } from '@/lib/mcp/oauthConfig'
import type { McpPrincipal } from '@/lib/mcp/principal'
import type { z } from 'zod'

export type ToolAnnotations = {
    /** Does not change anything (contract: every read tool). */
    readOnlyHint: boolean
    /** May delete or irreversibly change data. */
    destructiveHint: boolean
    /** Calling twice with the same arguments has no extra effect. */
    idempotentHint: boolean
    /** Touches something outside Caramel's own data (email, a third party). */
    openWorldHint: boolean
}

/** What a tool's code receives besides its parsed arguments. */
export type ToolRunContext = {
    principal: McpPrincipal
}

export type CaramelToolDefinition<
    TInput extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>,
    TOutput = unknown,
> = {
    /** snake_case; also the external_<id> name in Code Mode. */
    id: string
    /** Title Case, shown by directories and clients. */
    title: string
    /** What it does and when to use it. No go-to-the-app phrasing (tests/unit/mcp/banned-phrases.test.ts). */
    description: string
    tier: McpTier
    /**
     * Callable on every connection whatever it was granted: only the tools
     * that explain the grant itself and how to widen it (list_granted_scopes,
     * request_scopes), so a SCOPE_MISSING always has a reachable next step.
     */
    alwaysAvailable?: true
    inputSchema: TInput
    annotations: ToolAnnotations
    /**
     * Present on every destructive tool: the plain sentence the user is
     * shown before confirming ("This deletes your Caramel account ...").
     * The guard refuses the first call with CONFIRMATION_REQUIRED and a
     * confirmToken bound to these exact arguments.
     */
    confirm?: (args: z.infer<TInput>) => string
    /**
     * The API routes (METHOD /path) this tool performs, for the parity test
     * that maps every signed-in route to a tool or a recorded exclusion.
     */
    covers: readonly string[]
    run: (args: z.infer<TInput>, ctx: ToolRunContext) => Promise<TOutput>
}

/** Identity function that keeps the input type for `run` and `confirm`. */
export function defineTool<TInput extends z.ZodObject<z.ZodRawShape>, TOutput>(
    definition: CaramelToolDefinition<TInput, TOutput>,
): CaramelToolDefinition<TInput, TOutput> {
    return definition
}

export const READ: ToolAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
}

export const WRITE: ToolAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
}

export const IDEMPOTENT_WRITE: ToolAnnotations = {
    ...WRITE,
    idempotentHint: true,
}

export const DESTRUCTIVE: ToolAnnotations = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
}
