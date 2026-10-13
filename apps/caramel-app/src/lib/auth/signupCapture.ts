// src/lib/auth/signupCapture.ts
//
// What happens when an account is CREATED, regardless of how: persist where
// the visitor came from (`users.acquisition`) and tell PostHog
// (`signup_completed`). Two callers, because there are two account-creation
// paths in this codebase:
//
//   1. better-auth's `databaseHooks.user.create.after` (auth.ts) — email
//      sign-up and the Google / Apple web flows;
//   2. `mintExtensionSession` (extensionOAuthSession.ts) — the extension's
//      own OAuth code exchange writes the User row with raw Prisma, which
//      bypasses better-auth's hooks entirely, so it calls this directly.
//
// CONTRACT: this never throws and never blocks an account from being
// created. Every sub-step reports its own failure to Sentry (with the user id,
// which is not PII) and the function returns what actually happened, so the
// caller can see and test it. A signup that loses its analytics is a Sentry
// event; a signup that fails because analytics failed would be a worse bug.
import {
    deriveFirstTouchSource,
    type FirstTouchRecord,
} from '@/lib/analytics/firstTouchRecord'
import {
    readFirstTouchFromHeaders,
    readPosthogDistinctId,
    type HeaderReader,
} from '@/lib/analytics/firstTouchServer'
import { buildFirstTouchProperties } from '@/lib/analytics/identityProperties'
import {
    aliasServerDistinctId,
    captureServerEvent,
    getServerPosthogProjectToken,
} from '@/lib/analytics/posthogServer'
import type {
    SignupMethod,
    SignupSurface,
} from '@/lib/analytics/signupVocabulary'
import prisma from '@/lib/prisma'
import { Prisma } from '@prisma/client'
import * as Sentry from '@sentry/nextjs'
import 'server-only'

/**
 * Longest an account creation will wait on PostHog. captureImmediate retries
 * on a flaky network; a signup must not sit behind that.
 */
export const SIGNUP_ANALYTICS_TIMEOUT_MS = 3000

/** What the hook could determine about HOW the account was created. */
export type RecordedSignupMethod = SignupMethod | 'unknown'

/** The JSON stored in `users.acquisition`. */
// A type alias, not an interface: Prisma's Json input type needs an implicit
// index signature, which only aliases have.
export type UserAcquisition = Partial<FirstTouchRecord> & {
    /** utm_source / ref / ad-click platform / referrer host / 'direct' / 'unknown'. */
    source: string
    signup_surface: SignupSurface
    signup_method: RecordedSignupMethod
}

export interface SignupOutcome {
    /**
     * THIS call wrote `users.acquisition`. false = it was already set (write-once:
     * the first record wins, not an error) or the update failed (in Sentry).
     */
    acquisitionSaved: boolean
    /** PostHog accepted `signup_completed`. */
    eventCaptured: boolean
    /** Pre-signup visits were linked to the account (false = nothing to link or it failed). */
    aliased: boolean
}

/**
 * The acquisition JSON for one signup. `source: 'unknown'` means NO first-touch
 * cookie reached the server (cookie blocked/cleared, or an extension signup
 * that never visited the site); `'direct'` means a cookie arrived but carried
 * no campaign, click id or external referrer.
 */
export function buildAcquisition(args: {
    firstTouch: FirstTouchRecord | null
    method: RecordedSignupMethod
    surface: SignupSurface
}): UserAcquisition {
    const { firstTouch, method, surface } = args
    if (!firstTouch) {
        return {
            source: 'unknown',
            signup_surface: surface,
            signup_method: method,
        }
    }
    return {
        ...firstTouch,
        source: deriveFirstTouchSource(firstTouch) ?? 'direct',
        signup_surface: surface,
        signup_method: method,
    }
}

type Timed<T> = { timedOut: false; value: T } | { timedOut: true }

/** Resolve with the promise's value, or `timedOut` after `ms`. Never rejects on its own. */
async function withTimeout<T>(
    promise: Promise<T>,
    ms: number,
): Promise<Timed<T>> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<{ timedOut: true }>(resolve => {
        timer = setTimeout(() => resolve({ timedOut: true }), ms)
    })
    try {
        return await Promise.race([
            promise.then(value => ({ timedOut: false as const, value })),
            timeout,
        ])
    } finally {
        clearTimeout(timer)
    }
}

