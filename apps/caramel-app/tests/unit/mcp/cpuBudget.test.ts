import { describe, expect, it } from 'vitest'

// CpuBudgetedQuickJsTransport (src/lib/mcp/cpuBudget.ts) on the REAL QuickJS
// interpreter, nothing mocked. The dispatcher stands in for the tool map
// createCodeModeTool passes, and says so by name: external_wait resolves after
// real timer time. A program that computes without awaiting is stopped with
// CPU_BUDGET_EXCEEDED soon after the budget (not the 30 s deadline); time spent
// awaiting external calls never counts; the next program runs normally.
import {
    CPU_BUDGET_EXCEEDED_CODE,
    CpuBudgetedQuickJsTransport,
} from '@/lib/mcp/cpuBudget'

const BUDGET_ERROR = new RegExp(`^${CPU_BUDGET_EXCEEDED_CODE}: `)

function waitingDispatcher(_tool: string, args: unknown): Promise<unknown> {
    const { ms, value } = args as { ms: number; value: unknown }
    return new Promise(resolve => setTimeout(() => resolve(value), ms))
}

function run(transport: CpuBudgetedQuickJsTransport, program: string) {
    return transport.run({
        program,
        toolIds: ['wait'],
        dispatch: waitingDispatcher,
        timeout: 20_000,
    })
}

describe('the Code Mode CPU budget', () => {
    const transport = new CpuBudgetedQuickJsTransport({ cpuBudgetMs: 300 })

    it('stops while (true) {} shortly after the budget', async () => {
        const startedAt = performance.now()
        const result = await run(transport, 'while (true) {}')
        const elapsed = performance.now() - startedAt
        expect(result.success).toBe(false)
        expect(result.error?.message).toMatch(BUDGET_ERROR)
        expect(elapsed).toBeLessThan(300 + 3_000)
    }, 15_000)

    it('never counts time spent awaiting external calls', async () => {
        const result = await run(
            transport,
            `let total = 0
for (let i = 0; i < 4; i++) total += await external_wait({ ms: 150, value: 1 })
return total`,
        )
        expect(result).toMatchObject({ success: true, result: 4 })
    }, 15_000)

    it('runs the next program normally after one was stopped', async () => {
        await run(transport, 'while (true) {}')
        const result = await run(transport, 'return 1 + 1')
        expect(result).toMatchObject({ success: true, result: 2 })
    }, 15_000)
})
