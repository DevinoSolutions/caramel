// Split out of coupon-runner.js (T-5446), moved verbatim: no behavior change.
import {
    CARAMEL_ALLOWED_ORIGINS,
    caramelGetSession,
    currentBrowser,
    log,
    logError,
    sleep,
} from './caramel-base.js'
import { recordWelcomeFirstTouch } from './install-attribution.js'

/* Announce ourselves to grabcaramel.com so a visitor already signed in there
 * doesn't have to sign in again in the extension.
 *
 * It used to be one hello, sent the moment storage answered "no token". That
 * loses a race it cannot see: the page's side of the handshake is a React
 * component (ExtensionSessionRelay), and its `message` listener only exists once
 * React has hydrated. A content script at document_idle regularly beats
 * hydration — on a cold load, a slow connection, or simply a heavy page — and a
 * hello sent before anyone is listening is a hello nobody answers. The page
 * already covers the OTHER half of this race (it replays a hello it heard before
 * the session query resolved), so the gap is exactly the case where we spoke
 * first: the user signs in on the website, comes back to a store, and the
 * extension still believes it is signed out.
 *
 * So say it a few times, and stop the instant it works. We are the side that can
 * tell: the `message` listener initCouponRunner (coupon-runner.js) installs
 * writes the token as soon as the page answers, so a token in storage IS the
 * acknowledgement. Bounded tightly — this is a courtesy
 * handshake on our own origin, not a retry loop worth spending a page's life on.
 */
// Presence stamp for the website (fleet growth-prompts spec §A). On our own
// origins the site must never tell a visitor to "get the extension" when it
// is already running in their browser, so the content script marks <html>
// with `data-caramel-extension="<version>"` — readable by CSS before the
// page's JavaScript has even hydrated — and posts a `caramel-ext-present`
// message for the SurfaceProvider. Unlike the sign-in hello below this is
// NOT session-gated: a signed-in extension user is exactly who the site
// used to advertise to. Exported for the suite; called from initCouponRunner.
export const CARAMEL_PRESENCE_ATTRIBUTE = 'data-caramel-extension'
export function caramelStampPresence() {
    let version = ''
    try {
        version = currentBrowser?.runtime?.getManifest?.()?.version || ''
    } catch (err) {
        // The stamp still lands — the site only needs to know we are here.
        logError('PRESENCE_STAMP_VERSION_FAILED', err)
    }
    document.documentElement.setAttribute(CARAMEL_PRESENCE_ATTRIBUTE, version)
    window.postMessage(
        { type: 'caramel-ext-present', version },
        location.origin,
    )
}

/* Install attribution (see install-attribution.js): on the /welcome page the
 * extension opened after install, copy the site's first-touch record
 * (`cm_ft`, first-party and readable here) next to the stored install id, so
 * the sign-in can hand it to the server. The site writes that cookie from its
 * own client code, which can run after this content script does, so ask a few
 * times and stop at the first definite answer. Anything but 'no-cookie' is
 * definite; after the last try 'no-cookie' is logged, not silently dropped.
 * Exported for the suite; called from initCouponRunner. */
const CARAMEL_FIRST_TOUCH_TRIES = 6
const CARAMEL_FIRST_TOUCH_GAP_MS = 1500
export async function caramelCaptureInstallFirstTouch() {
    for (let i = 0; i < CARAMEL_FIRST_TOUCH_TRIES; i++) {
        const { status, invalid } = await recordWelcomeFirstTouch(
            currentBrowser,
            {
                href: location.href,
                cookie: document.cookie,
                trustedOrigins: CARAMEL_ALLOWED_ORIGINS,
            },
        )
        if (invalid.length)
            logError(
                'INSTALL_FIRST_TOUCH_COOKIE_INVALID',
                new Error(invalid.join('; ')),
            )
        if (status !== 'no-cookie') {
            if (status === 'saved')
                log('INSTALL_FIRST_TOUCH_SAVED', { tries: i + 1 })
            return status
        }
        if (i + 1 < CARAMEL_FIRST_TOUCH_TRIES)
            await sleep(CARAMEL_FIRST_TOUCH_GAP_MS)
    }
    log('INSTALL_FIRST_TOUCH_ABSENT', { tries: CARAMEL_FIRST_TOUCH_TRIES })
    return 'no-cookie'
}

const CARAMEL_HELLO_TRIES = 5
const CARAMEL_HELLO_GAP_MS = 600
// Called from initCouponRunner() below; exported for the suite.
export async function caramelAnnounceToWebsite() {
    for (let i = 0; i < CARAMEL_HELLO_TRIES; i++) {
        let token = null
        try {
            token = (await caramelGetSession())?.token || null
        } catch {
            // Storage unavailable — we could never tell whether it worked, so
            // stop rather than shout into the page on a loop.
            return
        }
        if (token) {
            if (i > 0) log('EXT_HELLO_ANSWERED', { attempt: i })
            return
        }
        window.postMessage({ type: 'caramel-ext-hello' }, location.origin)
        if (i + 1 < CARAMEL_HELLO_TRIES) await sleep(CARAMEL_HELLO_GAP_MS)
    }
    log('EXT_HELLO_UNANSWERED', {
        tries: CARAMEL_HELLO_TRIES,
        reason: 'nobody on the page answered — the visitor is most likely signed out there',
    })
}
