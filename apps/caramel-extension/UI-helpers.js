//UI HELPERS
//
// ES module since the WXT P1 port (2026-08-12). No top-level statement in this
// file DOES anything — it is all declarations — so there is no `init` export;
// every surface is built on call. The two `if (typeof X === 'undefined') var X`
// re-injection guards are gone with the script realm that needed them (a
// bundled module evaluates once per injection into its own scope, so there is
// nothing left to redeclare); their state is now plain module-scope `let`.
//
// Phase 3: each injected surface is a LIGHT-DOM HOST <div> with the
// historical id (caramel-small-prompt / caramel-testing-overlay /
// caramel-final-overlay) on document.body — store-detect.js getElementById
// presence checks keep working — with ALL visuals in its open shadow root.
// Styles: assets/content-ui.css + assets/tokens.css (web_accessible in BOTH
// manifests) fetched ONCE, tokens rewritten ':root' → ':host, :root', one
// <style> per shadow root, awaited before append (no unstyled flash).
// Embedding the CSS as a JS string was rejected: the summed content-script
// size budget (.size-limit.js) counts JS bytes, not fetched CSS.

import {
    caramelGetSession,
    caramelPromptAllowed,
    currentBrowser,
    log,
    logError,
} from './caramel-base.js'
import { CARAMEL_ENV } from './caramel-env.js'
// coupon-runner.js imports showTestingModal/updateTestingModal/hideTestingModal/
// showFinalModal back from here. The cycle is fine: neither side READS the
// other's binding during module evaluation, only inside functions.
import { startApplyingCoupons } from './coupon-runner.js'
import { caramelCancelRun, caramelCurrencySymbol } from './dom-utils.js'

// Inline SVG close glyph (stroke follows the button's currentColor).
const CARAMEL_X_ICON =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>'

// Upper bound on the manual copy list. 20 = the per-store limit background.js
// asks the API for, so in practice this shows everything we fetched.
const CARAMEL_MANUAL_LIST_MAX = 20

// Guests get the SAME teaser cap here as the popup's coupon list
// (popup.js GUEST_COUPON_LIMIT). Without it the manual fallback quietly hands a
// signed-out shopper up to 20 codes while the popup shows them 6 — leaking the
// gated value and skipping the sign-in nudge. Keep in sync with popup.js.
const CARAMEL_MANUAL_GUEST_LIMIT = 6

// Functional-minimum styles used ONLY when the stylesheet fetch fails.
const CARAMEL_UI_FALLBACK_CSS =
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
export const CARAMEL_HOST_CSS = {
    'caramel-small-prompt':
        'display:block !important;position:fixed;top:max(20px,env(safe-area-inset-top));right:max(20px,env(safe-area-inset-right));z-index:2147483646;width:min(88vw,300px);cursor:pointer;outline:none;direction:ltr;',
    'caramel-testing-overlay': CARAMEL_OVERLAY_HOST_CSS,
    'caramel-final-overlay': CARAMEL_OVERLAY_HOST_CSS,
}

// Cached across all three surfaces.
let _caramelShadowCssPromise = null
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

/* How far down the pill has to start to clear the store's own top bar.
 *
 * It is fixed 20px from the top-right and up to 300px wide — on a phone, most
 * of the header — and QA kept finding it on the store's logo, its nav, or a
 * hand's width from the store's OWN ×. Reading as "part of this website, in the
 * way" is the worst first impression an injected surface can make.
 *
 * Measured, and only ever downward: start below what is up there, and with
 * nothing up there stay exactly where we always were. Split from the DOM probe
 * so the decision is testable without layout, which jsdom has none of.
 */
