// src/lib/analytics/runAfterLoadWhenIdle.ts
//
// Start a third-party script only once the page has finished loading and the
// main thread is idle: the same schedule as next/script's `lazyOnload`, for
// SDKs that inject their own <script> tag (Hotjar) instead of going through
// <Script>. Measured on a prod store page (Lighthouse mobile, applied
// throttling, 2026-09-26): Hotjar cost 350–450 ms of blocking time, most of it
// while the app's own JS was still downloading and hydrating.
//
// Returns a cancel function for effect cleanup.
export function runAfterLoadWhenIdle(task: () => void): () => void {
    let idleId: number | undefined
    let timerId: number | undefined

    const scheduleWhenIdle = () => {
        if (typeof window.requestIdleCallback === 'function') {
            // timeout: a page that never goes idle (animations) still gets
            // its analytics, just later.
            idleId = window.requestIdleCallback(task, { timeout: 4000 })
        } else {
            // Safari has no requestIdleCallback; the load event already passed,
            // so a macrotask is enough to stay off the hydration path.
            timerId = window.setTimeout(task, 1)
        }
    }

    if (document.readyState === 'complete') {
        scheduleWhenIdle()
    } else {
        window.addEventListener('load', scheduleWhenIdle, { once: true })
    }

    return () => {
        window.removeEventListener('load', scheduleWhenIdle)
        if (idleId !== undefined) window.cancelIdleCallback(idleId)
        if (timerId !== undefined) window.clearTimeout(timerId)
    }
}
