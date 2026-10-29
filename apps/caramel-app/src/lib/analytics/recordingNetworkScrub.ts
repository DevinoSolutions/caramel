// src/lib/analytics/recordingNetworkScrub.ts
//
// PostHog session recordings include the network requests the page made
// (performance capture is on for the Caramel project), and each recorded
// request carries its full URL. The store searches put what a shopper TYPED in
// that URL: GET /api/coupons/stores?q=, GET /api/coupons?search=&key_words=, and
// the `query` body field of POST /api/sites/search-supported. That text must not
// be stored in a recording (T-7505), so every captured request passes through
// here before posthog-js records it.
//
// The rules are NOT restated here: the URL and body text go through
// `redactSensitiveText` from sentryPiiScrub.ts, the same helper (and the same
// parameter list, SENSITIVE_PARAM_EXACT there) that scrubs Sentry events,
// breadcrumbs and Session Replay frames, so the two analytics paths cannot
// drift apart. It also strips credentials (?code=, ?state=, tokens), e-mail
// addresses and IPs from a recorded URL, which a recording had no reason to
// keep either.
//
// Setting this hook replaces posthog-js's default body scrubbing, which only
// matters when body capture is on (it is off: the project has no network
// payload capture config). String bodies and header values still go through
// the same redaction, so turning payload capture on later does not reopen the
// hole.
import { redactSensitiveText } from '@/lib/sentryPiiScrub'
import type { PostHogConfig } from 'posthog-js'

type MaskCapturedNetworkRequest = NonNullable<
    NonNullable<
        PostHogConfig['session_recording']
    >['maskCapturedNetworkRequestFn']
>
type CapturedNetworkRequest = Parameters<MaskCapturedNetworkRequest>[0]

function redactHeaders(
    headers: CapturedNetworkRequest['requestHeaders'],
): CapturedNetworkRequest['requestHeaders'] {
    if (!headers) return headers
    const redacted: Record<string, string> = {}
    for (const [name, value] of Object.entries(headers)) {
        redacted[name] = redactSensitiveText(String(value))
    }
    return redacted
}

/** posthog-js `session_recording.maskCapturedNetworkRequestFn`. Mutates and
 * returns the same request object, which is what the SDK expects. Never drops
 * a request: an initial navigation entry must keep its timing metadata. */
export const scrubRecordedNetworkRequest: MaskCapturedNetworkRequest =
    request => {
        if (typeof request.name === 'string') {
            request.name = redactSensitiveText(request.name)
        }
        if (typeof request.requestBody === 'string') {
            request.requestBody = redactSensitiveText(request.requestBody)
        }
        if (typeof request.responseBody === 'string') {
            request.responseBody = redactSensitiveText(request.responseBody)
        }
        request.requestHeaders = redactHeaders(request.requestHeaders)
        request.responseHeaders = redactHeaders(request.responseHeaders)
        return request
    }
