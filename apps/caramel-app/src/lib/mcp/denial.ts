// src/lib/mcp/denial.ts
//
// The fleet MCP denial envelope (MCP parity contract section 4): every refused
// tool call answers with ONE text line
//
//     <CODE>: <details> {"next":{"tool":"<tool>","args":{...}}}
//
// where the trailing JSON is present only when there is a call that resolves
// the refusal. A direct tools/call gets it as an `isError` result; inside
// execute_typescript the same text is the message of the Error the external_*
// call throws. The details never contain a URL and never send the user
// somewhere else to finish the job (banned-phrases test).

export const DENIAL_CODES = [
    'SCOPE_MISSING',
    'CONFIRMATION_REQUIRED',
    'VALIDATION_ERROR',
    'NOT_FOUND',
    'CONFLICT',
    'RATE_LIMITED',
    'TOOL_FAILED',
] as const
export type DenialCode = (typeof DENIAL_CODES)[number]

export type DenialNext = {
    tool: string
    args: Record<string, unknown>
}

export type Denial = {
    code: DenialCode
    details: string
    next?: DenialNext
}

/** The single-line wire text of a denial. */
export function denialText(denial: Denial): string {
    const head = `${denial.code}: ${denial.details}`
    return denial.next
        ? `${head} ${JSON.stringify({ next: denial.next })}`
        : head
}

/**
 * A denial as a returned tool value. @mastra/mcp answers any value of this
 * shape (Mastra's validation-error marker) with `isError: true` and `message`
 * as the only text block, which is exactly the envelope; the Code Mode
 * wrapper turns it into a thrown Error with the same message.
 */
export type DenialResult = {
    error: true
    /** Mastra's FormattedValidationErrors, empty: no schema field failed. */
    validationErrors: { errors: string[]; fields: Record<string, never> }
    message: string
    denial: Denial
}

export function denialResult(denial: Denial): DenialResult {
    return {
        error: true,
        validationErrors: { errors: [], fields: {} },
        message: denialText(denial),
        denial,
    }
}

/** Thrown inside a tool's own code to refuse with a coded denial. */
export class McpDenialError extends Error {
    readonly denial: Denial
    constructor(denial: Denial) {
        super(denialText(denial))
        this.name = 'McpDenialError'
        this.denial = denial
    }
}
