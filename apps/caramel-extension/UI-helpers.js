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
//
// Split 2026-10-26 (T-5446), code moved verbatim: the shared shadow-host
// plumbing is ui-shell.js, the top-bar measurement prompt-placement.js, the
// result card final-modal.js and the consent card code-sharing-prompt.js. This
// file keeps the prompt pill and the testing overlay, and re-exports the rest
// so importers and vi.mock('../UI-helpers.js') keep working unchanged.

import {
    caramelOwnHost,
    caramelPromptAllowed,
    currentBrowser,
    log,
    logError,
} from './caramel-base.js'
// coupon-runner.js imports showTestingModal/updateTestingModal/hideTestingModal/
// showFinalModal back from here. The cycle is fine: neither side READS the
// other's binding during module evaluation, only inside functions.
import { startApplyingCoupons } from './coupon-runner.js'
import { caramelCancelRun } from './dom-utils.js'
import {
    CARAMEL_PROMPT_BASE_TOP,
    caramelPromptTopFor,
    caramelTopBarBottom,
} from './prompt-placement.js'
import {
    _caramelInstallFocusTrap,
    _caramelRestoreFocus,
    CARAMEL_X_ICON,
    caramelShopperOnly,
    createCaramelShadowHost,
} from './ui-shell.js'

// Moved verbatim to ui-shell.js (T-5446); re-exported so every
// importer and every vi.mock of this module keeps its path.
export {
    _caramelGetShadowCss,
    _caramelShadowCssPromise,
    CARAMEL_HOST_CSS,
    caramelShopperOnly,
} from './ui-shell.js'

// Moved verbatim to prompt-placement.js (T-5446); re-exported so every
// importer and every vi.mock of this module keeps its path.
export {
    _caramelBarQualifies,
    _caramelPageBanner,
    caramelPromptTopFor,
    caramelTopBarBottom,
} from './prompt-placement.js'

// Moved verbatim to final-modal.js (T-5446); re-exported so every
// importer and every vi.mock of this module keeps its path.
export {
    _caramelUsableTitle,
    caramelCopyText,
    showFinalModal,
} from './final-modal.js'

// Moved verbatim to code-sharing-prompt.js (T-5446); re-exported so every
// importer and every vi.mock of this module keeps its path.
export { showCodeSharingPrompt } from './code-sharing-prompt.js'

/* -------------------------------------------------- UI prompt   */

// Concurrency guard: the shadow-host await lets two near-simultaneous
// inserts both pass the getElementById check before either host appends.
let _caramelPromptInFlight = false

// A run's own surfaces are up (testing overlay or result card): "Try Caramel
// Coupons" is the wrong thing to offer on top of a run, or behind its result.
// Read at entry and again just before the pill mounts, because the awaits in
// between are where a run can start or finish (live: the pill behind the
// savings card on bumbleandbumble.com, Edge 1.4.19, 2026-10-26).
const _caramelRunSurfaceUp = () =>
    !!(
        caramelOwnHost('caramel-testing-overlay') ||
        caramelOwnHost('caramel-final-overlay')
    )

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
    if (caramelOwnHost('caramel-small-prompt') || _caramelPromptInFlight) return
    if (_caramelRunSurfaceUp()) return
    // The user already said "not now" on this tab. Honour it.
    if (caramelPromptDismissedHere()) return
    // User preference gate (popup settings): auto-apply off, or this site
    // paused → no passive prompt. Popup-initiated applies bypass this.
    if (!(await caramelPromptAllowed(location.hostname))) return
    if (caramelOwnHost('caramel-small-prompt') || _caramelPromptInFlight) return
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
            // Stopped whoever made it: an untrusted click on the × must not
            // reach the host as an activation either.
            event.stopPropagation()
            caramelShopperOnly(() => _dismiss(true))(event)
        },
    )
    host.addEventListener('click', caramelShopperOnly(_activate))
    // Keyboard parity (host is role="button"): composedPath()[0] is the
    // pre-retarget target — Enter on the focused × must only close.
    host.addEventListener(
        'keydown',
        caramelShopperOnly(event => {
            if (
                event.composedPath()[0] === host &&
                (event.key === 'Enter' || event.key === ' ')
            ) {
                event.preventDefault()
                _activate()
            }
        }),
    )

    if (_caramelRunSurfaceUp()) return
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
        caramelCancelRun().catch(err =>
            log('RUN_CANCEL_FAILED', { error: String(err?.message || err) }),
        )
        hideTestingModal()
    }
    const _close = root.querySelector('#caramel-testing-close')
    if (_close) _close.addEventListener('click', caramelShopperOnly(_cancel))
    // Esc cancels — on `document` so it works with focus on the page too.
    const onKey = caramelShopperOnly(e => {
        if (e.key === 'Escape') _cancel()
    })
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
    const host = caramelOwnHost('caramel-testing-overlay')
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
    const host = caramelOwnHost('caramel-testing-overlay')
    if (host) {
        if (host.__caramelOnKey)
            document.removeEventListener('keydown', host.__caramelOnKey)
        document.body.removeChild(host)
        _caramelRestoreFocus(host)
    }
}
