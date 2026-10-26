// Split out of UI-helpers.js (T-5446), moved verbatim: no behavior change.
import { caramelGetSession, currentBrowser } from './caramel-base.js'
import { CARAMEL_ENV } from './caramel-env.js'
import { caramelCurrencySymbol } from './dom-utils.js'
import { hideTestingModal } from './UI-helpers.js'
import {
    _caramelInstallFocusTrap,
    _caramelRestoreFocus,
    CARAMEL_X_ICON,
    caramelShopperOnly,
    createCaramelShadowHost,
} from './ui-shell.js'

// Upper bound on the manual copy list. 20 = the per-store limit background.js
// asks the API for, so in practice this shows everything we fetched.
const CARAMEL_MANUAL_LIST_MAX = 20

// Guests get the SAME teaser cap here as the popup's coupon list
// (popup-core.js GUEST_COUPON_LIMIT). Without it the manual fallback quietly
// hands a signed-out shopper up to 20 codes while the popup shows them 6 —
// leaking the gated value and skipping the sign-in nudge. Kept as a LITERAL
// twin on purpose: importing popup-core here would pull the popup's logic
// module into the content bundle (size + console-silence closure both pin
// that boundary). Keep in sync with popup-core.js.
const CARAMEL_MANUAL_GUEST_LIMIT = 6

/* Copies an exact coupon code: async clipboard API first, hidden
 * textarea + execCommand fallback for pages that block it. */
// Also used by the popup realm's coupon list (React CouponsView).
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

/* The testing overlay comes down in the same task that mounts the card, never
 * before the awaits that build it. Taking it down first left the page with
 * none of our overlays for as long as those awaits took, and a store that
 * re-draws its cart once a code lands (bumbleandbumble.com, Edge 1.4.19 live
 * run 2026-10-26) let the checkout observer put the "Try Caramel Coupons" pill
 * back up behind the savings card. The finally is the other half: a card that
 * fails to build must still never leave the overlay trapping the page, and the
 * runner does not await this.
 *
 * Called from coupon-runner.js + store-detect.js. */
export async function showFinalModal(...args) {
    try {
        await _caramelMountFinalModal(...args)
    } finally {
        hideTestingModal()
    }
}

async function _caramelMountFinalModal(
    savingsAmount,
    code,
    message,
    isSignIn = false,
    couponList = [],
) {
    // Login state drives the manual-list teaser cap below — same gate as the
    // popup's coupon list. Signed-out ⇒ 6-code teaser + sign-in nudge.
    const _session = await caramelGetSession()
    const loggedIn = !!_session?.token
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
    // here may pre-escape or embed markup (it would double-encode). A
    // caller's `message` can quote the store's own words, which the host page
    // writes, so it is untrusted by definition.
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
    // Down only now (see showFinalModal), and before focus is read: taking the
    // overlay down hands focus back to where the shopper was.
    hideTestingModal()
    host.__caramelPrevFocus = document.activeElement
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
        const copy = caramelShopperOnly(async () => {
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
        btn.addEventListener('click', ev => {
            ev.stopPropagation()
            return copy(ev)
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
    if (closeX) closeX.addEventListener('click', caramelShopperOnly(closeFinal))
    scrim.addEventListener(
        'click',
        caramelShopperOnly(ev => {
            if (ev.target === scrim) closeFinal()
        }),
    )

    // Guest teaser gate: same destination as the isSignIn button — open the
    // popup so the shopper signs in, then the full list is theirs.
    const manualLoginBtn = modal.querySelector('#caramel-manual-login')
    if (manualLoginBtn)
        manualLoginBtn.addEventListener(
            'click',
            caramelShopperOnly(() => {
                closeFinal()
                currentBrowser.runtime.sendMessage({ action: 'openPopup' })
            }),
        )

    // Close on the primary button; Esc closes too (keyboard).
    const okBtn = modal.querySelector('#caramel-final-ok-btn')
    if (okBtn)
        okBtn.addEventListener(
            'click',
            caramelShopperOnly(() => {
                closeFinal()
                if (isSignIn) {
                    //show popup.html
                    currentBrowser.runtime.sendMessage({ action: 'openPopup' })
                }
            }),
        )
    const onKey = caramelShopperOnly(e => {
        if (e.key === 'Escape') closeFinal()
    })
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
