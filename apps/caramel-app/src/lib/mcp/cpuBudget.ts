// src/lib/mcp/cpuBudget.ts
//
// A Code Mode transport that stops a program the moment it computes for longer
// than a short CPU budget without handing control back to the server.
//
// WHY. `@mastra/quickjs` runs every `execute_typescript` program in an
// in-process QuickJS interpreter, ON THE NODE EVENT LOOP. Its only interrupt is
// the wall-clock deadline (CODE_MODE_TIMEOUT_MS, 30s, in ./codeMode.ts).
// So a program that never awaits — a `while (true) {}`, a runaway sort,
// `for (;;) await null` — holds the event loop for the whole 30s, and every
// other request this process serves (other MCP calls, every page and API
// route of the app) waits behind it. The overall timeout bounds how long
// a program may take; it does nothing to stop one program from starving
// everyone else.
//
// WHAT IS BUDGETED. One SLICE is a stretch of guest execution between two
// returns to the host: everything the interpreter runs from the moment the host
// enters it until the host's call stack unwinds (only awaiting an `external_*`
// call does that for a program). A slice longer than `cpuBudgetMs` is
// interrupted and the whole program ends with `CPU_BUDGET_EXCEEDED`. Time spent
// AWAITING an `external_*` call is not guest execution and is never counted: a
// program may await tools for the full 30s, and may compute for longer than the
// budget in total, as long as no single stretch between awaits exceeds it.
//
// HOW, THROUGH THE PUBLIC API. The transport's `module` option accepts the
// QuickJS WASM module it creates each program's runtime from. This hands it a
// module whose `newRuntime()` returns a runtime with the budget check already
// installed as its interrupt handler; the transport's own handler (the 30s
// deadline and the caller's abort) is composed behind it rather than replacing
// it. QuickJS polls the handler every ~10k bytecode operations, so the check
// runs INSIDE a busy loop — the only place a runaway program can be stopped
// from in-process. The slice starts at the first poll and ends when the host's
// call stack unwinds, which is exactly when a queued microtask gets to run.
//
// On the first overrun the program is interrupted (an uncatchable error in the
// guest — no `catch`/`finally` of the program runs) AND the run is aborted
// through the transport's `abortSignal`, so the result comes back at once
// instead of waiting on guest promises the interrupt left unsettled. Every
// later poll of that program interrupts immediately.
//
// PINNED INTERNALS. Two facts about `@mastra/quickjs` 0.1.5 are relied on, and
// tests/unit/mcp/cpuBudget.test.ts fails loudly if either stops holding:
// every runtime is created through the `module` option's `newRuntime()` inside
// `run()`, and the transport installs its deadline through
// `runtime.setInterruptHandler`. `quickjs-emscripten` is a direct dependency
// for that reason, pinned to the version `@mastra/quickjs` resolves; re-prove
// the budget before bumping either.
//
// Ported from SuperBooks' apps/mastra/src/mcp/code-mode-cpu-budget.ts (itself
// from uptimely#253), where the same wrapper was proven first.

import type { CodeModeToolResult, CodeModeTransport } from '@mastra/core/tools'
import { QuickJsCodeModeTransport } from '@mastra/quickjs'
import { AsyncLocalStorage } from 'node:async_hooks'
import {
    getQuickJS,
    type InterruptHandler,
    type QuickJSRuntime,
    type QuickJSWASMModule,
    type RuntimeOptions,
} from 'quickjs-emscripten'

/** The error-code prefix a program stopped by the budget reports. */
export const CPU_BUDGET_EXCEEDED_CODE = 'CPU_BUDGET_EXCEEDED'

/** Longest stretch a program may compute without awaiting an `external_*`
 *  call. An orchestration program's own work (filtering, mapping, summing tool
 *  results) takes milliseconds; 1.5s is far above that and still short enough
 *  that one runaway program cannot noticeably stall the rest of the process. */
export const DEFAULT_CODE_MODE_CPU_BUDGET_MS = 1_500

type CodeModeRunOptions = Parameters<CodeModeTransport['run']>[0]

interface CpuBudgetedQuickJsTransportOptions {
    /** See DEFAULT_CODE_MODE_CPU_BUDGET_MS. */
    cpuBudgetMs?: number
    /** QuickJS heap limit, passed straight to `QuickJsCodeModeTransport`. */
    memoryLimitMb?: number
}

/** The budget of ONE program: its slices, and whether one overran. */
class ProgramCpuBudget {
    private readonly budgetMs: number
    private readonly abortRun: () => void
    private sliceStartedAt: number | undefined
    private hasExceeded = false

    constructor(budgetMs: number, abortRun: () => void) {
        this.budgetMs = budgetMs
        this.abortRun = abortRun
    }

