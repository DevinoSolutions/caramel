// owns: shopper-typed code capture (armCodeCapture, caramelShopperCodeValid) — when the SHOPPER types a promo code and presses the store's own Apply (or Enter), judge the store's answer with the same snapshot/verdict rule applyCoupon uses and, ONLY if the store accepted it, hand {site, code} to the worker for POST /api/coupons/submit.
//
// ES module (WXT). store-detect.js calls armCodeCapture(rec) once it holds the
// store record; nothing here runs at module scope.
//
// What this deliberately is NOT:
//   · It never types, clicks or submits anything. It only watches the
//     shopper's own gestures, so it cannot place or alter an order.
//   · It never reads the cart, the order or payment details. The only data that
//     leaves the page is the store's hostname and the code the shopper typed.
//   · It does not decide whether the user is signed in, whether the server
//     flag is on, or whether the shopper consented: those gates live in
//     background.js (consent: checkoutCodeSharingConsent, see
//     code-sharing-consent.js). Only what is cheap to know in the page is
//     enforced here, from an in-memory copy kept fresh by storage change
//     events: the per-site pause, and a recorded "No thanks", so that with
//     sharing declined or the site paused a gesture costs nothing at all (no
//     snapshot, no polling, no query).
//
// Consent (owner rule 2026-10-06): a code is NEVER sent before the shopper has
// explicitly accepted. The first time a typed code would be shared and there is
// no consent record, the worker answers `no-consent` (only after it has
// established signed-in + flag on, so the prompt is never shown when sharing
// could not happen) and we show the consent card (UI-helpers.js
// showCodeSharingPrompt). "Share codes" records `accepted` and then sends the
// code the card named; "No thanks" records `declined` and never asks again;
// dismissing records nothing, so the next qualifying capture asks again.
//
// What must never be shared, and how each is stopped:
//   · A gift-card / card / email / loyalty number typed into a look-alike box:
//     the field's own name/label text is checked (_fieldKind), and the code's
//     SHAPE is refused (looksLikeCardNumber, mirrored with the server, which
//     refuses it too). A box that takes a discount code OR a gift card
//     (Shopify's "Discount code or gift card", UK "voucher" boxes) is watched,
//     but a code typed there is shared only when the store's applied row names
//     it and that row is not a gift-card row: a redeemed gift card drops the
//     total too, and its row shows only the last digits.
//   · A value the shopper did not type (store prefill, browser autofill, a
//     script): only a trusted `input` event with an insert* inputType counts,
//     and the field must still hold exactly that value at gesture time.
//   · A verdict about a DIFFERENT code than the one now in the box: every
//     gesture bumps a generation counter and a watcher whose generation is no
//     longer current discards its answer.
//   · Noise from our own runner or from the cart changing for other reasons: a
//     capture needs a committed result AND either a real price drop or an applied
//     row that names the typed code, and is refused when a fresh error appears.
//
// Funnel diagnostics (code-share-funnel.js): every point above where the offer
// can stop reports one step through _report, which only asks the worker; the
// worker sends nothing unless the shopper opted in to anonymous usage
// diagnostics. A step carries the store's domain and an enum, never the code.
//
// Known limit (documented, not hidden): a classic form-POST cart answers with a
// full page load, which destroys this content script mid-attempt, so there is
// no verdict to read and nothing is captured. The runner's pending-submit
// machinery is for OUR attempts and is intentionally not reused here.
import {
    caramelGetCodeSharingConsent,
    caramelGetSettings,
    caramelOnCodeSharingConsentChanged,
    caramelOnSettingsChanged,
    caramelOwnHost,
    caramelSendMessage,
    caramelSetCodeSharingConsent,
    caramelSiteIsPaused,
    log,
    logError,
} from './caramel-base.js'
import { funnelReasonForSkipped } from './code-share-funnel.js'
import {
    caramelAwaitCouponVerdict,
    caramelSnapshotCart,
} from './coupon-apply.js'
import {
    caramelCouponAnchors,
    caramelFormSubmitIsUnsafe,
    caramelIsForbiddenControl,
    pickBestMatch,
} from './dom-utils.js'

