// Split out of UI-helpers.js (T-5446), moved verbatim: no behavior change.
import { caramelMarkOwnHost, currentBrowser, log } from './caramel-base.js'

// Inline SVG close glyph (stroke follows the button's currentColor).
export const CARAMEL_X_ICON =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>'
// Functional-minimum styles used ONLY when the stylesheet fetch fails.
// The `img` cap is load-bearing: every surface draws the logo PNG at its natural
// size without content-ui.css. Measured 2026-10-28 with 1.4.25 on scosche.com:
// the stylesheet lost its 4s race while the checkout re-rendered after a code
// applied, and the final modal's logo filled the whole window, pushing "You
// saved $15.98" out of view. Sizes match content-ui.css (prompt 32, modals 40-44).
export const CARAMEL_UI_FALLBACK_CSS =
    'img{width:40px;height:40px;object-fit:contain}' +
    '.cm-scrim{width:100%;height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(15,12,10,.5)}' +
    '#caramel-testing-modal,.caramel-final-modal{background:#fff;color:#111;padding:24px;border-radius:16px;font-family:sans-serif;text-align:center}' +
    '.cm-prompt{background:#ea6925;color:#fff;padding:14px;border-radius:16px;font-family:sans-serif}'

// Host positioning, applied INLINE — the authoritative cross-browser source
// (Firefox's manifest ships no content css; caramel-content.css repeats
// these as Chrome's light-DOM backup — keep in sync).
//
// `direction:ltr` is load-bearing, not cosmetic. `direction` is an INHERITED
// property and inheritance crosses into shadow DOM, so on an RTL storefront our
// surfaces silently flipped: measured on mango.com/ae (QA sweep 2026-08-06), the
// coupon descriptions ellipsised at their visual LEFT — which is the logical
// end under RTL — so "20% off orders over $50" rendered as "…orders over $50"
// and the discount rate, the only thing a shopper is scanning for, was the part
// that got cut. Our copy is English; it is LTR text regardless of the page it
// lands on. Set on the HOST so every surface inherits it before any rule runs.
// `display:block !important` is the one declaration here that is not layout.
// A shadow host has no light-DOM children, so it matches `:empty`, and themes
// that hide empty containers hide US: 1thrive.com rendered the prompt 0x0 with
// display:none while every log said it worked (measured 2026-08-06 with the
// extension loaded). Full account and the pins: tests/host-survives-page-css.

const CARAMEL_OVERLAY_HOST_CSS =
    'display:block !important;position:fixed;top:0;left:0;width:100vw;height:100vh;height:100dvh;z-index:2147483647;direction:ltr;'
// The prompt takes the HIGHEST z-index a page can use, not one below it.
// knix.com's cart drawer is a fixed panel at 2147483647, so at 2147483646 the
// prompt sat underneath the open drawer and a shopper's tap landed on the
// drawer (measured 2026-10-31 with a real click at the prompt's centre). At an
// equal z-index the element later in the page paints on top, and the prompt
// is appended to the end of <body>. Nothing is lost by the tie with our own
// overlays: the prompt is removed the moment a run starts.
export const CARAMEL_HOST_CSS = {
    'caramel-small-prompt':
        'display:block !important;position:fixed;top:max(20px,env(safe-area-inset-top));right:max(20px,env(safe-area-inset-right));z-index:2147483647;width:min(88vw,300px);cursor:pointer;outline:none;direction:ltr;',
    'caramel-testing-overlay': CARAMEL_OVERLAY_HOST_CSS,
    'caramel-final-overlay': CARAMEL_OVERLAY_HOST_CSS,
    // The consent card: a small, NON-modal card in the bottom-right corner, so
    // the shopper's checkout stays usable while they decide.
    'caramel-share-prompt':
        'display:block !important;position:fixed;bottom:max(20px,env(safe-area-inset-bottom));right:max(20px,env(safe-area-inset-right));z-index:2147483646;width:min(92vw,360px);direction:ltr;',
}

// Cached across all three surfaces. Exported because whether this cache is
// still held after a race is exactly what tests/content-css-timer.test.mjs
// pins — it read the pre-ESM script global of the same name.
export let _caramelShadowCssPromise = null
/* Every injected surface AWAITS this before appending itself, so a fetch that
 * never settles isn't a missing stylesheet — it's an extension that silently
 * never appears at all. A rejection already falls back loudly; a hang couldn't
 * reach that path. Bounded, and the cached promise is dropped on timeout so a
 * later surface can still get the real CSS. */
