// src/lib/mcp/guard.ts
//
// Turns a Caramel tool definition (tools/defineTool.ts) into the Mastra tool
// the MCP server serves, adding everything a tool must not do for itself:
//
//   1. principal: the verified caller (principal.ts), carried in the request
//      context as authInfo.extra.principal by the /api/mcp route;
//   2. scope: a tool whose tier the connection was not granted is refused
//      with SCOPE_MISSING and next = request_scopes, before its arguments are
//      even read;
//   3. arguments: parsed with the tool's zod schema; a failure is
//      VALIDATION_ERROR naming each field and the rule it broke;
//   4. confirmation: a tool with `confirm` is refused the first time with
//      CONFIRMATION_REQUIRED and a confirmToken bound to these exact
//      arguments; a token is refused in the same execute_typescript program
//      that was handed it (the user must see the action first);
//   5. the call, with McpDenialError mapped to its envelope and anything else
//      to TOOL_FAILED (reported to Sentry; internals never reach the client);
//   6. audit (mcp_tool_calls, argument hash only) for every non-read call and
//      every refusal, and one privacy-safe analytics event per call.
//
// Every refusal is RETURNED as a denial result (denial.ts), never thrown:
// @mastra/mcp answers it with `isError: true` and the envelope text, and
// Code Mode rethrows it inside the program with the same message.
import { createTool } from '@mastra/core/tools'
import * as Sentry from '@sentry/nextjs'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { recordMcpCall } from './audit'
import {
    confirmTokenNonce,
    consumeConfirmToken,
    issueConfirmToken,
    stableStringify,
} from './confirmToken'
import {
    denialResult,
    McpDenialError,
    type Denial,
    type DenialResult,
} from './denial'
import type { McpTier } from './oauthConfig'
import type { McpPrincipal } from './principal'
import type { CaramelToolDefinition, ToolAnnotations } from './tools/defineTool'

export const PRINCIPAL_EXTRA_KEY = 'principal'

/** How a call reached the tool, for analytics. */
export type CallSurface = 'named' | 'code_mode_external'

/** The request context surface Mastra hands a tool. */
type ToolContextLike = {
    requestContext?: { get(key: string): unknown }
}

/** One running execute_typescript program (codeMode.ts registers it). */
export type CodeModeProgram = {
    externalCallCount: number
    /** Nonces of every confirmToken a refusal handed this program. */
    confirmNoncesIssued: Set<string>
}

const codeModePrograms = new WeakMap<object, CodeModeProgram>()

export function registerCodeModeProgram(
    requestContext: object,
    program: CodeModeProgram,
): void {
    codeModePrograms.set(requestContext, program)
}

export function endCodeModeProgram(requestContext: object): void {
    codeModePrograms.delete(requestContext)
}

function programOf(context: ToolContextLike | undefined) {
    const rc = context?.requestContext
    return rc ? codeModePrograms.get(rc) : undefined
}

export const SAME_RUN_CONFIRM_MESSAGE =
    'This confirmToken was issued earlier in this same execute_typescript program, so it cannot confirm the action here. End this program, tell the user exactly what the call will do, and once they explicitly confirm, make the same call with this confirmToken in a NEW execute_typescript call.'

/** The verified caller of the current MCP request, or undefined. */
export function principalOf(
    context: ToolContextLike | undefined,
): McpPrincipal | undefined {
    const authInfo = context?.requestContext?.get('authInfo') as
        { extra?: Record<string, unknown> } | undefined
    const principal = authInfo?.extra?.[PRINCIPAL_EXTRA_KEY]
    return principal && typeof principal === 'object'
        ? (principal as McpPrincipal)
        : undefined
}

/** A tool as the server, the tests and the server card see it. */
export type RegisteredTool = {
    id: string
    title: string
    description: string
    tier: McpTier
    /** Reachable on every grant (defineTool.ts `alwaysAvailable`). */
    alwaysAvailable: boolean
    annotations: ToolAnnotations
    covers: readonly string[]
    /** True when the tool asks for a confirmToken. */
    confirms: boolean
    /** The JSON-ready Mastra tool for one call surface. */
    toMastraTool: (surface: CallSurface) => ReturnType<typeof createTool>
}