/** Run one analytics step under the shared timeout; a timeout is a Sentry warning + `false`. */
async function boundedStep(
    step: string,
    userId: string,
    run: () => Promise<boolean>,
): Promise<boolean> {
    const result = await withTimeout(run(), SIGNUP_ANALYTICS_TIMEOUT_MS)
    if (result.timedOut) {
        Sentry.captureMessage(`signup analytics step "${step}" timed out`, {
            level: 'warning',
            tags: { operation: 'signup_capture', step },
            extra: { userId, timeoutMs: SIGNUP_ANALYTICS_TIMEOUT_MS },
        })
        return false
    }
    return result.value
}

export async function recordSignup(args: {
    user: { id: string }
    /** The request's headers when there is a request (null for the extension mint). */
    headers: HeaderReader | null
    method: RecordedSignupMethod
    surface: SignupSurface
}): Promise<SignupOutcome> {
    const { user, headers, method, surface } = args
    const outcome: SignupOutcome = {
        acquisitionSaved: false,
        eventCaptured: false,
        aliased: false,
    }

    try {
        // Invalid cookie => null + a Sentry warning inside the reader.
        const firstTouch = readFirstTouchFromHeaders(headers)
        const acquisition = buildAcquisition({ firstTouch, method, surface })
        const firstTouchProperties = buildFirstTouchProperties(firstTouch)

        try {
            // WRITE-ONCE: only a row whose acquisition is still database NULL
            // is touched (Prisma.DbNull = SQL NULL, not a JSON null), so a
            // second call can never overwrite the first record. count 0 means
            // it was already set: reported as such, not as an error.
            const { count } = await prisma.user.updateMany({
                where: { id: user.id, acquisition: { equals: Prisma.DbNull } },
                data: { acquisition },
            })
            outcome.acquisitionSaved = count === 1
            if (count === 0) {
                Sentry.addBreadcrumb({
                    category: 'analytics',
                    level: 'info',
                    message:
                        'users.acquisition already set; kept the first record',
                    data: { userId: user.id },
                })
            }
        } catch (error) {
            console.error('[signup] saving users.acquisition failed', error)
            Sentry.captureException(error, {
                tags: { operation: 'signup_capture', step: 'save_acquisition' },
                extra: { userId: user.id },
            })
        }

        outcome.eventCaptured = await boundedStep('capture', user.id, () =>
            captureServerEvent({
                event: 'signup_completed',
                distinctId: user.id,
                properties: {
                    method,
                    signup_surface: surface,
                    source: acquisition.source,
                    ...firstTouchProperties,
                    // Person-level, write-once: the acquisition story the
                    // browser also sets at identify, so a user whose browser
                    // analytics never arrived still has it.
                    $set_once: {
                        ...firstTouchProperties,
                        acquisition_source: acquisition.source,
                        signup_surface: surface,
                        signup_method: method,
                    },
                },
            }),
        )
        if (!outcome.eventCaptured) {
            // false = disabled dataset OR a failure (already in Sentry). The
            // breadcrumb makes the disabled case visible next to any later error.
            Sentry.addBreadcrumb({
                category: 'analytics',
                level: 'warning',
                message: 'signup_completed was not captured',
                data: { userId: user.id },
            })
        }

        const token = getServerPosthogProjectToken()
        const anonymousDistinctId = token
            ? readPosthogDistinctId(headers, token)
            : null
        if (anonymousDistinctId && anonymousDistinctId !== user.id) {
            outcome.aliased = await boundedStep('alias', user.id, () =>
                aliasServerDistinctId({
                    anonymousDistinctId,
                    userId: user.id,
                }),
            )
        }
    } catch (error) {
        // Belt for the synchronous parts above (cookie parsing, property
        // building): they are not expected to throw, but "never fails signup"
        // is the contract, so an unexpected throw is reported, not propagated.
        console.error('[signup] recordSignup failed', error)
        Sentry.captureException(error, {
            tags: { operation: 'signup_capture', step: 'record_signup' },
            extra: { userId: user.id },
        })
    }

    return outcome
}
