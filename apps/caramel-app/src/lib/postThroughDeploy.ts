// A browser POST to one of Caramel's own API routes that rides out a deploy.
//
// Every Caramel API route answers JSON, whatever the status. During the few
// seconds a deploy takes grabcaramel.com off the edge (swap drill 2026-09-25:
// ~4.5 s), the request is answered by something in FRONT of Caramel instead:
// Cloudflare's 502/503/504/52x page, or another app's HTML 404 (the host's
// catch-all router). Such an answer never reached the route, so re-sending it
// cannot do anything twice. Before this, the suggestion form read that 404 as
// "you typed a bad URL" and told the shopper to fix a URL that was fine.

// Statuses a proxy or another app gives while Caramel has no route. Only
// retried when the body is NOT Caramel's JSON.
const GAP_STATUSES = new Set([404, 502, 503, 504, 520, 521, 522, 523, 524, 530])

// Waits between attempts. ~9 s in total covers the measured ~4.5 s gap twice.
const DEFAULT_DELAYS_MS = [1_000, 2_000, 3_000, 3_000]

export const DEPLOY_GAP_MESSAGE =
    'Caramel is restarting after an update, so this was not sent. Please try again in a minute.'

export interface DeployGapReport {
    recovered: boolean
    attempts: number
    lastStatus: number
}

export interface PostThroughDeployOptions {
    delaysMs?: number[]
    sleep?: (ms: number) => Promise<void>
    // Called once when at least one gap answer was seen (recovered or not).
    onGap?: (report: DeployGapReport) => void
}

export function isDeployGapAnswer(res: Response): boolean {
    if (res.ok || !GAP_STATUSES.has(res.status)) return false
    const type = res.headers?.get?.('content-type') ?? ''
    return !type.includes('application/json')
}

const defaultSleep = (ms: number) =>
    new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * Returns Caramel's own answer (any status), or `null` when every attempt was
 * answered by something in front of Caramel; the caller then shows
 * DEPLOY_GAP_MESSAGE. A network error (fetch rejects) is thrown as before: it
 * may have happened after the route received the request.
 */
export async function postJsonThroughDeploy(
    url: string,
    body: unknown,
    options: PostThroughDeployOptions = {},
): Promise<Response | null> {
    const delays = options.delaysMs ?? DEFAULT_DELAYS_MS
    const sleep = options.sleep ?? defaultSleep
    let lastStatus = 0
    for (let attempt = 0; ; attempt++) {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        })
        if (!isDeployGapAnswer(res)) {
            if (attempt > 0) {
                options.onGap?.({
                    recovered: true,
                    attempts: attempt + 1,
                    lastStatus,
                })
            }
            return res
        }
        lastStatus = res.status
        const delay = delays[attempt]
        if (delay === undefined) {
            options.onGap?.({
                recovered: false,
                attempts: attempt + 1,
                lastStatus,
            })
            return null
        }
        await sleep(delay)
    }
}