/** Whether a connection holding `tiers` may call this tool. */
export function isReachable(
    tool: { tier: McpTier; alwaysAvailable?: boolean },
    tiers: readonly McpTier[],
): boolean {
    return tool.alwaysAvailable === true || tiers.includes(tool.tier)
}

function argsHashOf(args: Record<string, unknown>): string {
    return createHash('sha256').update(stableStringify(args)).digest('hex')
}

function validationDetails(error: z.ZodError): string {
    return error.issues
        .map(issue => {
            const path = issue.path.length > 0 ? issue.path.join('.') : 'input'
            return `${path}: ${issue.message}`
        })
        .join('; ')
}

function scopeMissing(tier: McpTier): Denial {
    return {
        code: 'SCOPE_MISSING',
        details: `This connection was not granted the "${tier}" permission this tool needs.`,
        next: { tool: 'request_scopes', args: { tiers: [tier] } },
    }
}

const confirmTokenArg = z
    .string()
    .optional()
    .describe(
        'Leave out on the first call. Caramel answers CONFIRMATION_REQUIRED with a confirmToken; show the user what will happen and, once they agree, call again with the same arguments plus that token.',
    )

/** Wrap one definition. Generic, so the definition keeps its own types. */
export function registerTool<
    TInput extends z.ZodObject<z.ZodRawShape>,
    TOutput,
>(def: CaramelToolDefinition<TInput, TOutput>): RegisteredTool {
    const confirms = Boolean(def.confirm)
    const wireSchema = confirms
        ? def.inputSchema.extend({ confirmToken: confirmTokenArg })
        : def.inputSchema

    async function invoke(
        rawInput: unknown,
        context: ToolContextLike | undefined,
        surface: CallSurface,
    ): Promise<TOutput | DenialResult> {
        const startedAt = Date.now()
        const principal = principalOf(context)
        if (!principal) {
            // The route always sets it; reaching here is a wiring bug.
            const error = new Error(
                `MCP tool ${def.id} ran without a verified principal`,
            )
            Sentry.captureException(error)
            return denialResult({
                code: 'TOOL_FAILED',
                details: 'The request was not authenticated.',
            })
        }
        const program =
            surface === 'code_mode_external' ? programOf(context) : undefined
        if (program) program.externalCallCount += 1

        const rawRecord =
            rawInput && typeof rawInput === 'object'
                ? (rawInput as Record<string, unknown>)
                : {}
        const { confirmToken: rawToken, ...argsWithoutToken } = rawRecord
        const argsHash = argsHashOf(argsWithoutToken)

        const finish = async (
            outcome: 'ok' | 'refused' | 'error',
            denial: Denial | null,
            confirmNonce: string | null,
        ) => {
            await recordMcpCall({
                principal,
                tool: def.id,
                tier: def.tier,
                argsHash,
                confirmNonce,
                outcome,
                errorCode: denial?.code ?? null,
                durationMs: Date.now() - startedAt,
                surface,
                writesAudit: def.tier !== 'read' || outcome !== 'ok',
            })
        }

        if (!isReachable(def, principal.tiers)) {
            const denial = scopeMissing(def.tier)
            await finish('refused', denial, null)
            return denialResult(denial)
        }

        const parsed = def.inputSchema.safeParse(argsWithoutToken)
        if (!parsed.success) {
            const denial: Denial = {
                code: 'VALIDATION_ERROR',
                details: validationDetails(parsed.error),
            }
            await finish('refused', denial, null)
            return denialResult(denial)
        }
        const args = parsed.data

        let confirmNonce: string | null = null
        try {
            if (def.confirm) {
                const binding = {
                    userId: principal.userId,
                    clientId: principal.clientId,
                    tool: def.id,
                    args: argsWithoutToken,
                }
                if (typeof rawToken !== 'string' || rawToken.length === 0) {
                    const confirmToken = issueConfirmToken(binding)
                    const nonce = confirmTokenNonce(confirmToken)
                    if (program && nonce) program.confirmNoncesIssued.add(nonce)
                    throw new McpDenialError({
                        code: 'CONFIRMATION_REQUIRED',
                        details: `${def.confirm(args)} Show this to the user; once they explicitly agree, call ${def.id} again with the same arguments plus this confirmToken (valid 10 minutes, once).`,
                        next: {
                            tool: def.id,
                            args: { ...argsWithoutToken, confirmToken },
                        },
                    })
                }
                const nonce = confirmTokenNonce(rawToken)
                if (
                    program &&
                    nonce &&
                    program.confirmNoncesIssued.has(nonce)
                ) {
                    throw new McpDenialError({
                        code: 'CONFIRMATION_REQUIRED',
                        details: SAME_RUN_CONFIRM_MESSAGE,
                        next: {
                            tool: def.id,
                            args: {
                                ...argsWithoutToken,
                                confirmToken: rawToken,
                            },
                        },
                    })
                }
                confirmNonce = await consumeConfirmToken(rawToken, binding)
            }

            const output = await def.run(args, { principal })
            await finish('ok', null, confirmNonce)
            return output
        } catch (error) {
            if (error instanceof McpDenialError) {
                await finish('refused', error.denial, confirmNonce)
                return denialResult(error.denial)
            }
            Sentry.captureException(error, {
                tags: { surface: 'mcp-tool', tool: def.id },
            })
            const denial: Denial = {
                code: 'TOOL_FAILED',
                details:
                    'Caramel could not complete this call. Try again in a moment.',
            }
            await finish('error', denial, confirmNonce)
            return denialResult(denial)
        }
    }

    return {
        id: def.id,
        title: def.title,
        description: def.description,
        tier: def.tier,
        alwaysAvailable: def.alwaysAvailable === true,
        annotations: def.annotations,
        covers: def.covers,
        confirms,
        toMastraTool: surface => {
            const tool = createTool({
                id: def.id,
                description: def.description,
                inputSchema: wireSchema,
                mcp: {
                    annotations: { title: def.title, ...def.annotations },
                },
                execute: async (input, context) =>
                    invoke(input, context, surface),
            })
            if (surface === 'named') return tool
            // Code Mode's dispatcher calls `execute` on exactly this object.
            // createTool's execute validates first and answers with Mastra's
            // own message; going straight to `invoke` keeps the scope check
            // ahead of validation and the VALIDATION_ERROR envelope intact
            // (invoke parses with the same schema).
            const direct = Object.assign(
                Object.create(
                    Object.getPrototypeOf(tool) as object,
                ) as typeof tool,
                tool,
            )
            direct.execute = async (input, context) =>
                invoke(input, context, surface)
            return direct
        },
    }
}

