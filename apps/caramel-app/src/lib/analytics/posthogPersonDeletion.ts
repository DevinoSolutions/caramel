// src/lib/analytics/posthogPersonDeletion.ts
//
// Deletes an account's PostHog person AND its events when the account is
// deleted (T-7505; the TODO(T-4906) that used to sit in api/account/delete).
//
// WHAT IS SENT: POST {host}/api/projects/{id}/persons/bulk_delete/ with
// { distinct_ids: [userId], delete_events: true, delete_recordings: true }.
// The only distinct id the app identifies a person by is the user id (identity.ts
// identify(user.id); signup_completed and the support form capture under it too),
// and identify() merges the browser's earlier anonymous id into that person, so
// one id reaches the whole person. Deliberately NOT sent: any id read from the
// request (a cookie is client-controlled, and this call is destructive).
// PostHog answers 202 and finishes in the background ("Person records are
// removed in the background shortly after the request returns"; events and
// recordings go through its async-deletion queue), so a success here means
// "queued", not "gone".
//
// CONTRACT: never throws and never blocks the account deletion. Returns
//   'deleted'        PostHog accepted the request (or had no such person: a user
//                    who never reached PostHog has nothing to delete, which is
//                    the goal state, not an error)
//   'not_applicable' PostHog capture is disabled for this deploy (POSTHOG_DATASET)
//   'failed'         anything else; always with a Sentry error (never silent) that
//                    carries a one-way hash of the user id, never the email.
// Only events captured before the request are deleted: an in-flight tab can
// re-create the person, which is why the browser also calls
// resetPosthogIdentity() after a deletion (DataPrivacySection.tsx).
import { env } from '@/lib/env'
import * as Sentry from '@sentry/nextjs'
import { createHash } from 'node:crypto'
import 'server-only'
import { resolveServerTarget } from './posthogServer'

export type PosthogPersonDeletionOutcome =
    'deleted' | 'not_applicable' | 'failed'

const REQUEST_TIMEOUT_MS = 8000

/** Non-reversible short id for Sentry context: enough to correlate, no PII. */
function userHash(userId: string): string {
    return createHash('sha256').update(userId).digest('hex').slice(0, 12)
}

function report(
    reason: string,
    userId: string,
    detail: { status?: number; cause?: unknown } = {},
): 'failed' {
    const error = new Error(`posthog person deletion failed: ${reason}`)
    Sentry.captureException(error, {
        tags: {
            route: 'account/delete',
            operation: 'posthog_person_delete',
            reason,
        },
        extra: {
            userHash: userHash(userId),
            ...(detail.status !== undefined ? { status: detail.status } : {}),
            ...(detail.cause !== undefined
                ? {
                      cause:
                          detail.cause instanceof Error
                              ? `${detail.cause.name}: ${detail.cause.message}`
                              : String(detail.cause),
                  }
                : {}),
        },
    })
    console.error('[account/delete] posthog person deletion failed', {
        reason,
        userHash: userHash(userId),
        status: detail.status,
    })
    return 'failed'
}

export async function deletePosthogPerson(
    userId: string,
): Promise<PosthogPersonDeletionOutcome> {
    try {
        const target = resolveServerTarget()
        if (!target) {
            console.info(
                '[account/delete] posthog person deletion skipped: PostHog is disabled for this deploy',
            )
            return 'not_applicable'
        }
        const apiKey = env.POSTHOG_PERSONAL_API_KEY?.trim()
        const projectId = env.POSTHOG_PROJECT_ID?.trim()
        if (!apiKey || !projectId) {
            return report('not_configured', userId)
        }
        if (!/^\d+$/.test(projectId)) return report('bad_project_id', userId)

        const url = new URL(
            `/api/projects/${projectId}/persons/bulk_delete/`,
            target.host,
        )
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                distinct_ids: [userId],
                delete_events: true,
                delete_recordings: true,
            }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        // 404: no such person (or project-scoped miss for this id). A person
        // that does not exist is already deleted.
        if (res.status === 404) return 'deleted'
        if (!res.ok) return report('http_error', userId, { status: res.status })

        const summary: unknown = await res.json().catch(() => null)
        const errors =
            typeof summary === 'object' &&
            summary !== null &&
            'deletion_errors' in summary &&
            Array.isArray(summary.deletion_errors)
                ? summary.deletion_errors
                : []
        if (errors.length > 0) {
            return report('deletion_errors', userId, { status: res.status })
        }
        return 'deleted'
    } catch (error) {
        return report('request_failed', userId, { cause: error })
    }
}
