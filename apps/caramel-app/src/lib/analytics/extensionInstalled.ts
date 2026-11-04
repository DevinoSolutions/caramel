'use client'
// src/lib/analytics/extensionInstalled.ts
//
// Browser half of install attribution, run once by /welcome (the page the
// extension opens on `runtime.onInstalled`):
//
//   1. read/bank the first-touch record (the visitor's campaign, if any);
//   2. capture `extension_installed` in the browser's PostHog;
//   3. POST /api/ext/installed so OUR server records the same event (survives
//      content blockers) and CHECK the reply.
//
// Both captures share one uuid (the install id) so PostHog can collapse them.
//
// Once-per-install guard, in localStorage, in two halves so a failed POST can
// be retried on a reload WITHOUT re-sending the browser event:
//   cm_ext_installed_browser:<iid>  set after step 2
//   cm_ext_installed_server:<iid>   set after step 3 is confirmed (captured:true)
// A localStorage that throws (private mode, disabled storage) is reported and
// treated as "no guard": a possible duplicate beats a lost install, and the
// shared uuid collapses it anyway.
import {
    EXT_INSTALLED_ENDPOINT,
    isExtInstalledResponse,
    organicInstallSource,
    type ExtInstalledRequest,
    type WelcomeParams,
} from '@/lib/extensionInstall'
import * as Sentry from '@sentry/nextjs'
import { captureFirstTouch } from './firstTouch'
import { deriveFirstTouchSource } from './firstTouchRecord'
import { buildFirstTouchProperties } from './identityProperties'
import {
    capturePosthog,
    getLoadedPosthog,
    isPosthogActive,
    withPosthog,
} from './posthogBrowser'

export type InstallAttributionResult =
    'recorded' | 'already_recorded' | 'failed'

const BROWSER_GUARD_PREFIX = 'cm_ext_installed_browser:'
const SERVER_GUARD_PREFIX = 'cm_ext_installed_server:'

/** How long to wait for posthog-js to load so the POST can carry its id. */
const DISTINCT_ID_WAIT_MS = 4000

function reportFailure(step: string, error: unknown, iid: string): void {
    console.error(`[extension-installed] ${step} failed`, error)
    Sentry.captureException(error, {
        tags: { operation: 'extension_installed', step },
        extra: { iid },
    })
}

/**
 * The server POST is `keepalive`, so leaving /welcome (the Sign in link) does
 * not cancel it: a rejection that still reaches us is a real network failure.
 * It stays an error, but carries the page state so a failure while the page
 * was already hidden / unloading (Safari may still reject then) is told apart
 * from one on a visible page, and is a warning rather than an error.
 */
function reportServerFailure(error: unknown, iid: string): void {
    const pageHidden = document.visibilityState === 'hidden'
    console.error('[extension-installed] server_report failed', error)
    Sentry.captureException(error, {
        tags: { operation: 'extension_installed', step: 'server_report' },
        level: pageHidden ? 'warning' : 'error',
        extra: {
            iid,
            pageVisibility: document.visibilityState,
            online: navigator.onLine,
        },
    })
}

function readGuard(key: string, iid: string): boolean {
    try {
        return window.localStorage.getItem(key) !== null
    } catch (error) {
        reportFailure('guard_read', error, iid)
        return false
    }
}

function writeGuard(key: string, iid: string): void {
    try {
        window.localStorage.setItem(key, new Date().toISOString())
    } catch (error) {
        reportFailure('guard_write', error, iid)
    }
}

/** posthog-js's current distinct id, or null when it is off / has not loaded in time. */
function awaitDistinctId(): Promise<string | null> {
    return new Promise(resolve => {
        const loaded = getLoadedPosthog()
        if (loaded) {
            resolve(loaded.get_distinct_id())
            return
        }
        if (!isPosthogActive()) {
            resolve(null)
            return
        }
        const timer = setTimeout(() => resolve(null), DISTINCT_ID_WAIT_MS)
        withPosthog(posthog => {
            clearTimeout(timer)
            resolve(posthog.get_distinct_id())
        })
    })
}

export async function recordExtensionInstalled(
    params: WelcomeParams,
): Promise<InstallAttributionResult> {
    const { store, extensionVersion, iid } = params
    if (readGuard(`${SERVER_GUARD_PREFIX}${iid}`, iid)) {
        return 'already_recorded'
    }

    // Banks the record if this very load is the first touch (a user who found
    // the extension in the store has none: the source is then "<store>_web_store_organic").
    const firstTouch = captureFirstTouch()

    if (!readGuard(`${BROWSER_GUARD_PREFIX}${iid}`, iid)) {
        capturePosthog(
            'extension_installed',
            {
                store,
                extension_version: extensionVersion,
                iid,
                source:
                    deriveFirstTouchSource(firstTouch) ??
                    organicInstallSource(store),
                capture_path: 'browser',
                ...buildFirstTouchProperties(firstTouch),
            },
            error => reportFailure('browser_capture', error, iid),
            { uuid: iid },
        )
        writeGuard(`${BROWSER_GUARD_PREFIX}${iid}`, iid)
    }

    const distinctId = await awaitDistinctId()
    const body: ExtInstalledRequest = {
        store,
        extension_version: extensionVersion,
        iid,
        ...(distinctId ? { distinct_id: distinctId } : {}),
    }
    try {
        const response = await fetch(EXT_INSTALLED_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            // Survives the user leaving /welcome mid-request (Sign in link).
            // The body is a few hundred bytes, far under keepalive's 64 KiB cap.
            keepalive: true,
        })
        if (!response.ok) {
            throw new Error(
                `${EXT_INSTALLED_ENDPOINT} responded ${response.status}`,
            )
        }
        const reply: unknown = await response.json()
        if (!isExtInstalledResponse(reply)) {
            throw new Error(
                `${EXT_INSTALLED_ENDPOINT} returned an unexpected body`,
            )
        }
        if (!reply.captured) {
            throw new Error(
                'server did not capture extension_installed (PostHog disabled or the capture failed)',
            )
        }
    } catch (error) {
        reportServerFailure(error, iid)
        return 'failed'
    }
    writeGuard(`${SERVER_GUARD_PREFIX}${iid}`, iid)
    return 'recorded'
}
