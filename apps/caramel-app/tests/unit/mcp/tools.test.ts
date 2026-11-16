import { describe, expect, it, vi } from 'vitest'

// Every Caramel MCP tool, run through the guard exactly as the server runs it
// (src/lib/mcp/guard.ts): the scope gate refuses each tool without its tier
// and names request_scopes as the way on; every destructive tool refuses its
// first call with CONFIRMATION_REQUIRED and a token bound to those arguments;
// a token never confirms inside the Code Mode program that received it; bad
// arguments answer VALIDATION_ERROR naming the field. A synthetic tool proves
// the confirmed call then runs exactly once.
//
// Nothing here reaches a route: every assertion is a refusal the guard makes
// before the tool's own code runs (prisma is mocked for the confirm nonce).

const { auditMock, nonceCreate } = vi.hoisted(() => ({
    auditMock: vi.fn(async () => undefined),
    nonceCreate: vi.fn(async () => ({})),
}))
vi.mock('@/lib/mcp/audit', () => ({ recordMcpCall: auditMock }))
vi.mock('@/lib/prisma', () => ({
    default: {
        mcpConfirmNonce: {
            create: nonceCreate,
            deleteMany: vi.fn(async () => ({ count: 0 })),
        },
    },
}))

import {
    mastraValidationDenialText,
    PRINCIPAL_EXTRA_KEY,
    registerCodeModeProgram,
    registerTool,
    SAME_RUN_CONFIRM_MESSAGE,
    type RegisteredTool,
} from '@/lib/mcp/guard'
import { MCP_TIERS, type McpTier } from '@/lib/mcp/oauthConfig'
import type { McpPrincipal } from '@/lib/mcp/principal'
import { defineTool, DESTRUCTIVE, READ } from '@/lib/mcp/tools/defineTool'
import { CARAMEL_TOOLS } from '@/lib/mcp/tools/registry'
import { z } from 'zod'

type Denied = {
    error: true
    message: string
    denial: {
        code: string
        details: string
        next?: { tool: string; args: Record<string, unknown> }
    }
}

function principal(tiers: readonly McpTier[]): McpPrincipal {
    return {
        userId: 'user-1',
        clientId: 'client-1',
        scopes: [],
        tiers,
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        session: {} as McpPrincipal['session'],
    }
}

function contextFor(tiers: readonly McpTier[]) {
    const authInfo = { extra: { [PRINCIPAL_EXTRA_KEY]: principal(tiers) } }
    const requestContext = {
        get: (key: string) => (key === 'authInfo' ? authInfo : undefined),
    }
    return { requestContext }
}

async function call(
    tool: RegisteredTool,
    input: Record<string, unknown>,
    context: ReturnType<typeof contextFor>,
): Promise<unknown> {
    const mastraTool = tool.toMastraTool('code_mode_external')
    if (!mastraTool.execute) throw new Error(`${tool.id} has no execute`)
    return mastraTool.execute(input, context as never)
}

function asDenied(result: unknown): Denied {
    expect(result).toMatchObject({ error: true })
    return result as Denied
}

const allTiers = [...MCP_TIERS]

describe('Caramel MCP tools: scope gate', () => {
    it.each(CARAMEL_TOOLS.map(tool => [tool.id, tool] as const))(
        '%s is refused with SCOPE_MISSING without its tier',
        async (_id, tool) => {
            const others = allTiers.filter(tier => tier !== tool.tier)
            const result = await call(tool, {}, contextFor(others))
            if (tool.alwaysAvailable) {
                // The grant's own explainers stay reachable on any grant.
                expect((result as Partial<Denied>).denial?.code).not.toBe(
                    'SCOPE_MISSING',
                )
                return
            }
            const denied = asDenied(result)
            expect(denied.denial.code).toBe('SCOPE_MISSING')
            expect(denied.denial.next).toEqual({
                tool: 'request_scopes',
                args: { tiers: [tool.tier] },
            })
            expect(denied.message.startsWith('SCOPE_MISSING: ')).toBe(true)
        },
    )

    it('every tool names exactly one known tier and an annotation set', () => {
        for (const tool of CARAMEL_TOOLS) {
            expect(MCP_TIERS).toContain(tool.tier)
            if (tool.tier === 'read') {
                expect(tool.annotations.readOnlyHint).toBe(true)
            }
            if (tool.tier === 'write' || tool.tier === 'destructive') {
                expect(tool.annotations.readOnlyHint).toBe(false)
            }
        }
    })

    it('tool ids are unique snake_case', () => {
        const ids = CARAMEL_TOOLS.map(tool => tool.id)
        expect(new Set(ids).size).toBe(ids.length)
        for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9_]*$/)
    })
})

