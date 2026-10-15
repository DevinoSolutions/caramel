// owns: the permissions API as PROMISES, in one import-free module.
//
// Split out of permission-state.js (2026-10-15) so the service worker can ask
// the same question: permission-state.js imports caramel-base.js, which the
// worker cannot load (no `window`), while this file touches only globals. The
// popup's every-website grant and the Firefox data-collection grant
// (usage-diagnostics-consent.js) both go through it.

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
export function getPermissionsApi() {
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