// The consent card (UI-helpers.js showCodeSharingPrompt) is INJECTED by
// entrypoints/content.ts through initCodeCapture, not imported: UI-helpers.js
// -> coupon-runner.js -> store-detect.js -> code-capture.js would make an import
// cycle. Until it is injected there is no way to ask, so nothing is sent: the
// submit path throws (loud), it never treats "cannot ask" as a yes.
let _askConsent = null
export function initCodeCapture({ askConsent }) {
    if (typeof askConsent !== 'function')
        throw new Error('initCodeCapture: askConsent must be a function')
    _askConsent = askConsent
}

// MIRROR of SHOPPER_CODE_PATTERN in apps/caramel-app/src/lib/shopperCoupons.ts,
// which is the source of truth (the server re-validates). The extension cannot
// import app code, so the pattern is copied and
// apps/caramel-app/tests/unit/shopper-code-pattern-mirror.test.ts fails if the
// two ever differ.
const SHOPPER_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$/

// MIRROR of looksLikeCardNumber in the same app file (same drift guard, which
// rebuilds THIS function from its source text and compares behaviour). Keep it
// self-contained: no references outside its own body.
function looksLikeCardNumber(code) {
    if (/^[0-9]{8,}$/.test(code)) return true
    const digits = code.replace(/[^0-9]/g, '').length
    return code.length >= 16 && digits >= 12
}

// What the input's own words (name, id, placeholder, aria-label, autocomplete,
// its <label>) say it takes. A gift-card box that also matched the store's
// coupon selector would otherwise leak a card number.
// Never a promotion, whatever else the field says.
const NON_PROMO_FIELD = /loyalty|reward|points|referral|e-?mail|\bcc-/i
// Stored value (gift cards, certificates, store credit): money, never
// shareable. Words in the languages Shopify localizes its "Discount code or
// gift card" box into.
const STORED_VALUE_WORDS =
    /gift|card|certificate|store credit|guthaben|cadeau|geschenk|regalo|regal|presente|presentkort|gavekort|lahja|podarunk|dárkov|darček|ajándék|poklon|daril|dovan|kinke|gjafa|hadiah|quà|cart[aã]o[- ]oferta|hed[iİı]ye|подар|δώρ|ของขวัญ|ギフト|기프트|礼品|禮品/i
// "Voucher" / "Gutschein" is the promo box on many UK and German stores and a
// gift voucher on others: watched, but only under the combined-box rule, where
// a row that says it without a discount word counts as stored value.
const EITHER_WORDS = /voucher|gutschein/i
const PROMO_WORDS =
    /discount|promo|coupon|offer|r[ée]duction|rabat|descuento|descompte|sconto|desconto|korting|alennus|[iİı]ndirim|slev|zľav|kedvezm|popust|nuolaid|allahindl|sooduskood|afsl|diskon|giảm giá|скид|έκπτωσ|ส่วนลด|割引|할인|折扣|优惠/i

// A click can only be on the Apply control if the target sits in something
// interactive. Cheap `closest` check run BEFORE any selector query.
const CLICKABLE =
    'button, a, input, label, [role="button"], [type="submit"], [tabindex]'

// Per-tab record of codes already shared, so applying the same code twice (or
// click + Enter for one gesture) sends once. sessionStorage: dies with the tab,
// like the tried-codes set.
const SHARED_KEY = 'caramel_shared_codes'
const SHARED_MAX = 50
// How long we wait for the store's first visible answer to the shopper's
// attempt. Longer than the runner's 10s default would only hold the watcher
// open for nothing; the same budget keeps the two judgements comparable.
const VERDICT_TIMEOUT_MS = 10000

let _armed = false
// The matched store config's domain, set when capture is armed: the only
// location the funnel diagnostics ever carry.
let _funnelStore = null
// Funnel diagnostics speak only for a checkout. Capture is armed on every page
// of a supported store (the listeners are cheap and the cart can open anywhere),
// but "at checkout" is the stricter claim the shopper's opt-in names, so the
// funnel stays silent until a VISIBLE promo box has been seen on this page load
// (the same bar store-detect's isCheckout() sets for the prompt). Latched: once
// per page load, and the box disappearing after an accepted code (some stores
// hide it) does not retract the checkout it belonged to.
let _checkoutSeen = false
// A gesture is one shopper action, but Enter in the promo box reaches us twice:
// the keydown, then the click the browser synthesises on the form's submit
// button. The second arrival within this window, for the same box value, is the
// same gesture and reports nothing.
const GESTURE_WINDOW_MS = 400
let _lastGesture = null
// In-memory copy of the two page-side facts that gate capture. Both are UNKNOWN
// until a read (or a change event) lands, and gestures are ignored until then:
// fail closed. `_paused`: null = unknown, else boolean. `_consent`:
// undefined = unknown, null = no valid record, else the parsed record.
let _paused = null
let _consent = undefined
let _prefsReady = Promise.resolve()
// One number per qualifying gesture. A watcher compares its own against this
// when its verdict lands; a stale one is discarded.
let _generation = 0
// The watcher for the CURRENT generation: { generation, code }.
let _current = null
// Last value the shopper really typed (or pasted) into each field.
const _typed = new WeakMap()

