// src/lib/mcp/audit.ts
//
// What every MCP tool call leaves behind (fleet MCP contract section 9):
//
//   - an mcp_tool_calls row for every call that changes something or was
//     refused: who (user, AI client), which tool and tier, a SHA-256 of the
//     arguments (never the arguments), the confirm nonce spent, the outcome.
//     Rows older than 90 days are pruned;
//   - one `mcp_tool_call` analytics event per call, privacy-safe: ids, the
//     tool, its tier, the outcome and error code, the duration and the call
//     surface. No arguments, results, messages or store names.
//
// Both are awaited and checked: an audit insert that fails is reported to
// Sentry and does not undo a call that already happened.
import { captureServerEvent } from '@/lib/analytics/posthogServer'
import prisma from '@/lib/prisma'
import * as Sentry from '@sentry/nextjs'
import type { McpTier } from './oauthConfig'
import type { McpPrincipal } from './principal'

export const MCP_AUDIT_RETENTION_DAYS = 90
const PRUNE_INTERVAL_MS = 60 * 60_000

export type McpCallRecord = {
    principal: McpPrincipal
    tool: string
    tier: McpTier | 'code_mode'
    argsHash: string
    confirmNonce: string | null
    outcome: 'ok' | 'refused' | 'error'
    errorCode: string | null
    durationMs: number
    surface: 'named' | 'code_mode_external' | 'code_mode'
    /** False for a successful read: it changes nothing and is not audited. */
    writesAudit: boolean
    /** For execute_typescript: how many external_* calls the program made. */
    externalCallCount?: number
}

let lastPruneAt = 0
async function pruneExpiredAuditRows(now: number): Promise<void> {
    if (now - lastPruneAt < PRUNE_INTERVAL_MS) return
    lastPruneAt = now
    const cutoff = new Date(now - MCP_AUDIT_RETENTION_DAYS * 24 * 60 * 60_000)
    await prisma.mcpToolCall.deleteMany({
        where: { createdAt: { lt: cutoff } },
    })
}

async function writeAuditRow(record: McpCallRecord): Promise<void> {
    try {
        await prisma.mcpToolCall.create({
            data: {
                userId: record.principal.userId,
                clientId: record.principal.clientId,
                tool: record.tool,
                tier: record.tier,
                argsHash: record.argsHash,
                confirmNonce: record.confirmNonce,
                ok: record.outcome === 'ok',
                error: record.errorCode,
            },
        })
        await pruneExpiredAuditRows(Date.now())
    } catch (error) {
        Sentry.captureException(error, {
            tags: { surface: 'mcp-audit', tool: record.tool },
        })
    }
}

export async function recordMcpCall(record: McpCallRecord): Promise<void> {
    await Promise.all([
        record.writesAudit ? writeAuditRow(record) : Promise.resolve(),
        captureServerEvent({
            event: 'mcp_tool_call',
            distinctId: record.principal.userId,
            properties: {
                tool: record.tool,
                tier: record.tier,
                outcome: record.outcome,
                error_code: record.errorCode,
                duration_ms: record.durationMs,
                surface: record.surface,
                oauth_client_id: record.principal.clientId,
                ...(record.externalCallCount !== undefined
                    ? { external_call_count: record.externalCallCount }
                    : {}),
            },
        }),
    ])
}