/** @mastra/core's FormattedValidationErrors node. */
type FormattedErrors = { errors?: unknown; fields?: unknown }

function collectFormattedErrors(
    node: unknown,
    path: string[],
    out: string[],
): void {
    if (!node || typeof node !== 'object') return
    const { errors, fields } = node as FormattedErrors
    if (Array.isArray(errors)) {
        for (const message of errors) {
            if (typeof message === 'string') {
                out.push(
                    `${path.length > 0 ? path.join('.') : 'input'}: ${message}`,
                )
            }
        }
    }
    if (fields && typeof fields === 'object') {
        for (const [key, child] of Object.entries(fields)) {
            collectFormattedErrors(child, [...path, key], out)
        }
    }
}

/**
 * The VALIDATION_ERROR text for a validation failure Mastra produced before
 * a named tool ran (its own schema check), or null for any other output. Used
 * by the server's toolResult.transform so a direct call and a Code Mode call
 * refuse bad arguments with the same envelope.
 */
export function mastraValidationDenialText(output: unknown): string | null {
    if (!output || typeof output !== 'object') return null
    const record = output as {
        error?: unknown
        validationErrors?: unknown
        denial?: unknown
    }
    if (record.error !== true || record.denial !== undefined) return null
    if (!('validationErrors' in record)) return null
    const clauses: string[] = []
    collectFormattedErrors(record.validationErrors, [], clauses)
    return `VALIDATION_ERROR: ${clauses.length > 0 ? clauses.join('; ') : 'the arguments do not match this tool.'}`
}
