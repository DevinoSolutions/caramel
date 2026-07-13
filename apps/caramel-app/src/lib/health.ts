import { env } from '@/lib/env'

export interface HealthResult {
    status: 'ok' | 'error'
    service: string
    latencyMs: number
    details?: string
}

export async function timedCheck(
    service: string,
    check: () => Promise<string | void>,
): Promise<HealthResult> {
    const start = Date.now()
    try {
        const details = await check()
        return {
            status: 'ok',
            service,
            latencyMs: Date.now() - start,
            ...(details ? { details } : {}),
        }
    } catch (err) {
        return {
            status: 'error',
            service,
            latencyMs: Date.now() - start,
            details: err instanceof Error ? err.message : String(err),
        }
    }
}

export function authorize(request: Request): boolean {
    const secret = env.UPKUMA_HEALTH_SECRET
    if (!secret) return false
    const auth = request.headers.get('authorization') || ''
    return auth === `Bearer ${secret}`
}
