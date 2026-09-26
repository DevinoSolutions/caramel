// Schedulers for browser work a first visit does not need before the page can
// paint and respond.
//
// Measured on grabcaramel.com's landing page, mobile Lighthouse (2026-09-26,
// prod 59): posthog-js, PostHog's session recorder and Sentry's Replay
// integration (rrweb) started during hydration. Their downloads shared the
// slow-4G link with the LCP image and their start-up work (a full DOM snapshot
// per recorder) landed inside hydration. Moving them to `requestIdleCallback`
// after the load event was not enough: on a fast page that fires inside
// hydration too, and the same work simply moved from LCP to Total Blocking
// Time.

/**
 * Run `callback` once the page has loaded and the main thread is idle.
 * `timeout` bounds the idle wait. Server renders never call it.
 */
export function afterPageLoad(callback: () => void, timeout = 3000): void {
    if (typeof window === 'undefined') return
    const whenIdle = () => {
        if (typeof window.requestIdleCallback === 'function') {
            window.requestIdleCallback(() => callback(), { timeout })
        } else {
            window.setTimeout(callback, 1)
        }
    }
    if (document.readyState === 'complete') whenIdle()
    else window.addEventListener('load', whenIdle, { once: true })
}

// Visitor activity that means "someone is using this page". Scroll and wheel
// are included on purpose: they are not INP-measured interactions, and on a
// phone the first scroll almost always comes before the first tap.
const ACTIVITY_EVENTS = [
    'pointerdown',
    'keydown',
    'touchstart',
    'scroll',
    'wheel',
] as const

/**
 * Run `callback` at the visitor's first activity on the page, or `ceilingMs`
 * after the load event, whichever comes first — for the session recorders,
 * whose snapshot of the whole DOM is the most expensive thing a landing page
 * visit would otherwise do while the page is still loading. Runs at most once.
 */
export function onFirstActivity(
    callback: () => void,
    ceilingMs = 10_000,
): void {
    if (typeof window === 'undefined') return
    let done = false
    let ceiling: number | undefined
    const run = () => {
        if (done) return
        done = true
        for (const type of ACTIVITY_EVENTS) {
            window.removeEventListener(type, run, true)
        }
        if (ceiling !== undefined) window.clearTimeout(ceiling)
        afterPageLoad(callback)
    }
    for (const type of ACTIVITY_EVENTS) {
        window.addEventListener(type, run, { capture: true, passive: true })
    }
    const armCeiling = () => {
        ceiling = window.setTimeout(run, ceilingMs)
    }
    if (document.readyState === 'complete') armCeiling()
    else window.addEventListener('load', armCeiling, { once: true })
}

// The marketing landing route(s) whose first load defers the analytics SDKs
// (posthog-js at load + idle; both session recorders at first activity). The
// home page is the one measured (mobile PageSpeed 58-59, 2026-09-25/26).
// Every other route (app, auth, OAuth callbacks, profile, ...) keeps starting
// them at mount, exactly as before. Matched on the path of the page the
// visitor LANDED on: a later client-side navigation does not restart anything.
const DEFERRED_ANALYTICS_ROUTES: ReadonlySet<string> = new Set(['/'])

export function defersAnalytics(pathname: string): boolean {
    return DEFERRED_ANALYTICS_ROUTES.has(pathname)
}