    get exceeded(): boolean {
        return this.hasExceeded
    }

    /** QuickJS's interrupt poll. `true` interrupts the guest. */
    readonly shouldInterrupt = (): boolean => {
        if (this.hasExceeded) return true
        const now = performance.now()
        if (this.sliceStartedAt === undefined) {
            this.sliceStartedAt = now
            // Runs only once the host's call stack has unwound — i.e. once this
            // slice of guest execution is over.
            queueMicrotask(() => {
                this.sliceStartedAt = undefined
            })
        }
        if (now - this.sliceStartedAt <= this.budgetMs) return false
        this.hasExceeded = true
        this.abortRun()
        return true
    }
}

/** Binds each program's budget to the runtime `run()` creates for it. */
const programBudget = new AsyncLocalStorage<ProgramCpuBudget>()

/** Installs `budget` as the runtime's interrupt handler for good, and turns the
 *  transport's own `setInterruptHandler`/`removeInterruptHandler` calls into
 *  swapping the handler composed behind it. */
function installCpuBudget(
    runtime: QuickJSRuntime,
    budget: ProgramCpuBudget,
): void {
    let transportHandler: InterruptHandler | undefined
    const installHandler = runtime.setInterruptHandler.bind(runtime)
    runtime.setInterruptHandler = (handler: InterruptHandler) => {
        transportHandler = handler
    }
    runtime.removeInterruptHandler = () => {
        transportHandler = undefined
    }
    installHandler(
        rt => budget.shouldInterrupt() || transportHandler?.(rt) === true,
    )
}

/** The module handed to `QuickJsCodeModeTransport`: the real one, except that
 *  every runtime it creates carries the budget of the program creating it. */
function budgetedModule(module: QuickJSWASMModule): QuickJSWASMModule {
    const budgeted = Object.create(module) as QuickJSWASMModule
    budgeted.newRuntime = (options?: RuntimeOptions) => {
        const budget = programBudget.getStore()
        if (!budget) {
            throw new Error(
                `${CPU_BUDGET_EXCEEDED_CODE} guard: a QuickJS runtime was created outside a budgeted run() — @mastra/quickjs no longer creates runtimes the way code-mode-cpu-budget.ts relies on; re-prove the budget before shipping this version`,
            )
        }
        const runtime = module.newRuntime(options)
        installCpuBudget(runtime, budget)
        return runtime
    }
    return budgeted
}

function cpuBudgetExceededResult(
    budgetMs: number,
    logs: string[] | undefined,
): CodeModeToolResult {
    return {
        success: false,
        logs,
        error: {
            name: 'CpuBudgetExceededError',
            message: `${CPU_BUDGET_EXCEEDED_CODE}: the program computed for more than ${budgetMs}ms without awaiting an external_* call, so it was stopped. Keep loops short, and split heavy work across awaited external_* calls or several execute_typescript calls.`,
        },
    }
}

/**
 * `QuickJsCodeModeTransport` plus a per-slice CPU budget. A drop-in
 * replacement: same `run()` contract, same result shape; a program that
 * overruns the budget resolves with `success: false` and an error whose message
 * starts with `CPU_BUDGET_EXCEEDED:`.
 */
export class CpuBudgetedQuickJsTransport implements CodeModeTransport {
    readonly requiresSandbox = false
    private readonly cpuBudgetMs: number
    private readonly memoryLimitMb: number | undefined
    private transport: Promise<QuickJsCodeModeTransport> | undefined

    constructor(options: CpuBudgetedQuickJsTransportOptions = {}) {
        this.cpuBudgetMs =
            options.cpuBudgetMs ?? DEFAULT_CODE_MODE_CPU_BUDGET_MS
        this.memoryLimitMb = options.memoryLimitMb
    }

    /** Loads the WASM module once per transport, on first use. */
    private budgetedTransport(): Promise<QuickJsCodeModeTransport> {
        this.transport ??= getQuickJS().then(
            module =>
                new QuickJsCodeModeTransport({
                    memoryLimitMb: this.memoryLimitMb,
                    module: budgetedModule(module),
                }),
        )
        return this.transport
    }

    async run(opts: CodeModeRunOptions): Promise<CodeModeToolResult> {
        const transport = await this.budgetedTransport()
        const budgetAbort = new AbortController()
        const budget = new ProgramCpuBudget(this.cpuBudgetMs, () =>
            budgetAbort.abort(),
        )
        const abortSignal = opts.abortSignal
            ? AbortSignal.any([opts.abortSignal, budgetAbort.signal])
            : budgetAbort.signal
        const result = await programBudget.run(budget, () =>
            transport.run({ ...opts, abortSignal }),
        )
        return budget.exceeded
            ? cpuBudgetExceededResult(this.cpuBudgetMs, result.logs)
            : result
    }
}
