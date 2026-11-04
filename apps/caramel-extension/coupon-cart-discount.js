// Split out of coupon-runner.js (T-5446), moved verbatim: no behavior change.
import { log } from './caramel-base.js'
import {
    _caramelClearCartDiscounts,
    applyViaDiscountLink,
    probeCartJson,
} from './coupon-apply.js'

/* The discount already sitting on the cart when we arrived, if any.
 *
 * Reads the platform cart payload probeCartJson() already returns — the data
 * was always there, just never consulted, which is why a run could report
 * "nothing worked" over the top of a live discount. Returns
 * { code, amountText } or null.
 *
 * `discount_codes` entries carry `applicable` on newer carts; treat a missing
 * flag as applicable (older payloads omit it) but require a real amount, so a
 * code that is attached-but-worthless never gets announced as a saving.
 */
/* An amount in the cart payload's own money, formatted for a human.
 *
 * The cart carries its currency, so amounts measured off it are formatted from
 * that rather than from the DOM price parser's last reading (which may never
 * have run on the link path) or a hardcoded dollar sign.
 */
export function _caramelCartMoney(cart, minor) {
    const value = Number(minor) / 100
    const currency = cart?.currency || 'USD'
    try {
        return new Intl.NumberFormat(undefined, {
            style: 'currency',
            currency,
        }).format(value)
    } catch {
        // An unknown/garbage currency code makes Intl throw rather than guess.
        return `${value.toFixed(2)} ${currency}`
    }
}

/* What a discount is worth, when the code entry doesn't say.
 *
 * `discount_codes` entries are NOT always `{code, amount, applicable}`. On the
 * live carts measured 2026-08-06 — 100percentpure.com, goodr.com, tog24.com —
 * every entry was `{code, applicable}` with no `amount` at all, and the money
 * sat in `cart_level_discount_applications` keyed by `title`. Every fixture in
 * this repo's tests carried an `amount`, so the shape mismatch was invisible
 * here and total on a real store.
 *
 * Falls back to the cart's own `total_discount` only when this is the single
 * applicable code, because then the whole discount is unambiguously its. */
function _caramelDiscountAmountFor(cart, code, applicableCount) {
    const apps = Array.isArray(cart?.cart_level_discount_applications)
        ? cart.cart_level_discount_applications
        : []
    const wanted = String(code).toUpperCase()
    for (const app of apps) {
        const title = String(app?.title ?? '').toUpperCase()
        const allocated = Number(app?.total_allocated_amount)
        if (title === wanted && allocated > 0) return allocated
    }
    const total = Number(cart?.total_discount)
    if (applicableCount === 1 && total > 0) return total
    return 0
}

/* What ONE named code is worth on this cart right now, in the cart's own minor
 * units. Zero = nothing off it: never there, demoted, or attached and worthless.
 *
 * Same shape logic as _existingCartDiscount, asked about a code we NAME rather
 * than whatever the cart leads with — "is there a discount" and "does THEIRS
 * still exist" are different questions, and the flow answered the first while
 * reporting on the second. */
export function _caramelLiveDiscountFor(cart, code) {
    if (!cart) return 0
    const wanted = String(code).toUpperCase()
    const codes = Array.isArray(cart.discount_codes) ? cart.discount_codes : []
    const live = codes.filter(e => e?.code && e.applicable !== false)
    const entry = live.find(e => String(e.code).toUpperCase() === wanted)
    if (!entry) return 0
    const stated = Number(entry.amount)
    if (stated > 0) return stated
    return _caramelDiscountAmountFor(cart, entry.code, live.length)
}

/* Get `code` onto the cart; hand back what the cart says afterwards.
 *
 * Not a synonym for applyViaDiscountLink — it asks what is already there first,
 * because re-sending a code the cart already honours is how you DELETE it, and
 * a re-send that is needed lands dead unless the stale list is cleared. Both
 * measured; see _caramelClearCartDiscounts.
 *
 * The clear is a LAST resort, not the first move: it empties the cart outright,
 * and doing it up front left goodr.com reading `discount:0, codes:[]` for 1.2s
 * (live). Nobody checks out inside a second, but "never worse off than before
 * we ran" doesn't hold a stopwatch.
 *
 * `known` saves a second read for a caller that just read the cart.
 */
