/* The shopper's own input, in jsdom.
 *
 * Our injected UI acts only on trusted events (UI-helpers.js
 * caramelShopperOnly): an event a page script makes, through .click() or
 * dispatchEvent, is never trusted, so it does nothing. jsdom has no real input,
 * and its dispatchEvent marks every event untrusted, so a test that stands in
 * for the shopper dispatches through jsdom's own internal path with the
 * event marked trusted, the way the browser does for a real click or key.
 *
 *   trustedClick(el)                 // a real click on el
 *   trustedKey(document, 'Escape')   // a real key press
 *
 * jsdom 30 keeps a wrapper's internal object in a private class field (it used
 * to be a symbol-keyed property), so it is read through jsdom's own
 * implForWrapper, the same function its generated bindings use.
 */
import { createRequire } from 'node:module'

const { implForWrapper } = createRequire(import.meta.url)(
    'jsdom/lib/generated/idl/utils.js',
)

export const implOf = o => {
    const impl = implForWrapper(o)
    if (!impl) throw new Error('not a jsdom object')
    return impl
}

export function dispatchTrusted(target, event) {
    const e = implOf(event)
    e.isTrusted = true
    return implOf(target)._dispatch(e)
}

export function trustedClick(el) {
    return dispatchTrusted(
        el,
        new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            composed: true,
        }),
    )
}

export function trustedKey(target, key, type = 'keydown') {
    return dispatchTrusted(
        target,
        new KeyboardEvent(type, {
            key,
            bubbles: true,
            cancelable: true,
            composed: true,
        }),
    )
}
