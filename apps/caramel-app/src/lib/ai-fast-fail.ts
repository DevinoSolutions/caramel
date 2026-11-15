/**
 * Fast-fail for every model call (owner directive 2026-11-15, T-17816).
 *
 * When a model or a host behind the AI proxy is down or slow, the app must
 * answer the person quickly with a clear error, never sit on a long wait. This
 * wraps a fetch so that every model request:
 *
 * - gets a first-byte timeout per attempt (`firstByteMs`), and all attempts
 *   together stay inside one deadline (`deadlineMs`);
 * - is retried only on failures that are safe to send again: a network error
 *   before any reply, a first-byte timeout, or a 429/502/503/504 reply, at most
 *   `retryDelaysMs.length` times with backoff (a short `Retry-After` is
 *   honoured, a long one is not waited for);
 * - drops the proxy's paid-fallback headers (`X-ORF-Fallback-*`) on every
 *   retry, so one user action goes paid at most once (fallback rules, C4);
 * - has its streamed body cut, as an error, after `idleMs` without a byte;
 * - ends with an `AiUnavailableError` whose message can be shown as it is,
 *   or with the last reply when the last failure was a status (so the caller's
 *   own status handling still runs).
 *
 * Nothing is retried once the reply's headers have arrived and been handed to
 * the caller: a reply the person may already be reading is never sent again.
 * Copy this file verbatim into each app (same rule as proxy-fallback-headers).
 */

type FetchLike = typeof globalThis.fetch

/** Wait for a reply's headers, per attempt. */
export const AI_FIRST_BYTE_MS = 30_000
/** All attempts of one request together, headers included. */
export const AI_DEADLINE_MS = 45_000
/** Silence allowed inside a streamed body before it is cut. */
export const AI_BODY_IDLE_MS = 60_000
/** Waits before each retry; two retries at most. */
export const AI_RETRY_DELAYS_MS: readonly number[] = [500, 1_500]
/** A `Retry-After` longer than this is not waited for. */
export const AI_MAX_RETRY_AFTER_MS = 4_000
/** An attempt that cannot get at least this long is not started. */
export const AI_MIN_ATTEMPT_MS = 5_000
/** Reply statuses that are retried (the proxy or a host is busy or down). */
export const AI_RETRY_STATUSES: ReadonlySet<number> = new Set([
    429, 502, 503, 504,
])

/** What the person is told; safe to show as it is. */
export const AI_UNAVAILABLE_MESSAGE =
    'The AI is busy right now. Please try again in a moment.'

export type AiFailureKind = 'timeout' | 'network' | 'status' | 'idle'

/** A model call that failed after its retries. `message` is user-facing. */
export class AiUnavailableError extends Error {
    readonly kind: AiFailureKind
    /** Attempts made, when known. */
    readonly attempts?: number | undefined
    readonly status?: number | undefined
    /** For logs only: what went wrong underneath. */
    readonly detail: string

    constructor(opts: {
        kind: AiFailureKind
        attempts?: number
        status?: number
        detail: string
        cause?: unknown
    }) {
        super(AI_UNAVAILABLE_MESSAGE, { cause: opts.cause })
        this.name = 'AiUnavailableError'
        this.kind = opts.kind
        this.attempts = opts.attempts
        this.status = opts.status
        this.detail = opts.detail
    }
}

export function isAiUnavailableError(
    error: unknown,
): error is AiUnavailableError {
    return error instanceof Error && error.name === 'AiUnavailableError'
}

export type FastFailOptions = {
    firstByteMs?: number
    deadlineMs?: number
    idleMs?: number
    retryDelaysMs?: readonly number[]
    /** Tests only. */
    now?: () => number
    /** Tests only. */
    sleep?: (ms: number, signal?: AbortSignal | null) => Promise<void>
}

const PAID_HEADER_PREFIX = 'x-orf-fallback-'

function withoutPaidHeaders(headers: HeadersInit | undefined): Headers {
    const out = new Headers()
    for (const [name, value] of new Headers(headers)) {
        if (!name.toLowerCase().startsWith(PAID_HEADER_PREFIX))
            out.append(name, value)
    }
    return out
}

function retryAfterMs(res: Response): number | undefined {
    const raw = res.headers.get('retry-after')?.trim()
    if (!raw) return undefined
    if (/^\d+(\.\d+)?$/.test(raw)) return Number(raw) * 1000
    const at = Date.parse(raw)
    return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now())
}

function defaultSleep(ms: number, signal?: AbortSignal | null): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason)
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort)
            resolve()
        }, ms)
        const onAbort = () => {
            clearTimeout(timer)
            reject(signal?.reason)
        }
        signal?.addEventListener('abort', onAbort, { once: true })
    })
}

