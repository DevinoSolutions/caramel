'use client'
// src/lib/analytics/posthogBrowser.ts
//
// The ONE holder of the browser's posthog-js instance. posthog-js is loaded
// with a dynamic import (identity.ts; on the landing route only after the page
// has loaded, everywhere else at mount), so no module may `import posthog from 'posthog-js'` statically: any static import puts the
// SDK (~73 KB gzip) back into every page's first-load JavaScript, where it
// competed with the landing page's LCP image and hydration on mobile.
//
// Call sites hand a task to `withPosthog`. Once PostHog is running the task
// runs immediately; while the SDK is still loading it is queued and replayed in
// order the moment init completes, so an event fired in the first second of a
// visit is not lost (captures go through capturePosthog, which also keeps the
// time the event happened rather than the time it was flushed). When PostHog is not configured for this deploy (or failed
// to load) tasks are dropped, exactly like posthog-js drops calls made before
// init.
import type { PostHog, Properties } from 'posthog-js'

type PosthogTask = (posthog: PostHog) => void

type LoadState = 'off' | 'loading' | 'ready' | 'failed'

let state: LoadState = 'off'
let instance: PostHog | null = null
let queue: PosthogTask[] = []

// Bounds the queue if the load stalls. A visit fires a handful of events before
// load at most; past this the EARLIEST 50 are kept (they carry the landing
// context) and later ones are dropped.
const QUEUE_LIMIT = 50

/** True once a capture target is configured and PostHog is loading or live. */
export function isPosthogActive(): boolean {
    return state === 'loading' || state === 'ready'
}

/** The running instance, or null until the SDK has loaded and initialised. */
export function getLoadedPosthog(): PostHog | null {
    return instance
}

/** Run `task` against PostHog now, or once it has finished loading. */
export function withPosthog(task: PosthogTask): void {
    if (state === 'ready' && instance) {
        task(instance)
        return
    }
    if (state === 'loading' && queue.length < QUEUE_LIMIT) queue.push(task)
}

/**
 * Start loading PostHog. `load` resolves with an initialised instance; the
 * queued tasks then run in order. On failure the queue is dropped and
 * `onError` reports it, so a blocked or failed SDK costs analytics, never the
 * page.
 */
export function startPosthogLoad(
    load: () => Promise<PostHog>,
    onError: (error: unknown) => void,
): void {
    if (state !== 'off') return
    state = 'loading'
    load().then(
        posthog => {
            instance = posthog
            state = 'ready'
            const pending = queue
            queue = []
            // One throwing task must not cost the ones queued behind it.
            for (const task of pending) {
                try {
                    task(posthog)
                } catch (error) {
                    onError(error)
                }
            }
        },
        error => {
            state = 'failed'
            queue = []
            onError(error)
        },
    )
}

/**
 * `posthog.capture` stamped with the time of the CALL, not of the flush: an
 * event queued while posthog-js loads keeps the moment it happened. `onError`
 * reports a throwing capture; nothing here throws to the caller.
 */
export function capturePosthog(
    event: string,
    properties: Properties,
    onError: (error: unknown) => void,
): void {
    const timestamp = new Date()
    withPosthog(posthog => {
        try {
            posthog.capture(event, properties, { timestamp })
        } catch (error) {
            onError(error)
        }
    })
}