describe('Caramel MCP tools: confirmation', () => {
    const confirming = CARAMEL_TOOLS.filter(tool => tool.confirms)

    it('every destructive tool asks for confirmation, and only those', () => {
        for (const tool of CARAMEL_TOOLS) {
            expect(tool.confirms).toBe(tool.annotations.destructiveHint)
        }
        expect(confirming.map(tool => tool.id).sort()).toEqual([
            'delete_account',
            'delete_my_data',
            'disconnect',
        ])
    })

    it.each(confirming.map(tool => [tool.id, tool] as const))(
        '%s answers its first call with CONFIRMATION_REQUIRED and a bound token',
        async (_id, tool) => {
            const denied = asDenied(await call(tool, {}, contextFor(allTiers)))
            expect(denied.denial.code).toBe('CONFIRMATION_REQUIRED')
            expect(denied.denial.next?.tool).toBe(tool.id)
            expect(denied.denial.next?.args.confirmToken).toMatch(
                /^\d+\.[0-9a-f]{32}\.[0-9a-f]{64}$/,
            )
            // No URLs inside a denial (fleet contract).
            expect(denied.message).not.toMatch(/https?:\/\//)
        },
    )

    it('disconnect refuses a token issued for other arguments', async () => {
        const tool = confirming.find(t => t.id === 'disconnect')
        if (!tool) throw new Error('disconnect is missing')
        const ctx = contextFor(allTiers)
        const first = asDenied(await call(tool, { clientId: 'a' }, ctx))
        const token = first.denial.next?.args.confirmToken
        const replay = asDenied(
            await call(tool, { clientId: 'b', confirmToken: token }, ctx),
        )
        expect(replay.denial.code).toBe('CONFIRMATION_REQUIRED')
    })

    it.each(confirming.map(tool => [tool.id, tool] as const))(
        '%s never accepts a token inside the program that received it',
        async (_id, tool) => {
            const ctx = contextFor(allTiers)
            registerCodeModeProgram(ctx.requestContext, {
                externalCallCount: 0,
                confirmNoncesIssued: new Set(),
            })
            const first = asDenied(await call(tool, {}, ctx))
            const token = first.denial.next?.args.confirmToken
            const again = asDenied(
                await call(tool, { confirmToken: token }, ctx),
            )
            expect(again.denial.code).toBe('CONFIRMATION_REQUIRED')
            expect(again.denial.details).toBe(SAME_RUN_CONFIRM_MESSAGE)
        },
    )
})

describe('the guard around a tool body', () => {
    const run = vi.fn(async (args: { label: string }) => ({ ran: args.label }))
    const probe = registerTool(
        defineTool({
            id: 'probe_delete',
            title: 'Probe Delete',
            description: 'Test-only destructive probe.',
            tier: 'destructive',
            inputSchema: z.object({ label: z.string().min(2) }),
            annotations: DESTRUCTIVE,
            confirm: args => `This deletes ${args.label}.`,
            covers: [],
            run,
        }),
    )
    const reader = registerTool(
        defineTool({
            id: 'probe_read',
            title: 'Probe Read',
            description: 'Test-only read probe.',
            tier: 'read',
            inputSchema: z.object({ count: z.number().int() }),
            annotations: READ,
            covers: [],
            run: async ({ count }) => ({ count }),
        }),
    )

    it('runs a confirmed call once, and the same token is spent after that', async () => {
        const ctx = contextFor(allTiers)
        const first = asDenied(await call(probe, { label: 'xy' }, ctx))
        expect(first.denial.details).toContain('This deletes xy.')
        const token = first.denial.next?.args.confirmToken
        expect(run).not.toHaveBeenCalled()

        const ok = await call(probe, { label: 'xy', confirmToken: token }, ctx)
        expect(ok).toEqual({ ran: 'xy' })
        expect(run).toHaveBeenCalledTimes(1)

        nonceCreate.mockRejectedValueOnce(
            Object.assign(new Error('unique'), { code: 'P2002' }),
        )
        const spent = asDenied(
            await call(probe, { label: 'xy', confirmToken: token }, ctx),
        )
        expect(spent.denial.code).toBe('CONFIRMATION_REQUIRED')
        expect(run).toHaveBeenCalledTimes(1)
    })

    it('names the field and the rule a bad argument broke', async () => {
        const denied = asDenied(
            await call(reader, { count: 'many' }, contextFor(['read'])),
        )
        expect(denied.denial.code).toBe('VALIDATION_ERROR')
        expect(denied.message).toMatch(/^VALIDATION_ERROR: count: /)
    })

    it('checks scope before it reads the arguments', async () => {
        const denied = asDenied(
            await call(reader, { count: 'many' }, contextFor(['write'])),
        )
        expect(denied.denial.code).toBe('SCOPE_MISSING')
    })

    it('records one audit/analytics call per invocation', async () => {
        auditMock.mockClear()
        await call(reader, { count: 1 }, contextFor(['read']))
        expect(auditMock).toHaveBeenCalledTimes(1)
        expect(auditMock).toHaveBeenCalledWith(
            expect.objectContaining({
                tool: 'probe_read',
                outcome: 'ok',
                writesAudit: false,
                surface: 'code_mode_external',
            }),
        )
    })

    it('rewrites a Mastra schema refusal into the VALIDATION_ERROR envelope', () => {
        expect(
            mastraValidationDenialText({
                error: true,
                message: 'Tool validation failed',
                validationErrors: {
                    errors: [],
                    fields: {
                        count: { errors: ['Expected number'], fields: {} },
                    },
                },
            }),
        ).toBe('VALIDATION_ERROR: count: Expected number')
        expect(mastraValidationDenialText({ ok: true })).toBeNull()
    })
})