const CARAMEL_PROMPT_BASE_TOP = 20
const CARAMEL_PROMPT_MAX_DODGE = 200
export function caramelPromptTopFor(barBottom) {
    const bottom = Number(barBottom)
    if (!Number.isFinite(bottom) || bottom <= CARAMEL_PROMPT_BASE_TOP)
        return CARAMEL_PROMPT_BASE_TOP
    if (bottom > CARAMEL_PROMPT_MAX_DODGE) return CARAMEL_PROMPT_BASE_TOP
    return Math.round(bottom) + 12
}
/* Is this element something we would land on top of?
 *
 * Every clause has a live counterexample (2026-08-06, carts at 1440 and 390);
 * none should go without a fresh one. hidden — allbirds and toms park drawers
 * up here. on-screen — 100percentpure holds panels at top:-300px. width —
 * toms' cookie banner is pinned 90→266 at 45% wide, and reading THAT as a bar
 * blows the budget and drops the pill back onto the header. dodgeable — a bar
 * we cannot clear must not mask one we can; goodr's full-viewport OneTrust
 * scrim fails here, which is why no separate scrim clause exists. The old bug
 * was never that the scrim counted as a bar — it was that the scrim HID one.
 *
 * overlap makes this a collision rule rather than a how-tall-is-the-chrome
 * rule, and it cuts both ways: cultbeauty at 390 pins its header at 120→185,
 * wholly below the pill, and an earlier version of this moved 177px to dodge
 * something it never touched.
 *
 * isBanner admits ONE unpinned element (see _caramelPageBanner) because an
 * unpinned header still collides on arrival, the moment a shopper decides what
 * we are: 100percentpure's static header reaches 121 and the pill sat across
 * its logo and search. Scrolled past, it has a negative rect and drops out.
 *
 * Takes a style and a rect, not an element, so the rule is testable where jsdom
 * has no layout to produce either.
 */
const CARAMEL_BAR_MIN_WIDTH_RATIO = 0.5
// Measured with the real stylesheets: 81px at 1440, 390 and 360 alike — the
// copy is fixed English and does not wrap even on the narrowest phone.
const CARAMEL_PROMPT_HEIGHT = 81
export function _caramelBarQualifies(style, rect, vw, isBanner) {
    if (!style || !rect) return false
    const pinned = style.position === 'fixed' || style.position === 'sticky'
    if (!pinned && !isBanner) return false
    if (style.visibility === 'hidden' || style.display === 'none') return false
    if (Number(style.opacity) === 0) return false
    if (!(rect.height > 0)) return false
    if (!(rect.bottom > CARAMEL_PROMPT_BASE_TOP)) return false
    if (!(rect.top < CARAMEL_PROMPT_BASE_TOP + CARAMEL_PROMPT_HEIGHT))
        return false
    if (rect.bottom > CARAMEL_PROMPT_MAX_DODGE) return false
    if (vw && rect.width < vw * CARAMEL_BAR_MIN_WIDTH_RATIO) return false
    return true
}

/* The one element allowed to count as an UNPINNED top bar.
 *
 * "Any visible <header> near the top" is too generous, and tog24 is why: its
 * cart carries FIVE, one per component (a mini-cart's at 84→160), and honouring
 * the lowest pushed the pill 57px below a header it had already cleared. The
 * spec's rule for when <header> means role="banner" — not inside
 * article/aside/main/nav/section — discards three of the five, but not the
 * mini-cart, which sits in a custom element matching no sectioning selector.
 *
 * Document order separates them: on both stores the page's header is FIRST and
 * every component header follows. So take one candidate and apply the spec rule
 * to it; a store hiding a decorative <header> above its real one yields nothing
 * and falls back to the pinned sweep, which is the conservative direction.
 */
export function _caramelPageBanner() {
    const el = document.querySelector('header, [role="banner"]')
    if (!el) return null
    if (el.parentElement?.closest('article, aside, main, nav, section'))
        return null
    return el
}

/* The bottom edge of the lowest thing we would collide with, or NaN.
 *
 * This hit-tested three points at y=6 until eight live carts (2026-08-06)
 * showed no hit test can work. goodr's cookie scrim is the topmost element, so
 * the probe read ITS 900px bottom and gave up on a header ending at 90 — and
 * reading the whole stack would not have helped, because at y=6 the only bar is
 * a 25px strip and the header we hit is below it. Worse, elementsFromPoint
 * skips `pointer-events:none`, which is how allbirds mounts its nav (0→152).
 *
 * So it enumerates: storefront bars sit near the top of the tree (deepest
 * measured: 3), and a bounded sweep of body's first levels found every one in
 * 0.4–4.6ms. Lowest qualifying bar wins — no contiguity chain, because
 * _caramelBarQualifies rejects strays by shape and the chained version broke
 * toms.
 *
 * Measured through THIS file, not a copy of its logic: goodr 20→102, allbirds
 * 20→164, 1thrive 20→140, 100percentpure 20→133 — four stores where the pill
 * sat on the store's own header. tog24 188, toms 127, cultbeauty 20 unchanged.
 */
