// src/lib/analytics/trackingOptOut.ts
//
// Caramel has no cookie-consent banner by design, so "consent-gated" session
// replay means honouring the browser's own opt-out signals: Global Privacy
// Control (GPC) and Do Not Track (DNT). Used by the Sentry Replay lazy-load
// (instrumentation-client.ts) and the PostHog recorder (identity.ts). Error
// reporting and event capture are NOT gated by this; only replay recording.

interface TrackingSignalNavigator {
    globalPrivacyControl?: boolean
    doNotTrack?: string | null
}

// `window.doNotTrack` is the legacy (IE/old Safari) location of the DNT flag.
interface TrackingSignalWindow {
    doNotTrack?: string | null
}

const DNT_ON_VALUES: readonly string[] = ['1', 'yes']

// Pass `null` to say "there is no navigator/window" explicitly (tests, SSR);
// leaving an argument out reads the real global when one exists.
export function browserSignalsTrackingOptOut(
    nav?: TrackingSignalNavigator | null,
    win?: TrackingSignalWindow | null,
): boolean {
    const navigatorToRead =
        nav === undefined
            ? typeof navigator === 'undefined'
                ? null
                : (navigator as TrackingSignalNavigator)
            : nav
    const windowToRead =
        win === undefined
            ? typeof window === 'undefined'
                ? null
                : (window as TrackingSignalWindow)
            : win
    if (navigatorToRead?.globalPrivacyControl === true) return true
    if (
        navigatorToRead?.doNotTrack &&
        DNT_ON_VALUES.includes(navigatorToRead.doNotTrack)
    ) {
        return true
    }
    return windowToRead?.doNotTrack === '1'
}
