// owns: the popup-open DAILY-ACTIVE event's payload and its local
// once-per-UTC-day delivery state (storage.local `caramel_activity_state`).
//
// WHAT IT IS. "Opted-in daily active Google Chrome installations", not total
// DAU. background.js reportDailyActive sends it, in this order and failing
// closed at each step:
//   1. the popup was opened (popup-core.js recordPopupActivity, the ONLY
//      trigger; the worker refuses the message from any other sender);
//   2. detectStoreChannel() says Google Chrome (the Chrome zip also ships to
//      Edge and is converted for Safari; Firefox is its own build);
//   3. resolveUsageDiagnostics() — the shopper accepted usage diagnostics on
//      the prompt-version-2 card that names this event. Nothing below, not
//      even the features read or the state read, happens without it;
//   4. the cached features flag `extensionDauTelemetry` is exactly true (a
//      failed read is "off");
//   5. this state says today is not already sent and not cooling down.
// It then goes out through the SAME bearer-less POST /api/extension/telemetry as
// the code-share funnel (postUsageDiagnostic): the existing diagnostics id
// (`caramel_usage_diagnostics_id`, minted only on the accept path, deleted on
// withdrawal) as its only identity, the consent record as proof, no bearer,
// no cookies — so guests and signed-in shoppers send byte-identical bodies.
//
// DELIVERY. Only a captured answer marks the day sent. Any failure (network,
// timeout, non-2xx, not captured, the server refusing the consent proof) sets
// a 30-minute cooldown for that UTC day instead; nothing ever retries on its
// own, so the next popup open after it is the retry. A cooldown never
// outlives its UTC day, and one further out than its own length (a clock that
// moved back) is ignored rather than honoured.
//
// The server contract (strict schema, day policy, PostHog event) lives in
// apps/caramel-app/src/lib/extensionActivity.ts; its mirror test parses
// buildDailyActiveEvent's output with that schema.
//
// Pure apart from the storage calls, which take the browser handle; no
// top-level effects.
import { storageCall } from './usage-diagnostics-consent.js'

const ACTIVITY_STATE_KEY = 'caramel_activity_state'
const ACTIVITY_RETRY_COOLDOWN_MS = 30 * 60 * 1000

export const utcDay = ms => new Date(ms).toISOString().slice(0, 10)

// The ONE payload constructor: exactly the reviewed fields.
export const buildDailyActiveEvent = (day, extVersion) => ({
    kind: 'daily_active',
    day,
    extVersion,
    browser: 'chrome',
})

// Is a send due on `day` at `nowMs`, given the stored state? Rejects when
// storage fails (the caller answers that as an error, sending nothing).
export async function activityDue(browser, day, nowMs) {
    const res = await storageCall(
        browser,
        'local',
        'get',
        [ACTIVITY_STATE_KEY],
        'activity state read',
    )
    const state = res?.[ACTIVITY_STATE_KEY]
    if (state?.sentDay === day) return false
    if (state?.retryDay !== day) return true
    const wait = state.retryAfter - nowMs
    return !(wait > 0 && wait <= ACTIVITY_RETRY_COOLDOWN_MS)
}

// `sent` true marks `day` done; false starts its bounded cooldown.
export const writeActivityState = (browser, day, nowMs, sent) =>
    storageCall(
        browser,
        'local',
        'set',
        {
            [ACTIVITY_STATE_KEY]: sent
                ? { sentDay: day }
                : {
                      retryDay: day,
                      retryAfter: nowMs + ACTIVITY_RETRY_COOLDOWN_MS,
                  },
        },
        'activity state write',
    )
