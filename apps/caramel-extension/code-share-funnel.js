// owns: the VOCABULARY and the PAYLOAD ALLOWLIST of the checkout-code-sharing
// funnel diagnostics (event `extension_code_share_funnel`, sent to
// POST /api/extension/telemetry only after the shopper opted in to anonymous
// usage diagnostics, see usage-diagnostics-consent.js).
//
// WHY. Sharing a typed code produced zero submissions on prod and the server
// event `coupon_submit_outcome` showed nobody even reaches the server: every
// client-side gate (signed out, no consent, store did not visibly accept, ...)
// was console-only, so we could not see where shoppers drop. Each step below is
// one point in code-capture.js / background.js where that is decided.
//
// WHAT NEVER LEAVES. No code value, no user id, no email, no page URL or path,
// no cart contents. `buildFunnelEvent` is the single place a payload is made
// and it is an ALLOWLIST: it builds a fresh object from validated enum values,
// so a new field cannot ride along by accident, and a value outside its
// vocabulary throws instead of being sent. The `store` is the matched store
// config's registrable domain, shape-checked to a bare hostname.
//
// MIRRORED in apps/caramel-app/src/lib/analytics/codeShareFunnel.ts (the
// server re-validates strictly); apps/caramel-app/tests/unit/code-share-funnel-
// mirror.test.ts fails if the two ever differ. Pure: no browser handle, no
// top-level effects, safe in every realm.

// step -> the reasons it may carry. A step with an empty list carries none, and
// a step with a list MUST carry one of them. Key order is the funnel order.
export const CODE_SHARE_FUNNEL_STEP_REASONS = {
    capture_armed: [],
    apply_ignored: [
        'bad-code-shape',
        'not-promo-field',
        'not-typed',
        'unsafe-control',
        'already-shared',
    ],
    apply_observed: [],
    store_accepted: [],
    store_not_accepted: ['not-committed', 'store-error', 'not-tied-to-code'],
    prompt_shown: [],
    prompt_accepted: [],
    prompt_declined: [],
    prompt_dismissed: [],
    submit_skipped: [
        'signed-out',
        'flag-off',
        'no-consent',
        'consent-rejected',
        'daily-limit',
        'rate-limited',
        'invalid-code',
        'not-a-store',
        'refused',
        'error',
    ],
    submit_sent: [],
}

export const CODE_SHARE_FUNNEL_BROWSERS = [
    'chrome',
    'edge',
    'firefox',
    'safari',
]

// background.js `{ skipped }` answer (and the page's own synthetic ones) ->
// the submit_skipped reason. `null` = already reported by its own step
// (prompt_declined / prompt_dismissed), so no second event. Any other value is
// the server's free-text 422 error (background.js passes `body.error`
// through), which must never reach telemetry as text: it is `refused`.
const SKIPPED_REASONS = {
    'signed-out': 'signed-out',
    disabled: 'flag-off',
    'no-consent': 'no-consent',
    'consent-rejected': 'consent-rejected',
    'daily-limit': 'daily-limit',
    'rate-limited': 'rate-limited',
    'invalid-code': 'invalid-code',
    'not-a-store': 'not-a-store',
    'consent-declined': null,
    'consent-dismissed': null,
}

export function funnelReasonForSkipped(skipped) {
    if (typeof skipped !== 'string' || skipped === '')
        throw new Error('funnelReasonForSkipped: skipped must be a string')
    return Object.hasOwn(SKIPPED_REASONS, skipped)
        ? SKIPPED_REASONS[skipped]
        : 'refused'
}

// A bare lowercase hostname (labels of a-z0-9 and inner hyphens, 2+ labels),
// the shape of a store config's `domain`. Rejects anything with a scheme, path,
// query, port, userinfo or whitespace.
const STORE_PATTERN =
    /^(?=.{3,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/
const VERSION_PATTERN = /^\d{1,5}(\.\d{1,5}){1,3}$/

// The ONE payload constructor. Throws on anything outside the vocabulary.
export function buildFunnelEvent({
    step,
    reason,
    store,
    extVersion,
    browser,
    sharingPromptVersion,
}) {
    if (!Object.hasOwn(CODE_SHARE_FUNNEL_STEP_REASONS, step))
        throw new Error(`code-share funnel: unknown step "${step}"`)
    const allowed = CODE_SHARE_FUNNEL_STEP_REASONS[step]
    if (allowed.length === 0 && reason !== undefined)
        throw new Error(`code-share funnel: step "${step}" takes no reason`)
    if (allowed.length > 0 && !allowed.includes(reason))
        throw new Error(
            `code-share funnel: step "${step}" needs a reason of ${allowed.join(', ')}`,
        )
    if (typeof store !== 'string' || !STORE_PATTERN.test(store))
        throw new Error('code-share funnel: store is not a bare hostname')
    if (typeof extVersion !== 'string' || !VERSION_PATTERN.test(extVersion))
        throw new Error('code-share funnel: extVersion is not x.y.z')
    if (!CODE_SHARE_FUNNEL_BROWSERS.includes(browser))
        throw new Error(`code-share funnel: unknown browser "${browser}"`)
    if (!Number.isInteger(sharingPromptVersion) || sharingPromptVersion < 1)
        throw new Error(
            'code-share funnel: sharingPromptVersion is not a positive integer',
        )
    return {
        step,
        ...(allowed.length > 0 ? { reason } : {}),
        store,
        extVersion,
        browser,
        sharingPromptVersion,
    }
}
