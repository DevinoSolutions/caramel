'use client'
// src/lib/feedback/promptSupportOnFailure.tsx
//
// The non-blocking error→feedback bridge. On a genuinely user-visible failure
// (a blocked action the user can SEE go wrong), report it via
// reportUserVisibleFailure (Sentry always; PostHog + this prompt at most once
// per operation+errorCode per session), then — unless rate-limited — offer a
// sonner toast whose action opens the app-level SupportDialog pre-filled with
// the Sentry event id + current route. Do NOT call this for validation errors,
// background/fire-and-forget errors, or in a loop: the fingerprint rate limit
// enforces the once-per-session rule.
import { toast } from 'sonner'
import { reportUserVisibleFailure } from './reportUserVisibleFailure'
import {
    openSupportDialog,
    type SupportDialogOpenArgs,
} from './supportDialogRegistry'

export function promptSupportOnFailure(input: {
    error: unknown
    operation: string
    errorCode?: string
    extra?: Record<string, unknown>
    /** Override the dialog opener (defaults to the module-level registry, so
     * call sites never prop-drill it). */
    openDialog?: (args: SupportDialogOpenArgs) => void
}): void {
    const { sentryEventId, rateLimited } = reportUserVisibleFailure({
        error: input.error,
        operation: input.operation,
        errorCode: input.errorCode,
        extra: input.extra,
    })
    if (rateLimited) return

    const open = input.openDialog ?? openSupportDialog
    toast('It looks like something may not have worked.', {
        action: {
            label: 'Tell us what happened',
            onClick: () =>
                open({
                    initialSentryEventId: sentryEventId ?? undefined,
                    fromRoute:
                        typeof window !== 'undefined'
                            ? window.location.pathname
                            : undefined,
                    defaultType: 'problem',
                }),
        },
    })
}