// Exported for tests.
export function caramelShopperCodeValid(raw) {
    const code = String(raw ?? '').trim()
    if (!SHOPPER_CODE_PATTERN.test(code)) return null
    return looksLikeCardNumber(code) ? null : code
}

// The capture's acceptance rule. The runner's success rule also takes a bare
// price drop or any new row, but a shopper's cart can move or grow rows for
// reasons that are not the code (quantity edits, shipping estimates,
// auto-discounts, a generic "redeemed" banner), and a share is irreversible. So
// a capture needs ALL of: the store visibly applied a row (`committed`); that
// row is tied to THIS code, either by the total dropping or by the row's own
// text naming the code (case-insensitive); and no NEW error text beside it.
// `combined`: the box also takes gift cards (_fieldKind), and a redeemed gift
// card drops the total too, so there only a row that names the code and does
// not read as a stored-value row counts, never a bare price drop.
// Exported for tests.
export function caramelCaptureAccepted(verdict, code, { combined } = {}) {
    if (!verdict || verdict.success !== true || verdict.committed !== true)
        return false
    if (verdict.errorMsg && verdict.errorIsNew) return false
    if (combined) {
        const rows = Array.isArray(verdict.appliedRows)
            ? verdict.appliedRows
            : [String(verdict.appliedRowsText ?? '')]
        return rows.some(row => {
            const text = String(typeof row === 'string' ? row : row?.text)
            const context = String(
                typeof row === 'string' ? row : (row?.context ?? text),
            )
            return _namesCode(text, code) && !_readsAsStoredValue(context)
        })
    }
    return (
        verdict.priceDropped === true ||
        _namesCode(String(verdict.appliedRowsText ?? ''), code)
    )
}