const CARAMEL_UI_CSS_TIMEOUT_MS = 4000
export function _caramelGetShadowCss() {
    if (!_caramelShadowCssPromise) {
        const grab = async file => {
            const res = await fetch(currentBrowser.runtime.getURL(file))
            if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`)
            return res.text()
        }
        // The budget timer MUST be cancelled once the real CSS settles.
        // Racing without cancelling still fires the callback 4s later on
        // every surface: it logged a TIMEOUT that never happened (masking a
        // real CSS failure behind routine noise) and dropped a healthy cached
        // promise, forcing every later surface to refetch. The packaged
        // assets are local, so the race is won in single-digit ms even on
        // Slow 3G — every one of those logs was false.
        let timer
        const real = Promise.all([
            grab('assets/tokens.css'),
            grab('assets/content-ui.css'),
        ]).then(
            ([tokens, ui]) =>
                tokens.replace(/:root/g, ':host, :root') + '\n' + ui,
        )
        const mine = Promise.race([
            // .finally, not .then: a genuine rejection must still reach the
            // .catch below (and still log LOAD_FAILED) with the timer cleared.
            real.finally(() => clearTimeout(timer)),
            new Promise(resolve => {
                timer = setTimeout(() => {
                    log('CONTENT_UI_CSS_TIMEOUT')
                    if (_caramelShadowCssPromise === mine)
                        _caramelShadowCssPromise = null
                    resolve(CARAMEL_UI_FALLBACK_CSS)
                }, CARAMEL_UI_CSS_TIMEOUT_MS)
            }),
        ]).catch(err => {
            log('CONTENT_UI_CSS_LOAD_FAILED', { error: String(err) })
            return CARAMEL_UI_FALLBACK_CSS
        })
        _caramelShadowCssPromise = mine
    }
    return _caramelShadowCssPromise
}

/* Light-DOM host <div id=id> (inline positioning, no visuals) + OPEN shadow
 * root carrying the shared stylesheet. NOT appended — callers build into
 * `root`, wire listeners, then append the host, fully styled. */
export async function createCaramelShadowHost(id) {
    const host = caramelMarkOwnHost(document.createElement('div'))
    host.id = id
    host.style.cssText = CARAMEL_HOST_CSS[id] || ''
    const root = host.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = await _caramelGetShadowCss()
    root.appendChild(style)
    return { host, root }
}

/* Every control in our UI acts only on the shopper's own input. Our UI sits
 * in the store's page, which can reach it (and click it, or press its keys)
 * from a script; an event a script makes is never trusted, so it does
 * nothing here: it cannot start a run, stop one, share a code, open the
 * popup or close a card. Logged, so a page that tries is visible. */
// Exported for tests/injected-ui-trusted-input.test.mjs.
export function caramelShopperOnly(handler) {
    return event => {
        if (!event?.isTrusted) {
            log('UI_EVENT_NOT_TRUSTED', { type: event?.type || null })
            return
        }
        return handler(event)
    }
}

/* Focus trap: Tab/Shift+Tab cycle within the shadow root's focusables,
 * never the host page. On the modal container — no document listener. */
export function _caramelInstallFocusTrap(root, modal) {
    modal.addEventListener('keydown', e => {
        if (e.key !== 'Tab') return
        const focusables = Array.from(
            root.querySelectorAll(
                'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
            ),
        ).filter(el => !el.disabled)
        if (!focusables.length) return
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        const active = root.activeElement
        if (e.shiftKey) {
            if (!active || active === first || active === modal) {
                e.preventDefault()
                last.focus()
            }
        } else if (!active || active === last || active === modal) {
            e.preventDefault()
            first.focus()
        }
    })
}

/* Restore focus to the pre-dialog element (stored on the host). */
export function _caramelRestoreFocus(host) {
    const prev = host.__caramelPrevFocus
    if (prev && prev.isConnected && typeof prev.focus === 'function') {
        try {
            prev.focus()
        } catch {
            /* focus is best-effort */
        }
    }
}
