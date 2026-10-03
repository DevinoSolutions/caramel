import { env } from '@/lib/env'

import * as Sentry from '@sentry/nextjs'

export async function register() {
    if (process.env.NEXT_RUNTIME === 'edge') {
        await import('../sentry.edge.config')
        return
    }

    await import('../sentry.server.config')

    // Loud, once-at-boot report of the coupons bridge-sync posture (W4-D3).
    // register() runs once per nodejs server boot, so this fires exactly once.
    // The app ALWAYS serves its OWN catalog (DATABASE_URL); COUPONS_DATABASE_URL
    // is now an OPTIONAL bridge-only input — absent → sync disabled. Logged
    // (never swallowed) so the posture is never a silent surprise.
    if (env.COUPONS_DATABASE_URL) {
        console.log(
            '[boot] coupons bridge sync ENABLED (COUPONS_DATABASE_URL set)',
        )
    } else {
        console.log(
            '[boot] coupons bridge sync DISABLED — serving the app-owned catalog only (COUPONS_DATABASE_URL unset)',
        )
    }

    // Sign in with Apple: prove the .p8 key really signs BEFORE serving. env.ts
    // already guarantees the vars are present; only signing proves the key is
    // a valid P-256 PKCS#8 PEM. Without this a malformed APPLE_PRIVATE_KEY
    // would surface when better-auth builds its context (rejecting ALL auth,
    // not just Apple) or at the first Apple sign-in. Throws -> the boot fails
    // loudly and the deploy never goes healthy. Never logs the key.
    if (env.APPLE_CLIENT_ID) {
        const { getAppleClientSecret } = await import(
            '@/lib/auth/appleClientSecret'
        )
        getAppleClientSecret()
        console.log(
            '[boot] apple client secret signed from APPLE_PRIVATE_KEY (Sign in with Apple ENABLED)',
        )
    } else {
        console.log(
            '[boot] Sign in with Apple DISABLED (APPLE_CLIENT_ID unset)',
        )
    }

    // Observability foundation: emit one server-lifecycle event per boot. This
    // is the first (and, until the feedback flow lands, only) server-side
    // PostHog capture. Dynamically imported so posthog-node never loads in the
    // edge runtime (the branch above returns before reaching here). No-ops
    // silently when POSTHOG_DATASET is 'disabled'; never throws — the helper
    // reports its own failures to Sentry and returns a boolean we log.
    const { captureServerEvent } = await import('@/lib/analytics/posthogServer')
    const captured = await captureServerEvent({
        event: 'app_server_started',
        distinctId: 'caramel-server',
        properties: { node_runtime: process.env.NEXT_RUNTIME ?? 'nodejs' },
    })
    if (captured) {
        console.log('[boot] posthog: app_server_started captured')
    }

    // Async email-delivery health. sendEmail() throwing is already loud (see
    // src/lib/auth/auth.ts); what was invisible until now is useSend accepting
    // a send with a 2xx and the message later going BOUNCED/FAILED or never
    // leaving QUEUED — 57 such rows on grabcaramel.com reached nobody. This
    // starts the only schedule the app has: an unref'd interval on the one
    // long-running process it owns. Dynamically imported for the same reason
    // as the PostHog helper above (never load it into the edge runtime), and
    // the decision is LOGGED either way so "is the check running?" is never a
    // guess.
    const { startEmailDeliveryHealthMonitor } = await import(
        '@/lib/emailDeliveryHealthMonitor'
    )
    const decision = startEmailDeliveryHealthMonitor()
    console.log(
        `[boot] email delivery health ${decision.enabled ? 'ENABLED' : 'DISABLED'} — ${decision.reason}`,
    )
}

export const onRequestError = Sentry.captureRequestError