const CARAMEL_BAR_SCAN_DEPTH = 4
const CARAMEL_BAR_SCAN_NODES = 400
export function caramelTopBarBottom() {
    try {
        if (!document.body) return NaN
        const vw = window.innerWidth || 0
        let lowest = NaN
        let budget = CARAMEL_BAR_SCAN_NODES
        let level = [document.body]
        for (
            let depth = 0;
            depth <= CARAMEL_BAR_SCAN_DEPTH && budget > 0;
            depth++
        ) {
            const next = []
            for (const parent of level) {
                for (const el of parent.children) {
                    if (budget <= 0) break
                    budget -= 1
                    next.push(el)
                    const rect = el.getBoundingClientRect()
                    const style = getComputedStyle(el)
                    if (!_caramelBarQualifies(style, rect, vw, false)) continue
                    if (!(lowest >= rect.bottom)) lowest = rect.bottom
                }
                if (budget <= 0) break
            }
            level = next
        }
        const banner = _caramelPageBanner()
        if (banner) {
            const rect = banner.getBoundingClientRect()
            if (
                _caramelBarQualifies(
                    getComputedStyle(banner),
                    rect,
                    vw,
                    true,
                ) &&
                !(lowest >= rect.bottom)
            )
                lowest = rect.bottom
        }
        return lowest
    } catch {
        // No layout engine, or a page that blocks the sweep — keep the default.
        return NaN
    }
}

/* Light-DOM host <div id=id> (inline positioning, no visuals) + OPEN shadow
 * root carrying the shared stylesheet. NOT appended — callers build into
 * `root`, wire listeners, then append the host, fully styled. */
async function createCaramelShadowHost(id) {
    const host = document.createElement('div')
    host.id = id
    host.style.cssText = CARAMEL_HOST_CSS[id] || ''
    const root = host.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = await _caramelGetShadowCss()
    root.appendChild(style)
    return { host, root }
}

/* Focus trap: Tab/Shift+Tab cycle within the shadow root's focusables,
 * never the host page. On the modal container — no document listener. */
