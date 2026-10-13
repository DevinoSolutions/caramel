// src/lib/auth/signupHook.ts
//
// The better-auth `databaseHooks.user.create.after` handler (wired in
// auth.ts): classify HOW the account was created and hand it to recordSignup.
//
// HOW THE HOOK GETS THE REQUEST (verified in better-auth 1.6.23,
// dist/db/with-hooks.mjs): `createWithHooks` calls
// `getCurrentAuthContext()` and passes it as the hook's second argument, a
// GenericEndpointContext (`EndpointContext & { context }`). While an auth
// endpoint is handling an HTTP request that context carries `headers` (the
// request's headers, including `cookie`), `path` (the matched route pattern,
// e.g. `/sign-up/email`, `/callback/:id`) and `params`. It is `null` when a
// user is created outside any endpoint (a direct adapter call, a script) —
// there is then no request to read a cookie from, and the signup is recorded
// as `source: 'unknown'`. The after-hook runs AFTER the transaction commits
// (queueAfterTransactionHook), so the User row exists when we update it.
//
// OAuth specifics: the `cm_ft` cookie is SameSite=Lax. Apple's callback is a
// cross-site POST, but better-auth answers that POST with a redirect to the
// GET form of the same callback (routes/callback.mjs), and a top-level GET
// navigation does carry Lax cookies, so the user is created on a request that
// has the cookie.
import {
    isSignupMethod,
    type SignupSurface,
} from '@/lib/analytics/signupVocabulary'
import type { RecordedSignupMethod } from '@/lib/auth/signupCapture'
import { recordSignup, type SignupOutcome } from '@/lib/auth/signupCapture'
import * as Sentry from '@sentry/nextjs'
import 'server-only'

/** The slice of better-auth's GenericEndpointContext this handler reads. */
export interface SignupHookContext {
    headers?: Headers | null
    path?: string
    params?: Record<string, unknown> | null
    body?: unknown
}

// Origins whose requests come from inside the browser extension.
const EXTENSION_ORIGIN =
    /^(chrome-extension|moz-extension|safari-web-extension|extension):\/\//

/**
 * How was this account created? From the endpoint better-auth was running:
 * `/sign-up/email`; `/callback/:id` (the OAuth redirect return, provider in
 * `params.id`); `/sign-in/social` (the native id-token flow, provider in the
 * body). Anything else is `unknown` and reported, so a new better-auth route
 * that creates users shows up instead of being miscounted.
 */
export function classifySignupMethod(
    context: SignupHookContext | null,
): RecordedSignupMethod {
    const path = context?.path
    if (path === '/sign-up/email') return 'email'
    if (path === '/callback/:id') {
        const provider = context?.params?.id
        if (isSignupMethod(provider)) return provider
    }
    if (path === '/sign-in/social') {
        const body = context?.body
        const provider =
            typeof body === 'object' && body !== null && 'provider' in body
                ? body.provider
                : undefined
        if (isSignupMethod(provider)) return provider
    }
    return 'unknown'
}

/** `extension` when the request's Origin is a browser-extension origin, else `web`. */
export function classifySignupSurface(
    context: SignupHookContext | null,
): SignupSurface {
    const origin = context?.headers?.get('origin')
    return origin && EXTENSION_ORIGIN.test(origin) ? 'extension' : 'web'
}

export async function handleUserCreated(
    user: { id: string },
    context: SignupHookContext | null,
): Promise<SignupOutcome | null> {
    try {
        const method = classifySignupMethod(context)
        if (method === 'unknown') {
            Sentry.captureMessage(
                'user created through an unclassified better-auth path',
                {
                    level: 'warning',
                    tags: { operation: 'signup_capture', step: 'classify' },
                    extra: { userId: user.id, path: context?.path ?? null },
                },
            )
        }
        return await recordSignup({
            user,
            headers: context?.headers ?? null,
            method,
            surface: classifySignupSurface(context),
        })
    } catch (error) {
        // recordSignup never throws; this guards the classification above.
        // Either way better-auth must not see an exception: it would fail
        // the signup response for a user whose row is already committed.
        console.error('[signup] user.create.after handler failed', error)
        Sentry.captureException(error, {
            tags: { operation: 'signup_capture', step: 'hook' },
            extra: { userId: user.id },
        })
        return null
    }
}