export async function _caramelPutCodeOnCart(code, known) {
    const current = known === undefined ? await probeCartJson() : known
    if (_caramelLiveDiscountFor(current, code) > 0) return current
    const sent = await applyViaDiscountLink(code)
    if (_caramelLiveDiscountFor(sent, code) > 0) return sent
    await _caramelClearCartDiscounts()
    return await applyViaDiscountLink(code)
}

/* Hand the shopper back the discount they arrived with — and say we did only
 * when the cart agrees.
 *
 * This step used to do neither. Live on harney.com (2026-08-06): their HARNEY10
 * survived all eight probes untouched, this re-applied it anyway, and THAT
 * killed it (mechanism: _caramelClearCartDiscounts). It then logged
 *   AUTO_INSERT_RESTORED_EXISTING {code: HARNEY10, restored: true, total: 11100}
 * — 11100 being the UNDISCOUNTED total, where the same run had recorded 10100
 * with the discount on. `restored: true` came from the REQUEST succeeding, so
 * the number disproving the claim sat in the same log line as the claim. The
 * shopper then read "HARNEY10 is already applied and saving you $10.00" over a
 * cart showing nothing off.
 *
 * Returns { code, amountText, restored } only when they demonstrably still have
 * their money off; null means they do not, and the caller must say so plainly
 * rather than reach for the friendlier sentence.
 */
export async function _caramelRestoreArrivedDiscount(arrivedWith) {
    const before = await probeCartJson()
    const survived = _caramelLiveDiscountFor(before, arrivedWith.code)
    if (survived > 0) {
        log('AUTO_INSERT_RESTORE_UNNEEDED', {
            code: arrivedWith.code,
            amount: survived,
            reason: 'their code came through every probe untouched — re-applying a live code is what knocks it off',
        })
        return {
            code: arrivedWith.code,
            amountText: _caramelCartMoney(before, survived),
            restored: false,
        }
    }
    const after = await _caramelPutCodeOnCart(arrivedWith.code, before)
    const back = _caramelLiveDiscountFor(after, arrivedWith.code)
    log('AUTO_INSERT_RESTORED_EXISTING', {
        code: arrivedWith.code,
        restored: back > 0,
        total: after ? after.total_price : null,
        amount: back,
        ...(back > 0
            ? {}
            : {
                  reason: 'the request went through but the cart shows nothing off for their code — reporting it lost, not restored',
              }),
    })
    if (!(back > 0)) return null
    return {
        code: arrivedWith.code,
        amountText: _caramelCartMoney(after, back),
        restored: true,
    }
}

/* The shopper's own code, as a row they can copy. It is whatever they brought,
 * so it is usually not in our catalogue — without this, the one code we know
 * worked on this cart is the one code the list can't offer. */
export function _caramelOwnCodeRow(code) {
    return { code, title: 'Your code — paste it in at checkout' }
}

// Exported for tests/existing-cart-discount.test.mjs; inside the extension it
// is called only from startApplyingCoupons below.
export function _existingCartDiscount(cart) {
    if (!cart) return null
    const money = minor => _caramelCartMoney(cart, minor)
    const codes = Array.isArray(cart.discount_codes) ? cart.discount_codes : []
    const live = codes.filter(e => e?.code && e.applicable !== false)
    for (const entry of live) {
        // The entry's own amount when it has one; otherwise ask the cart. A
        // code the store is honouring must not read as "worth nothing" just
        // because this payload records the money somewhere else — that is what
        // silently deleted a shopper's live -$9.00 BARGAINBUDDY and then
        // offered them $0.00 codes to paste over it (QA, 100percentpure.com).
        const stated = Number(entry.amount)
        const amount =
            stated > 0
                ? stated
                : _caramelDiscountAmountFor(cart, entry.code, live.length)
        if (!(amount > 0)) continue
        return {
            code: String(entry.code).toUpperCase(),
            amountText: money(amount),
        }
    }
    // Cart-level discount with no code we can name (automatic discount): worth
    // nothing to say "code X is applied", so stay quiet rather than guess.
    return null
}