function _caramelInstallFocusTrap(root, modal) {
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
function _caramelRestoreFocus(host) {
    const prev = host.__caramelPrevFocus
    if (prev && prev.isConnected && typeof prev.focus === 'function') {
        try {
            prev.focus()
        } catch {
            /* focus is best-effort */
        }
    }
}

/* -------------------------------------------------- UI prompt   */

// Concurrency guard: the shadow-host await lets two near-simultaneous
// inserts both pass the getElementById check before either host appends.
let _caramelPromptInFlight = false

/* "Not now" — remembered for this tab and origin.
 *
 * Dismissing used to remove the host and record nothing, which failed the user
 * twice over. Removing the host is ITSELF a childList mutation inside the
 * subtree store-detect.js's re-detection observer watches, so the observer woke,
 * saw the coupon box still visible, saw no prompt, and put it straight back.
 * Measured on 2026-08-05: gone at ~40ms, BACK at 116-438ms on a real store at
 * phone size, three times running; a second dismissal stuck only because the
 * observer had by then disconnected itself. It also came back on every reload.
 *
 * sessionStorage is the right lifetime: per-tab and per-origin, dies with the
 * tab, so "not now" holds for this visit without becoming a silent permanent
 * opt-out. The permanent version already exists and is explicit — "Pause on
 * this site" in the popup settings.
 *
 * Both doors are gated on this one flag: insertCaramelPrompt is the only way a
 * prompt reaches the page, so the observer needs no separate check.
 */
const CARAMEL_DISMISSED_KEY = 'caramel_prompt_dismissed'
export function caramelPromptDismissedHere() {
    try {
        return sessionStorage.getItem(CARAMEL_DISMISSED_KEY) === '1'
    } catch {
        // Storage blocked (some checkouts partition it) — better to show the
        // prompt than to hide it forever on a flag we cannot read.
        return false
    }
}
export function caramelMarkPromptDismissed() {
    try {
        sessionStorage.setItem(CARAMEL_DISMISSED_KEY, '1')
    } catch {
        /* worst case the prompt returns — the old behaviour */
    }
}

// Called from store-detect.js.
export async function insertCaramelPrompt(domainRecord) {
    if (
        document.getElementById('caramel-small-prompt') ||
        _caramelPromptInFlight
    )
        return
    // The user already said "not now" on this tab. Honour it.
    if (caramelPromptDismissedHere()) return
    // User preference gate (popup settings): auto-apply off, or this site
    // paused → no passive prompt. Popup-initiated applies bypass this.
    if (!(await caramelPromptAllowed(location.hostname))) return
    if (
        document.getElementById('caramel-small-prompt') ||
        _caramelPromptInFlight
    )
        return
    _caramelPromptInFlight = true
    let made
    try {
        // Only the await needs the flag (the rest runs sync to appendChild).
        made = await createCaramelShadowHost('caramel-small-prompt')
    } finally {
        _caramelPromptInFlight = false
    }
    const { host, root } = made
    // Start below the store's own top bar when there is one (see
    // caramelPromptTopFor). Overrides only the `top` from CARAMEL_HOST_CSS.
    const _top = caramelPromptTopFor(caramelTopBarBottom())
    if (_top !== CARAMEL_PROMPT_BASE_TOP)
        host.style.top = `max(${_top}px, env(safe-area-inset-top))`
    host.setAttribute('role', 'button')
    host.setAttribute('tabindex', '0')
    host.setAttribute(
        'aria-label',
        'Try Caramel Coupons — auto-apply the best code at checkout',
    )
    const logoUrl = currentBrowser.runtime.getURL('assets/logo-light.png')
    const pill = document.createElement('div')
    pill.className = 'cm-prompt'
    pill.innerHTML = `
<button id="caramel-close-btn" class="cm-close-fab" aria-label="Dismiss">${CARAMEL_X_ICON}</button>
<div class="caramel-prompt-row">
<img class="caramel-prompt-logo" src="${logoUrl}" alt=""/>
<div class="caramel-prompt-copy">
<div class="caramel-prompt-label">Try Caramel Coupons</div>
<small>Auto-apply the best code at checkout</small>
</div>
<svg class="caramel-prompt-arrow" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
<path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
</div>
`
    root.appendChild(pill)

    // `remember` is false when the flow itself is taking the prompt down (the
    // user clicked INTO it) — that is not a "no", and marking it would suppress
    // the prompt for the rest of the tab.
    const _dismiss = (remember = false) => {
        if (remember) caramelMarkPromptDismissed()
        if (host.parentNode) document.body.removeChild(host)
    }
    const _activate = () => {
        try {
            if (typeof log !== 'undefined')
                log('AUTO_INSERT_TRIGGERED_BY_UI', {
                    domain: domainRecord?.domain || location.hostname,
                    t: performance.now(),
                })
        } catch {
            // ignore
        }
        startApplyingCoupons(domainRecord).catch(err => {
            // A throw mid-flow must never leave the overlay trapping the page.
            logError('apply flow error', err)
            hideTestingModal()
        })
        _dismiss()
    }

    // The × listens INSIDE the shadow tree (host listeners only see the
    // RETARGETED target === host); stopPropagation keeps _activate out.
    root.querySelector('#caramel-close-btn').addEventListener(
        'click',
        event => {
            event.stopPropagation()
            _dismiss(true)
        },
    )
    host.addEventListener('click', _activate)
    // Keyboard parity (host is role="button"): composedPath()[0] is the
    // pre-retarget target — Enter on the focused × must only close.
    host.addEventListener('keydown', event => {
        if (
            event.composedPath()[0] === host &&
            (event.key === 'Enter' || event.key === ' ')
        ) {
            event.preventDefault()
            _activate()
        }
    })

    document.body.appendChild(host)
}

// Called from coupon-runner.js.
export async function showTestingModal(title = '', noLoading = false) {
    const prevFocus = document.activeElement
    const { host, root } = await createCaramelShadowHost(
        'caramel-testing-overlay',
    )

    const scrim = document.createElement('div')
    scrim.className = 'cm-scrim'

    const modal = document.createElement('div')
    modal.id = 'caramel-testing-modal'
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    modal.setAttribute('aria-label', 'Applying coupons')

    const logoUrl = currentBrowser.runtime.getURL('assets/logo-light.png')

    const loadingHTML = `<p id="caramel-test-status">Checking this store for codes…</p>
<div id="caramel-progress-container"><div id="caramel-progress-bar"></div></div>`

    modal.innerHTML = `
<button id="caramel-testing-close" class="cm-close-fab" title="Stop" aria-label="Stop">${CARAMEL_X_ICON}</button>
<div class="caramel-modal-header">
<img class="caramel-modal-logo" src="${logoUrl}" alt="Caramel Logo" />
<h2>${title || 'Applying Coupons...'}</h2>
</div>
${noLoading ? '' : loadingHTML}`

    scrim.appendChild(modal)
    root.appendChild(scrim)
    host.__caramelPrevFocus = prevFocus
    document.body.appendChild(host)

    /* Let the user bail out — never trap them behind the overlay.
     *
     * `_caramelCancelled` is a variable in this document, and a form-POST apply
     * ends this document: on a cart that navigates per code, a run now continues
     * on the next page (caramelBeginRun), so "stop" has to be written somewhere
     * that survives the reload or the shopper's ✕ would be undone by the very
     * navigation they were trying to stop. */
    const _cancel = () => {
        // CROSS-MODULE WRITE (reviewed and settled, WXT P1 2026-08-12): an ES
        // module import binding is read-only, so the old bare
        // `_caramelCancelled = true` cannot survive the port as an assignment.
        // coupon-runner.js owns the flag and deliberately stores it ON
        // globalThis (its docblock records why: the cancel-path suites drive
        // that exact global, and it must survive realm quirks a module-scope
        // binding wouldn't). Written explicitly here so the seam is visible at
        // both ends; a setter export was considered and rejected — no invented
        // API when the existing seam is behavior-identical to what ships.
        globalThis._caramelCancelled = true
        caramelCancelRun()
        hideTestingModal()
    }
    const _close = root.querySelector('#caramel-testing-close')
    if (_close) _close.addEventListener('click', _cancel)
    // Esc cancels — on `document` so it works with focus on the page too.
    const onKey = e => {
        if (e.key === 'Escape') _cancel()
    }
    host.__caramelOnKey = onKey
    document.addEventListener('keydown', onKey)
    _caramelInstallFocusTrap(root, modal)
    // Focus the dialog itself (a11y) — not the × (focus-ring flash).
    try {
        modal.tabIndex = -1
        modal.focus()
    } catch {
        /* focus is best-effort */
    }
}

/* Updates the testing modal's status text + progress bar width. */
// Called from coupon-runner.js.
export async function updateTestingModal(currentIndex, total, code) {
    const host = document.getElementById('caramel-testing-overlay')
    const root = host && host.shadowRoot
    if (!root) return

    const statusEl = root.querySelector('#caramel-test-status')
    if (statusEl) {
        statusEl.textContent = `Trying coupon ${currentIndex} of ${total} (${code})...`
    }

    const progressBar = root.querySelector('#caramel-progress-bar')
    if (progressBar && total > 0) {
        const progressPercent = Math.round((currentIndex / total) * 100)
        progressBar.style.width = `${progressPercent}%`
    }
}
// Called from coupon-runner.js + store-detect.js.
export function hideTestingModal() {
    const host = document.getElementById('caramel-testing-overlay')
    if (host) {
        if (host.__caramelOnKey)
            document.removeEventListener('keydown', host.__caramelOnKey)
        document.body.removeChild(host)
        _caramelRestoreFocus(host)
    }
}

/* Copies an exact coupon code: async clipboard API first, hidden
 * textarea + execCommand fallback for pages that block it. */
// Called from popup.js (same file, the popup realm's own script list).
export async function caramelCopyText(text) {
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text)
            return true
        }
    } catch {
        // page may block the async clipboard API — fall through to execCommand
    }
    try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.setAttribute('readonly', '')
        ta.style.position = 'fixed'
        ta.style.top = '-1000px'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.focus()
        ta.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(ta)
        return ok
    } catch {
        return false
    }
}

