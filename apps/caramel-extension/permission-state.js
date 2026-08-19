// owns: the every-website host-permission grant — reading whether we have it,
// and asking the browser for it from a user gesture.
//
// Why this module exists (measured in real Firefox, 2026-08-18): with the
// `https://*/*` grant missing, the background fetch to the API fails (the
// server sends no CORS headers to an origin it was never asked to trust) and
// the popup painted LoadErrorView — "Couldn't load coupons — check your
// connection and try again". The connection was fine. The extension simply had
// no permission to use it, and the copy sent users hunting for a network fault
// that did not exist. Two real cohorts land here: Firefox auto-updates from
// <=1.0.3, which silently kept only the four old narrow host grants, and fresh
// installs where the user leaves the box unchecked.
//
// The extension had ZERO `permissions.*` usage before this module.

import { isSafariExtensionRuntime } from './caramel-base.js'
import { CARAMEL_BASE_URL } from './caramel-env.js'

/**
 * The permissions API as PROMISES, or null where the runtime has none.
 *
 * Firefox and Safari expose a promise-style `browser.permissions`; Chrome and
 * Edge expose a callback-style `chrome.permissions`. The distinction is not
 * cosmetic here: caramel-base's bootstrap resolves `currentBrowser` to
 * `chrome` FIRST when both globals exist, which on Firefox is the
 * callback-shaped object — so reading the API off `currentBrowser` and calling
 * `.then` on the result would silently do nothing on the one browser this
 * whole module was written for. Prefer `browser` explicitly, wrap `chrome`.
 */
function getPermissionsApi() {
    const promiseStyle = globalThis.browser?.permissions
    if (promiseStyle && typeof promiseStyle.contains === 'function') {
        return {
            contains: perms => promiseStyle.contains(perms),
            request: perms => promiseStyle.request(perms),
        }
    }

    const callbackStyle = globalThis.chrome?.permissions
    if (callbackStyle && typeof callbackStyle.contains === 'function') {
        const wrap = method => perms =>
            new Promise((resolve, reject) => {
                try {
                    callbackStyle[method](perms, result => {
                        const err = globalThis.chrome?.runtime?.lastError
                        if (err) reject(new Error(err.message || String(err)))
                        else resolve(result)
                    })
                } catch (e) {
                    reject(e)
                }
            })
        return { contains: wrap('contains'), request: wrap('request') }
    }

    return null
}

// The match pattern that MEANS "every website" to this runtime.
//
// Safari only treats <all_urls> (or *://*/*) as the every-website grant —
// handed https://*/* it records a narrower permission and the "Always Allow on
// Every Website" state never turns on. Chrome, Edge and Firefox take
// https://*/*, which is exactly what the manifest's host_permissions asks for,
// so contains() compares like against like.
//
// Line comments rather than a block: the patterns themselves contain `*/`,
// which would close a /* */ comment mid-sentence.
export function allSitesOriginPattern() {
    return isSafariExtensionRuntime() ? '<all_urls>' : 'https://*/*'
}

/**
 * Does the browser hold the every-website grant? `true` / `false`, or `null`
 * when the runtime cannot tell us (no permissions API, a throw, an answer that
 * is not a boolean). `null` is not `false`: the banner keys on an explicit
 * `false`, because telling a working install it has no permission is worse
 * than saying nothing.
 *
 * Carries NO timeout on purpose. Its one caller is a React effect on a banner
 * that starts hidden, so a callback-style API that never calls back simply
 * leaves this pending and shows no banner — which is already the right answer
 * for a runtime that cannot tell us. A deadline here would buy nothing and
 * cost a live timer on every mount.
 */
export function resolveAllSitesGranted() {
    const api = getPermissionsApi()
    if (!api) return Promise.resolve(null)
    return api
        .contains({ origins: [allSitesOriginPattern()] })
        .then(has => (typeof has === 'boolean' ? has : null))
        .catch(() => null)
}

/**
 * Can an extension page reach our own API at all? Returns 'ok' for ANY
 * response (a 404, a 429 and a 500 all prove the request was allowed to
 * leave), 'blocked' for the `TypeError` a missing host permission produces,
 * and 'err' for anything else.
 *
 * Deliberately NOT branched on the error message: "NetworkError when
 * attempting to fetch resource" (Firefox) and "Failed to fetch" (Chromium) are
 * the same fact spelled two ways, and Safari spells it a third. The TYPE is
 * the contract — `fetch` rejects with `TypeError` and nothing else for a
 * request the browser refused to make.
 */
async function probeApiReachable() {
    try {
        await fetch(
            new URL(
                'api/extension/supported-stores',
                `${CARAMEL_BASE_URL}/`,
            ).toString(),
            { method: 'GET' },
        )
        return 'ok'
    } catch (e) {
        return e instanceof TypeError ? 'blocked' : 'err'
    }
}

/**
 * Why the popup could not load coupons, when it could not:
 *
 *   'granted'          — the request left the machine; permissions are not it
 *   'needs_permission' — the browser refused the request outright
 *   'network'          — a real transport failure; the connection copy is right
 *   'unknown'          — the runtime has no permissions API, so there is
 *                        nothing this popup could offer to fix
 *
 * The PROBE decides on its own, and `contains()` is deliberately NOT consulted
 * here. Chrome's `contains()` answers about the effective grant, which our
 * manifest's overlapping `content_scripts` patterns muddy, so it is not
 * trustworthy enough to bury a working install behind a permission prompt —
 * and a narrow-but-working grant leads to the same view as a healthy one
 * anyway, so asking would only be work that changes no answer.
 *
 * Only called when the coupon fetch has already FAILED, so its extra request
 * costs a user nothing on the path they actually walk — see the success-path
 * note in popup-core.js resolvePopupState().
 */
export async function resolvePermissionState() {
    // A false gate is worse than no gate, and a permission view whose button
    // cannot request anything is a dead end: with nothing to ask and nothing
    // to offer, say so and let the caller render the failure it already had.
    if (!getPermissionsApi()) return 'unknown'

    const probe = await probeApiReachable()
    if (probe === 'blocked') return 'needs_permission'
    if (probe === 'err') return 'network'
    return 'granted'
}

/**
 * Ask for the every-website grant. MUST be called straight out of a click:
 * all four browsers reject `permissions.request()` that is not attributable to
 * a user gesture, and an `await` before it ends the gesture. Everything above
 * the request here is synchronous by construction — no await, no microtask.
 *
 * `onGranted` may never run on Firefox: its permission doorhanger can tear the
 * popup down while the prompt is open, taking this continuation with it. That
 * is fine and deliberate — the popup re-derives permission state on every
 * open, so the next open shows the truth either way.
 */
export function requestAllSites(onGranted) {
    const api = getPermissionsApi()
    if (!api) return
    api.request({ origins: [allSitesOriginPattern()] })
        .then(granted => {
            if (granted) onGranted()
        })
        .catch(() => {
            // A refused or dismissed prompt is an ANSWER, not a fault: the
            // view stays exactly as it was and the user can ask again.
        })
}