// The code as a whole token: SAV is not named by a row reading SAVE10.
function _namesCode(text, code) {
    if (!code) return false
    const escaped = String(code).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[^a-z0-9_-])${escaped}($|[^a-z0-9_-])`, 'i').test(
        text,
    )
}

function _readsAsStoredValue(text) {
    return (
        STORED_VALUE_WORDS.test(text) ||
        (EITHER_WORDS.test(text) && !PROMO_WORDS.test(text))
    )
}

// Why the store's answer did not count as an acceptance. Telemetry vocabulary
// only: it never decides what is shared (caramelCaptureAccepted does). A new
// error is checked first, because a store that printed a rejection is a
// rejection whether or not a row also committed. `not-committed` is retired
// here (old installed builds still send it, so both mirrors keep accepting it).
function _captureRefusalReason(verdict) {
    if (verdict?.errorMsg && verdict.errorIsNew) return 'store-error'
    if (verdict?.success === true && verdict.committed === true)
        return 'not-tied-to-code'
    // The total dropped but no applied row matched: the structural false
    // negative of a store config without a row we can read.
    if (verdict?.priceDropped === true) return 'price-dropped-no-row'
    // A row appeared and then did not hold (the store took the code and undid
    // it), or a finder-picked box committed with no drop: a refusal the store
    // acted out, not silence.
    if (verdict?.committed === true) return 'committed-no-effect'
    // No new error, no price drop, and no row that held within the window.
    return 'no-signal'
}

// Reports one funnel step to the worker, which drops it unless the shopper
// opted in to diagnostics. Not awaited by the flow it describes (a slow report
// must never hold a share), but its outcome is checked: a failure is logged,
// never lost. Nothing is reported before a checkout has been seen on the page.
function _report(step, reason) {
    if (!_checkoutSeen) return
    caramelSendMessage({
        action: 'reportCodeShareFunnel',
        step,
        reason,
        store: _funnelStore,
    })
        .then(resp => {
            if (resp?.error) logError('codeShareFunnel', resp.error)
        })
        .catch(err => logError('codeShareFunnel', err))
}

// Exported for tests: resolves when the first settings read has landed.
export function caramelCodeCaptureReady() {
    return _prefsReady
}

// Watch gestures unless the shopper said "No thanks" or paused this site. A
// missing record is watched on purpose: the first accepted code is what
// triggers the consent card. Whether anything is SENT is background.js's call.
function _captureOn() {
    return (
        _paused === false &&
        _consent !== undefined &&
        _consent?.choice !== 'declined'
    )
}

function _pausedIn(settings) {
    return caramelSiteIsPaused(settings.disabledSites, location.hostname)
}

// Asks the worker to share `code`. The worker owns every gate (signed in, flag
// on, consent); `no-consent` is its cue that all but the last hold, so this is
// the moment to ask. Resolves the final worker answer, or a synthetic
// `{ skipped }` when the shopper dismissed or declined; REJECTS when messaging
// or persisting the choice fails (a "yes" that was not saved sends nothing).
async function _submitWithConsent(code) {
    const answer = () =>
        caramelSendMessage({
            action: 'submitShopperCode',
            site: location.hostname,
            code,
        })
    const first = await answer()
    if (first?.skipped !== 'no-consent') return first
    if (!_askConsent)
        throw new Error(
            'code-capture: consent prompt not wired (initCodeCapture was not called)',
        )
    _report('prompt_shown')
    const choice = await _askConsent({
        site: location.hostname,
        code,
    })
    const choiceStep = CONSENT_CHOICE_STEPS[choice]
    if (!choiceStep)
        throw new Error(`code-capture: unknown consent card answer "${choice}"`)
    _report(choiceStep)
    if (choice === 'dismissed') return { skipped: 'consent-dismissed' }
    _consent = await caramelSetCodeSharingConsent(choice)
    if (choice === 'declined') return { skipped: 'consent-declined' }
    // The card named THIS code ("Share this code…"), so it may go now.
    return answer()
}

// The consent card's answer -> its funnel step.
const CONSENT_CHOICE_STEPS = {
    accepted: 'prompt_accepted',
    declined: 'prompt_declined',
    dismissed: 'prompt_dismissed',
}

function _sharedKeyFor(code) {
    return `${location.hostname.toLowerCase()}|${code.toLowerCase()}`
}

function _alreadyShared(code) {
    try {
        const raw = sessionStorage.getItem(SHARED_KEY)
        const list = raw ? JSON.parse(raw) : []
        return Array.isArray(list) && list.includes(_sharedKeyFor(code))
    } catch {
        // Unreadable or blocked storage: treat as "not shared yet". The server
        // dedupes the same code per store anyway, so the cost is one request.
        return false
    }
}

function _markShared(code) {
    try {
        const raw = sessionStorage.getItem(SHARED_KEY)
        const list = raw ? JSON.parse(raw) : []
        const next = (Array.isArray(list) ? list : []).filter(
            k => k !== _sharedKeyFor(code),
        )
        next.push(_sharedKeyFor(code))
        sessionStorage.setItem(
            SHARED_KEY,
            JSON.stringify(next.slice(-SHARED_MAX)),
        )
    } catch {
        /* storage blocked — the generation check and the server still dedupe */
    }
}

function _unmarkShared(code) {
    try {
        const raw = sessionStorage.getItem(SHARED_KEY)
        const list = raw ? JSON.parse(raw) : []
        if (!Array.isArray(list)) return
        sessionStorage.setItem(
            SHARED_KEY,
            JSON.stringify(list.filter(k => k !== _sharedKeyFor(code))),
        )
    } catch {
        /* storage blocked — nothing was recorded to undo */
    }
}

/* Our own apply loop is running (its overlay is up). The loop's events are
 * synthetic and already fail isTrusted, but a shopper clicking inside the page
 * while it runs muddies every reading the loop takes — not a moment to judge
 * anything. */
function _runnerIsApplying() {
    return !!caramelOwnHost('caramel-testing-overlay')
}

// 'other': never shared (a loyalty/referral/email field, or a box that names
// only stored value). 'combined': a discount code OR stored value, shared only
// under caramelCaptureAccepted's combined rule. 'promo': everything else.
function _fieldKind(input) {
    // What the shopper is shown (placeholder, aria-label, labels) is the
    // store's own description of the box; name/id/autocomplete are developer
    // naming, often a generic "promo" on whatever box the coupon selector hit.
    const shown = [input.placeholder, input.getAttribute('aria-label')]
    for (const label of Array.from(input.labels ?? []))
        shown.push(label.textContent)
    const labelledBy = input.getAttribute('aria-labelledby')
    if (labelledBy) {
        for (const id of labelledBy.split(/\s+/))
            shown.push(document.getElementById(id)?.textContent)
    }
    const shownWords = shown.filter(Boolean).join(' ')
    const words = [
        shownWords,
        input.name,
        input.id,
        input.getAttribute('autocomplete'),
    ]
        .filter(Boolean)
        .join(' ')
    if (NON_PROMO_FIELD.test(words)) return 'other'
    // Told it is a gift-card box, and nothing shown says discount.
    if (STORED_VALUE_WORDS.test(shownWords) && !PROMO_WORDS.test(shownWords))
        return 'other'
    if (STORED_VALUE_WORDS.test(words))
        return PROMO_WORDS.test(words) ? 'combined' : 'other'
    return EITHER_WORDS.test(words) ? 'combined' : 'promo'
}

// The field now holds the judged code, or nothing: some stores clear the box
// once a code is applied, and an empty box says nothing against the verdict. A
// DIFFERENT value means the verdict may be about something else.
function _fieldStillHolds(rec, code) {
    const value = (pickBestMatch(rec.couponInput)?.value ?? '').trim()
    return value === '' || value === code
}

function _stillCurrent(rec, code, generation) {
    return (
        generation === _generation &&
        !_runnerIsApplying() &&
        _captureOn() &&
        _fieldStillHolds(rec, code)
    )
}

async function _judgeAndShare(rec, code, snapshot, generation, combined) {
    // Started synchronously by the caller, so its baselines predate the store's
    // own handler. `redact`: the shopper's code never reaches a log line.
    const verdict = await caramelAwaitCouponVerdict(rec, snapshot, {
        code,
        timeoutMs: VERDICT_TIMEOUT_MS,
        redact: true,
    })
    // Re-checked after the (up to 10s) wait: the shopper may have moved on to
    // another code, our runner may have started, or sharing may have been
    // switched off.
    if (!_stillCurrent(rec, code, generation)) return
    if (!caramelCaptureAccepted(verdict, code, { combined })) {
        _report('store_not_accepted', _captureRefusalReason(verdict))
        return
    }
    _report('store_accepted')
    if (_alreadyShared(code)) return
    _markShared(code)
    let resp
    try {
        resp = await _submitWithConsent(code)
    } catch (err) {
        _unmarkShared(code)
        logError('submitShopperCode', err)
        _report('submit_skipped', 'error')
        return
    }
    if (resp?.skipped) {
        // signed-out / disabled / daily-limit etc.: an expected, quiet outcome.
        // Unmarked so the same code can go out once the cause clears (sign-in).
        _unmarkShared(code)
        log('SHOPPER_CODE_SKIPPED', { reason: resp.skipped })
        // null: the card's own step (declined / dismissed) already said it.
        const reason = funnelReasonForSkipped(resp.skipped)
        if (reason) _report('submit_skipped', reason)
        return
    }
    if (resp?.error) {
        _unmarkShared(code)
        logError('submitShopperCode', resp.error)
        _report('submit_skipped', 'error')
        return
    }
    log('SHOPPER_CODE_SHARED', { created: resp?.created })
    _report('submit_sent')
}

function _start(rec, code, combined) {
    const snapshot = caramelSnapshotCart(rec, code)
    const generation = _generation
    _current = { generation, code }
    _judgeAndShare(rec, code, snapshot, generation, combined)
        .catch(err => logError('codeCapture', err))
        .finally(() => {
            if (_current?.generation === generation) _current = null
        })
}

function _onInput(event) {
    if (!_captureOn() || !event.isTrusted) return
    const inputType = String(event.inputType ?? '')
    // insertReplacementText is how browsers report autofill and spellcheck
    // swaps: not the shopper typing this code.
    if (
        !inputType.startsWith('insert') ||
        inputType === 'insertReplacementText'
    )
        return
    if (event.target instanceof HTMLInputElement)
        _typed.set(event.target, event.target.value.trim())
}

function _onClick(event, rec) {
    if (!_captureOn() || !event.isTrusted || _runnerIsApplying()) return
    if (!(event.target instanceof Element) || !event.target.closest(CLICKABLE))
        return
    const input = pickBestMatch(rec.couponInput)
    if (!input) return
    const submit = pickBestMatch(rec.couponSubmit, input)
    if (!submit || submit === input) return
    if (!submit.contains(event.target)) return
    _consider(rec, input, submit)
}

function _onKeydown(event, rec) {
    if (!_captureOn() || !event.isTrusted || event.key !== 'Enter') return
    if (!(event.target instanceof HTMLInputElement) || _runnerIsApplying())
        return
    const input = pickBestMatch(rec.couponInput)
    if (!input || event.target !== input) return
    _consider(rec, input, input)
}

// store-detect also calls this when the promo box appears after arming (drawer
// carts), so `capture_armed` marks the moment capture is listening AT a
// checkout, once per page load. A page whose box is never visible reports
// nothing at all.
export function caramelNoteCheckoutForCapture(rec) {
    if (_checkoutSeen || !_armed || !rec) return
    if (caramelCouponAnchors(rec.couponInput).length === 0) return
    _checkoutSeen = true
    _report('capture_armed')
}

function _consider(rec, input, control) {
    const now = performance.now()
    if (
        _lastGesture &&
        _lastGesture.value === input.value &&
        now - _lastGesture.at < GESTURE_WINDOW_MS
    )
        return
    _lastGesture = { value: input.value, at: now }
    caramelNoteCheckoutForCapture(rec)
    // Observation only, but a config that points at an order-completing control
    // would make "the store accepted it" meaningless — same refusals as the
    // runner.
    if (
        caramelIsForbiddenControl(control) ||
        caramelFormSubmitIsUnsafe(control)
    ) {
        _report('apply_ignored', 'unsafe-control')
        return
    }
    const code = caramelShopperCodeValid(input.value)
    // Enter in the box can also click the form's submit button: the same
    // gesture reaching us twice, not a new attempt.
    if (code && _current?.code === code) return
    // A new gesture: whatever a previous watcher was about to say is stale,
    // even when this one is then refused below.
    _generation++
    _current = null
    if (!code) {
        _report('apply_ignored', 'bad-code-shape')
        return
    }
    const kind = _fieldKind(input)
    if (kind === 'other') {
        _report('apply_ignored', 'not-promo-field')
        return
    }
    // Only what the shopper typed (or pasted) into this very field.
    if (_typed.get(input) !== code) {
        _report('apply_ignored', 'not-typed')
        return
    }
    if (_alreadyShared(code)) {
        _report('apply_ignored', 'already-shared')
        return
    }
    _report('apply_observed')
    _start(rec, code, kind === 'combined')
}

/* Attach the observers for this document. Idempotent: store-detect calls it on
 * every detection pass, and the listeners are document-level (capture phase,
 * so they run BEFORE the store's own handlers — which also survives SPA
 * checkouts that re-render the coupon box) and resolve the elements at event
 * time. A record without both selectors has nothing to watch. If the runtime
 * cannot tell us the user's choice changed, nothing is attached: a stale
 * "sharing is on" is the one failure that cannot be allowed. */
export function armCodeCapture(rec) {
    if (_armed) {
        caramelNoteCheckoutForCapture(rec)
        return false
    }
    if (!rec || !rec.couponInput || !rec.couponSubmit) return false
    try {
        caramelOnSettingsChanged(settings => {
            _paused = _pausedIn(settings)
        })
        caramelOnCodeSharingConsentChanged(record => {
            _consent = record
        })
    } catch (err) {
        logError('codeCapture', err)
        return false
    }
    // An event that landed first is newer than the read, so a read only fills
    // what is still unknown. An unreadable consent record stays unknown (capture
    // stays off for this page) and is reported, not swallowed.
    _prefsReady = Promise.all([
        caramelGetSettings().then(settings => {
            if (_paused === null) _paused = _pausedIn(settings)
        }),
        caramelGetCodeSharingConsent()
            .then(record => {
                if (_consent === undefined) _consent = record
            })
            .catch(err => logError('codeCapture', err)),
    ]).then(() => undefined)
    document.addEventListener('input', _onInput, true)
    document.addEventListener('click', e => _onClick(e, rec), true)
    document.addEventListener('keydown', e => _onKeydown(e, rec), true)
    // Only now: a setup that threw above leaves nothing attached AND leaves the
    // next detection pass free to try again.
    _armed = true
    _funnelStore =
        typeof rec.domain === 'string' ? rec.domain.toLowerCase() : null
    caramelNoteCheckoutForCapture(rec)
    return true
}