// Currency of the cart the saving was measured against (dom-utils records it
// when it reads the price). Tolerates the helper being absent — this file is
// loaded standalone in unit tests.
function caramelSavingsCurrency() {
    try {
        return typeof caramelCurrencySymbol === 'function'
            ? caramelCurrencySymbol()
            : '$'
    } catch {
        return '$'
    }
}

/* A scraped coupon title is UNTRUSTED copy. Titles advertising a zero
 * discount ("Score 0% off with coupon code") are worse than no title: the
 * user reads the offer as worthless and skips a code that may well work.
 * Drop those rather than invent a replacement claim — the code alone is
 * honest. The extension must stay presentable on bad data; fixing the row
 * upstream is a separate, slower job. */
export function _caramelUsableTitle(title, code) {
    if (typeof title !== 'string') return ''
    const t = title.trim()
    if (!t) return ''
    // "0% off", "0.00% off", "$0 off", "£0.00 off" — any zero-value claim.
    if (/(^|[^\d.])0+(\.0+)?\s*%/.test(t)) return ''
    if (/[$£€]\s?0+(\.0+)?([^\d]|$)/.test(t)) return ''
    /* Scrapers pick up the column HEADING as often as the offer. cottonon.com
     * (QA sweep 2026-08-06) shipped a whole list whose every title was the
     * literal word "CODE"; other rows repeat the code back at you, or say
     * "Coupon Code" under a row already headed by the code in bold. None of
     * that is an offer — it is a second copy of the label the row already has,
     * taking up the line where the discount should be. Dropping it leaves the
     * code standing alone, which is honest and reads better than a placeholder.
     * Fixing the rows upstream is a separate, slower job. */
    const bare = t
        .toUpperCase()
        .replace(/[^A-Z0-9%]+/g, ' ')
        .trim()
    if (/^(COUPON|PROMO|DISCOUNT|VOUCHER)? ?(CODE|CODES)$/.test(bare)) return ''
    if (code && bare === String(code).toUpperCase().trim()) return ''
    /* A claim whose amount fell out of the scrape: 100percentpure ships
     * `LASHES — "Get off with code"` (live, 2026-08-06). The verb sits directly
     * against "off", which is the shape a dropped number leaves; a title that
     * kept its quantity, or never had one, does not match. */
    if (/\b(get|take|save|receive|enjoy|score|grab|snag)\s+off\b/i.test(t))
        return ''
    return t
}