/** A body that errors with AiUnavailableError("idle") after `idleMs` of silence. */
function withIdleCut(
    res: Response,
    idleMs: number,
    attempts: number,
    abort: () => void,
): Response {
    if (!res.body || idleMs <= 0) return res
    const reader = res.body.getReader()
    let timer: ReturnType<typeof setTimeout> | undefined
    const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
            const idle = new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () =>
                        reject(
                            new AiUnavailableError({
                                kind: 'idle',
                                attempts,
                                detail: `no byte for ${idleMs} ms in the reply body`,
                            }),
                        ),
                    idleMs,
                )
            })
            try {
                const { done, value } = await Promise.race([
                    reader.read(),
                    idle,
                ])
                if (done) controller.close()
                else controller.enqueue(value)
            } catch (error) {
                abort()
                reader.cancel().catch(() => {})
                controller.error(error)
            } finally {
                clearTimeout(timer)
            }
        },
        cancel(reason) {
            clearTimeout(timer)
            return reader.cancel(reason)
        },
    })
    return new Response(body, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
    })
}

/**
 * Wrap `base` (default: the global fetch, read at call time) with the rules
 * above. Use the result as the `fetch` of an AI SDK provider (then set that
 * provider's own `maxRetries` to 0, or the two retry loops multiply) or call
 * it directly in place of fetch.
 */
export function fastFailFetch(
    base?: FetchLike,
    options: FastFailOptions = {},
): FetchLike {
    const firstByteMs = options.firstByteMs ?? AI_FIRST_BYTE_MS
    const deadlineMs = options.deadlineMs ?? AI_DEADLINE_MS
    const idleMs = options.idleMs ?? AI_BODY_IDLE_MS
    const delays = options.retryDelaysMs ?? AI_RETRY_DELAYS_MS
    const now = options.now ?? Date.now
    const sleep = options.sleep ?? defaultSleep

    return async (input, init) => {
        const send = base ?? globalThis.fetch
        const callerSignal = init?.signal ?? undefined
        const replayable =
            !(input instanceof Request) &&
            (init?.body == null ||
                typeof init.body === 'string' ||
                init.body instanceof Uint8Array)
        const deadline = now() + deadlineMs

        for (let attempt = 0; ; attempt += 1) {
            const attempts = attempt + 1
            const budget = Math.min(firstByteMs, deadline - now())
            const controller = new AbortController()
            const onCallerAbort = () => controller.abort(callerSignal?.reason)
            if (callerSignal?.aborted) throw callerSignal.reason
            callerSignal?.addEventListener('abort', onCallerAbort, {
                once: true,
            })
            let timedOut = false
            const timer = setTimeout(() => {
                timedOut = true
                controller.abort()
            }, budget)

            // The failure this attempt ended on: returned or thrown unless retried.
            let final: { res?: Response; error: AiUnavailableError } | undefined
            let wait: number | undefined = delays[attempt]
            try {
                const res = await send(input, {
                    ...init,
                    // The first attempt keeps the caller's headers (from `...init`).
                    ...(attempt === 0
                        ? {}
                        : { headers: withoutPaidHeaders(init?.headers) }),
                    signal: controller.signal,
                })
                clearTimeout(timer)
                if (!AI_RETRY_STATUSES.has(res.status)) {
                    return withIdleCut(res, idleMs, attempts, () =>
                        controller.abort(),
                    )
                }
                const after = retryAfterMs(res)
                // Only ever shortens or lengthens a retry that is due anyway: it
                // never adds one past the limit.
                if (after !== undefined && wait !== undefined)
                    wait = after <= AI_MAX_RETRY_AFTER_MS ? after : undefined
                final = {
                    res,
                    error: new AiUnavailableError({
                        kind: 'status',
                        attempts,
                        status: res.status,
                        detail: `HTTP ${res.status}`,
                    }),
                }
            } catch (error) {
                clearTimeout(timer)
                callerSignal?.removeEventListener('abort', onCallerAbort)
                if (callerSignal?.aborted) throw error
                final = {
                    error: new AiUnavailableError({
                        kind: timedOut ? 'timeout' : 'network',
                        attempts,
                        detail: timedOut
                            ? `no reply headers within ${budget} ms`
                            : `network error: ${(error as Error)?.message ?? String(error)}`,
                        cause: error,
                    }),
                }
            }

            const retry =
                replayable &&
                wait !== undefined &&
                deadline - now() - wait >= AI_MIN_ATTEMPT_MS
            if (!retry) {
                callerSignal?.removeEventListener('abort', onCallerAbort)
                if (final.res) return final.res
                throw final.error
            }
            callerSignal?.removeEventListener('abort', onCallerAbort)
            await final.res?.body?.cancel().catch(() => {})
            await sleep(wait as number, callerSignal)
        }
    }
}
