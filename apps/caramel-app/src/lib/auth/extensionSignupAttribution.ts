// src/lib/auth/extensionSignupAttribution.ts
//
// The OPTIONAL attribution an extension build hands to its sign-in:
//
//   iid          the install id the extension minted at install (the same uuid
//                /welcome reported as the `extension_installed` event uuid);
//   firstTouch   the site's `cm_ft` first-touch record, read by the extension
//                on its own /welcome page (a fetch from the extension carries
//                no site cookie, so this is the only way it reaches the server).
//
// Both are CLIENT-SUPPLIED, so they are validated with the same definitions the
// rest of the pipeline shares (INSTALL_ID_PATTERN, firstTouchRecordSchema via
// parseFirstTouchRecord) and an invalid field is DROPPED, never a 400: sign-in
// must not fail because attribution was malformed, and old builds send neither.
// A dropped field is loud, though: a Sentry warning says which field and why
// (the reason only, never the value), because malformed attribution means
// client/server drift or tampering and deserves to be noticed.
import {
    parseFirstTouchRecord,
    type FirstTouchRecord,
} from '@/lib/analytics/firstTouchRecord'
import { INSTALL_ID_PATTERN } from '@/lib/extensionInstall'
import * as Sentry from '@sentry/nextjs'

/** What the sign-in could trust of the client's attribution. */
export interface ExtensionSignupAttribution {
    installId: string | null
    firstTouch: FirstTouchRecord | null
}

export const NO_EXTENSION_ATTRIBUTION: ExtensionSignupAttribution = {
    installId: null,
    firstTouch: null,
}

/** Where the raw fields came from, for the Sentry warning. */
type ExtensionAttributionSource = 'oauth_body' | 'authorize_query'

function reportDropped(
    source: ExtensionAttributionSource,
    field: 'iid' | 'firstTouch',
    reason: string,
): void {
    Sentry.captureMessage(
        'extension sign-in attribution field invalid; dropped',
        {
            level: 'warning',
            tags: { operation: 'extension_signup_attribution', source },
            extra: { field, reason },
        },
    )
}

/**
 * Validate the optional fields. `undefined`/`null` is simply absent (an old
 * build), not an error; anything present but invalid is dropped and reported.
 */
export function resolveExtensionAttribution(
    raw: { iid?: unknown; firstTouch?: unknown },
    source: ExtensionAttributionSource,
): ExtensionSignupAttribution {
    let installId: string | null = null
    if (raw.iid !== undefined && raw.iid !== null) {
        if (typeof raw.iid === 'string' && INSTALL_ID_PATTERN.test(raw.iid)) {
            installId = raw.iid
        } else {
            reportDropped(source, 'iid', 'not an install id')
        }
    }

    let firstTouch: FirstTouchRecord | null = null
    if (raw.firstTouch !== undefined && raw.firstTouch !== null) {
        const parsed = parseFirstTouchRecord(raw.firstTouch)
        if (parsed.ok) {
            firstTouch = parsed.record
        } else {
            reportDropped(source, 'firstTouch', parsed.reason)
        }
    }

    return { installId, firstTouch }
}

/**
 * The same fields from /authorize's query string (the Safari flow, whose
 * exchange happens server-side and so cannot carry them in a POST body):
 * `iid` and `ft` (the record as JSON). A `ft` that is not JSON is reported
 * and dropped like any other invalid field.
 */
export function extensionAttributionFromQuery(
    searchParams: URLSearchParams,
): ExtensionSignupAttribution {
    const rawFirstTouch = searchParams.get('ft')
    let firstTouch: unknown
    if (rawFirstTouch !== null) {
        try {
            firstTouch = JSON.parse(rawFirstTouch)
        } catch {
            reportDropped('authorize_query', 'firstTouch', 'not JSON')
        }
    }
    return resolveExtensionAttribution(
        { iid: searchParams.get('iid') ?? undefined, firstTouch },
        'authorize_query',
    )
}