// Called from coupon-runner.js + store-detect.js.
export async function showFinalModal(
    savingsAmount,
    code,
    message,
    isSignIn = false,
    couponList = [],
) {
    hideTestingModal()
    // Login state drives the manual-list teaser cap below — same gate as the
    // popup's coupon list. Signed-out ⇒ 6-code teaser + sign-in nudge.
    const _session = await caramelGetSession()
    const loggedIn = !!_session?.token
    const prevFocus = document.activeElement
    const { host, root } = await createCaramelShadowHost(
        'caramel-final-overlay',
    )

    const scrim = document.createElement('div')
    scrim.className = 'cm-scrim'

    const modal = document.createElement('div')
    modal.className = 'caramel-final-modal'
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    modal.setAttribute('aria-label', 'Caramel coupons')

    // Terminal states: savedMoney = real measured price drop; appliedCode =
    // code applied but savings unmeasurable (no priceContainer config —
    // still a win); noLuck = nothing applied (or signed-out/network error).
    const savedMoney = savingsAmount > 0
    const appliedCode = !savedMoney && !!code
    const isSuccess = savedMoney || appliedCode

    // Manual fallback: auto-apply found nothing but codes exist — checkouts
    // that ignore synthetic clicks (isTrusted) still take a hand-pasted
    // code, so offer a copy list.
    //
    // Codes the store REJECTED IN ITS OWN WORDS (runner sets `rejected`) sink
    // to the bottom and say so. They stay listed — a store's "invalid" is
    // sometimes just our synthetic input not registering, so hiding them could
    // bury a code that works when pasted by hand — but leading with the codes
    // the user just watched fail reads as if we learned nothing.
    const _manualAll = (
        !isSuccess && Array.isArray(couponList) ? couponList : []
    )
        .filter(c => c && c.code)
        .map((c, i) => ({ c, i })) // index keeps the sort stable
        .sort(
            (a, b) =>
                (a.c.rejected ? 1 : 0) - (b.c.rejected ? 1 : 0) || a.i - b.i,
        )
        .map(x => x.c)
    // The catalog count for this store — the number the sign-in nudge promises,
    // matching the popup's "of N codes" gate.
    const manualTotal = _manualAll.length
    // Members see the full list (API's own per-store fetch limit); guests see
    // the same teaser the popup shows. The gate only bites when it actually
    // hides something (a store with ≤ the guest cap looks identical to both).
    const manualGuestGated =
        !loggedIn && manualTotal > CARAMEL_MANUAL_GUEST_LIMIT
    const manualCodes = _manualAll.slice(
        0,
        manualGuestGated ? CARAMEL_MANUAL_GUEST_LIMIT : CARAMEL_MANUAL_LIST_MAX,
    )
    const hasManual = manualCodes.length > 0

    const esc = s =>
        String(s == null ? '' : s).replace(
            /[&<>"']/g,
            ch =>
                ({
                    '&': '&amp;',
                    '<': '&lt;',
                    '>': '&gt;',
                    '"': '&quot;',
                    "'": '&#39;',
                })[ch],
        )

    // Build the secondary message based on which state we landed in.
    // PLAIN TEXT ONLY — this string is escaped once at render, so nothing
    // here may pre-escape or embed markup (it would double-encode). Callers
    // reach `message` through the sessionStorage handoff, which the host page
    // can write, so it is untrusted by definition.
    let finalMessage
    if (savedMoney) {
        // The amount is the modal's headline now — repeating it here read as
        // the same sentence twice.
        //
        // NOT "we tried every code and applied the best one": the apply loop
        // STOPS at the first code that moves the total (coupon-runner.js) and
        // caps at MAX_ATTEMPTS anyway, so on a store with 20 codes that
        // sentence was false twice over — it neither tried them all nor
        // compared them to pick a best. Claim only what actually happened.
        finalMessage = 'We found a code that works and applied it for you.'
    } else if (appliedCode) {
        // Caller message (threshold hints, non-USD) beats the generic line.
        finalMessage =
            message ||
            `Code ${code} is applied to your cart — review the discount before you check out.`
    } else if (hasManual) {
        // Caller message = the REAL reason, not a generic "didn't stick".
        finalMessage =
            message ||
            "Auto-apply didn't stick this time. Copy a code and paste it in the store's promo box."
    } else if (isSignIn) {
        finalMessage =
            message || 'Sign in to unlock member-only coupons for this store.'
    } else {
        finalMessage =
            message || "Looks like you're already getting the best deal."
    }

    const logoUrl = currentBrowser.runtime.getURL('assets/logo.png') // Adjust if needed

    const heading = savedMoney
        ? 'Savings Found'
        : appliedCode
          ? '✓ Coupon Applied'
          : isSignIn
            ? 'Sign in to continue'
            : hasManual
              ? 'Grab a code'
              : 'Heads up'

    const manualBlock = hasManual
        ? `<div class="caramel-manual-list">${manualCodes
              .map(
                  c => `<div class="caramel-manual-row${c.rejected ? ' caramel-manual-row-rejected' : ''}">
<div class="caramel-manual-info">
<div class="caramel-manual-code">${esc(c.code)}</div>
${
    c.rejected
        ? '<div class="caramel-manual-title caramel-manual-rejected">Store rejected this one</div>'
        : _caramelUsableTitle(c.title, c.code)
          ? `<div class="caramel-manual-title">${esc(_caramelUsableTitle(c.title, c.code))}</div>`
          : ''
}
</div>
<button class="caramel-manual-copy" data-code="${esc(c.code)}">Copy</button>
</div>`,
              )
              .join('')}</div>`
        : ''

    // Guest teaser gate — same shape as the popup's couponGuestGateHtml: name
    // what's hidden, offer the one action that reveals it (opens the popup to
    // sign in, mirroring the isSignIn primary button below).
    const manualGateHtml = manualGuestGated
        ? `<div class="caramel-manual-gate">
<button type="button" id="caramel-manual-login" class="caramel-manual-gate-btn">Sign in for all ${manualTotal} codes</button>
</div>`
        : ''

    // Graceful escape hatch when auto-apply didn't land: a quiet link to the
    // prod support/feedback form so a shopper can report a broken store or code.
    const feedbackHtml = hasManual
        ? `<a id="caramel-manual-feedback" class="caramel-manual-feedback" href="${esc(CARAMEL_ENV.baseUrl)}/support" target="_blank" rel="noopener noreferrer">Report a problem</a>`
        : ''

    // Success states group the outcome into ONE panel so the amount reads as
    // the headline and the code sits under it as a ticket. `.caramel-final-code`
    // keeps the code as its FIRST <span> — the label is a sibling, never a span
    // inside it (tests resolve the code via `.caramel-final-code span`).
    const winBlock = isSuccess
        ? `<div class="caramel-final-win">
${
    savedMoney
        ? `<div class="caramel-final-eyebrow">You saved</div>
<p class="caramel-final-savings">${esc(caramelSavingsCurrency())}${/[A-Za-z]$/.test(caramelSavingsCurrency()) ? ' ' : ''}${savingsAmount.toFixed(2)}</p>`
        : ''
}
<div class="caramel-final-codewrap">
<div class="caramel-final-eyebrow caramel-final-eyebrow-sm">Code</div>
<p class="caramel-final-code"><span>${esc(code)}</span></p>
</div>
${savedMoney ? '' : `<p class="caramel-final-hint">Discount visible in your cart.</p>`}
</div>`
        : ''

    /* "Proceed to Checkout" is a promise, and it was the ONLY control on this
     * card. On an empty cart (eddiebauer.com, QA sweep 2026-08-05) the modal
     * read "Heads up / Your cart is empty" above a button telling the shopper
     * to go and check out, while covering the store's own "Continue shopping"
     * link. Offer the checkout only when something is actually on the cart to
     * check out with; otherwise the button is just the way out. */
    const primaryLabel = isSignIn
        ? 'Sign In'
        : isSuccess
          ? 'Proceed to Checkout'
          : 'Got it'
    // The manual "Grab a code" card carries its own actions (copy buttons, the
    // unlock nudge, the report link) and three ways out (×, scrim, Esc) — a
    // generic "Done" button under all that is just clutter, so drop it. Sign-in
    // and success states still need their promise-button.
    const showPrimary = isSignIn || isSuccess || !hasManual

    modal.innerHTML = `
<button id="caramel-final-close" class="cm-close-fab" title="Close" aria-label="Close">${CARAMEL_X_ICON}</button>
<div class="caramel-final-logo"><img src="${logoUrl}" alt="Caramel Logo" /></div>
<h2>${heading}</h2>
<p class="caramel-final-msg">${esc(finalMessage)}</p>
${manualBlock}
${manualGateHtml}
${feedbackHtml}
${winBlock}
${showPrimary ? `<button id="caramel-final-ok-btn">${primaryLabel}</button>` : ''}
`

    scrim.appendChild(modal)
    root.appendChild(scrim)
    host.__caramelPrevFocus = prevFocus
    document.body.appendChild(host)

    // Single close path — detaches the Esc listener (no leaked handler).
    const closeFinal = () => {
        if (host.__caramelOnKey)
            document.removeEventListener('keydown', host.__caramelOnKey)
        if (host.parentNode) document.body.removeChild(host)
        _caramelRestoreFocus(host)
    }

    // Manual-copy buttons: copies the EXACT code shown (data-code); copied
    // feedback = class toggle (tokened green pair, dark-safe).
    modal.querySelectorAll('.caramel-manual-copy').forEach(btn => {
        btn.addEventListener('click', async ev => {
            ev.stopPropagation()
            const cc = btn.getAttribute('data-code')
            const ok = await caramelCopyText(cc)
            const prev = btn.textContent
            btn.textContent = ok ? 'Copied!' : 'Press Ctrl+C'
            if (ok) btn.classList.add('is-copied')
            setTimeout(() => {
                btn.textContent = prev
                btn.classList.remove('is-copied')
            }, 1600)
        })
    })

    /* Three ways out, because there used to be one.
     *
     * This card is full-viewport and sits over whatever the shopper was doing.
     * Esc worked; nothing else did. A phone has no Esc key, so on eddiebauer's
     * empty cart the only reachable control was a button labelled "Proceed to
     * Checkout" — the shopper's way out of an empty-cart notice was to be sent
     * to checkout. Tapping the dimmed area is the gesture everyone already
     * tries, and the × matches the one on the prompt and the testing modal.
     *
     * Only the scrim itself closes: a click that lands on the card (copying a
     * code, hitting the button) has the card as its target and must not. */
    const closeX = modal.querySelector('#caramel-final-close')
    if (closeX) closeX.addEventListener('click', closeFinal)
    scrim.addEventListener('click', ev => {
        if (ev.target === scrim) closeFinal()
    })

    // Guest teaser gate: same destination as the isSignIn button — open the
    // popup so the shopper signs in, then the full list is theirs.
    const manualLoginBtn = modal.querySelector('#caramel-manual-login')
    if (manualLoginBtn)
        manualLoginBtn.addEventListener('click', () => {
            closeFinal()
            currentBrowser.runtime.sendMessage({ action: 'openPopup' })
        })

    // Close on the primary button; Esc closes too (keyboard).
    const okBtn = modal.querySelector('#caramel-final-ok-btn')
    if (okBtn)
        okBtn.addEventListener('click', () => {
            closeFinal()
            if (isSignIn) {
                //show popup.html
                currentBrowser.runtime.sendMessage({ action: 'openPopup' })
            }
        })
    const onKey = e => {
        if (e.key === 'Escape') closeFinal()
    }
    host.__caramelOnKey = onKey
    document.addEventListener('keydown', onKey)
    _caramelInstallFocusTrap(root, modal)
    // Focus the modal container, not the primary button — no focus ring
    // flash on open; keyboard users Tab to the button (focus-visible ring).
    try {
        modal.tabIndex = -1
        modal.focus()
    } catch {
        /* focus is best-effort */
    }
}
