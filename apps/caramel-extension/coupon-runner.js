// owns: main apply-loop runner + auth-bridge/message listeners (startApplyingCoupons, _caramelCancelled, window "message" + runtime.onMessage listeners)
// load after: caramel-base.js, dom-utils.js, store-detect.js, coupon-apply.js, coupon-fetch.js

/* --------------------------------------------------  main runner */
// Set true when the user dismisses the testing overlay, so the loop stops
// instead of trapping them. Shared across content-script files (same realm).
// Guarded `var` (matches this file's re-injection convention — see sleep/log)
// so a second content-script injection doesn't throw on redeclaration.
if (typeof _caramelCancelled === 'undefined') {
    var _caramelCancelled = false
}

// Fire-and-forget trust-loop report → background (content scripts can't hit
// the API directly). Best-effort: an asleep/unreachable SW must never break
// the apply flow, so send errors are swallowed. No-op without a real coupon
// id (the #caramel-test mock list carries none).
function reportOutcome(id, outcome, storeReason) {
    if (!id) return
    try {
        const p = currentBrowser.runtime.sendMessage({
            action: 'reportOutcome',
            id: String(id),
            outcome,
            storeReason,
        })
        if (p && typeof p.then === 'function') p.catch(() => {})
    } catch (e) {
        log('REPORT_OUTCOME_SEND_FAILED', { error: String(e) })
    }
}

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
function _caramelCartMoney(cart, minor) {
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
function _caramelLiveDiscountFor(cart, code) {
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
async function _caramelPutCodeOnCart(code, known) {
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
async function _caramelRestoreArrivedDiscount(arrivedWith) {
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
function _caramelOwnCodeRow(code) {
    return { code, title: 'Your code — paste it in at checkout' }
}

function _existingCartDiscount(cart) {
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

async function startApplyingCoupons(rec, options) {
    log('=== Starting coupon flow ===')
    // A resumed run is the SAME click continuing on a new page, so the overlay
    // says so — "Applying Coupons…" appearing on its own after a reload reads
    // like the extension started itself.
    const resumed = !!options?.resumed
    if (!rec) {
        /* No store config (unsupported host / lookup failed). Degrade cleanly
         * instead of throwing mid-flow behind the overlay.
         *
         * "We don't have codes for this store yet" was a claim about the
         * CONFIG stated as a claim about the CATALOGUE, and the two disagree
         * for 36% of the stores we hold coupons for (sampled 2026-08-06). A
         * shopper on a store with fourteen live codes was told we had none —
         * the one sentence that guarantees they never look again. Ask the
         * catalogue before saying anything about it. */
        let held = []
        try {
            held = _caramelCleanCodes(
                await fetchCoupons(location.hostname, '', ''),
            )
        } catch {
            // Offline or the API is down. Nothing to hand over, and no reason
            // to claim the store has no codes — the message below is about us.
            held = []
        }
        const have = Array.isArray(held) && held.length > 0
        log('AUTO_INSERT_STOP', {
            result: 'no-domain-record',
            heldCodes: have ? held.length : 0,
        })
        showFinalModal(
            0,
            null,
            have
                ? "We can't fill in the promo box on this store yet — copy a code below and paste it in at checkout."
                : "We don't have codes for this store yet.",
            false,
            have ? held : [],
        )
        return
    }
    log('AUTO_INSERT_START', { domain: rec.domain, t: performance.now() })
    _caramelCancelled = false
    await showTestingModal(resumed ? 'Still checking codes…' : '')

    let coupons
    try {
        coupons = await getCoupons(rec)
    } catch (e) {
        log('AUTO_INSERT_STOP', {
            result: 'coupon-fetch-failed',
            error: String(e),
            t: performance.now(),
        })
        showFinalModal(
            0,
            null,
            "Couldn't load codes right now — give it another go in a moment.",
        )
        return
    }
    if (!Array.isArray(coupons) || !coupons.length) {
        log('AUTO_INSERT_STOP', { result: 'no-coupons', t: performance.now() })
        showFinalModal(
            0,
            null,
            "No codes for this store just yet — we're working on it.",
        )
        return
    }

    // Skip codes this tab already tried recently (navigation-type applies
    // reload the page mid-loop; without this a re-run restarts from code #1).
    const _tried = _getTriedCodes()
    const _untried = coupons.filter(c => !(c.code in _tried))
    if (_untried.length < coupons.length) {
        log('AUTO_INSERT_SKIP_TRIED', {
            skipped: coupons.length - _untried.length,
        })
    }
    if (!_untried.length) {
        log('AUTO_INSERT_STOP', { result: 'all-tried', t: performance.now() })
        showFinalModal(
            0,
            null,
            'We already tried these codes on this page — copy one below to use manually, or check back later for fresh codes.',
            false,
            coupons,
        )
        return
    }
    coupons = _untried

    // Discount-link strategy first when the platform capability is present
    // (see probeCartJson). On these checkouts the DOM form is deaf to
    // synthetic events, while the link path is fast (~0.5s/code, no page
    // freeze), measurable (live totals), and works even when the coupon UI
    // lives behind an untrusted-click gate.
    const _cart0 = await probeCartJson()
    if (_cart0 && _cart0.item_count > 0) {
        log('AUTO_INSERT_STRATEGY', {
            via: 'discount-link',
            total: _cart0.total_price,
        })
        /* Try them best-first, and keep the BEST result rather than the first
         * one that moves anything.
         *
         * The loop used to stop at the first code that beat the baseline by any
         * amount. On personalabs.com (2026-08-06) that took $1.35 on a $135
         * cart and declared "Savings Found", while flash35 — in the same list —
         * gave $47.25 by hand seconds later on the identical cart. The pill
         * promises "the best code"; this is what makes that sentence true.
         *
         * Affordable only here: each probe is a ~0.5s network call whose result
         * is the cart's real total, so the comparison is measured rather than
         * guessed. The DOM path still stops at its first win, because there each
         * attempt costs ~10s and removing a working code to shop around risks
         * ending with nothing.
         *
         * The winner may be the discount the shopper ARRIVED with: probing
         * replaces whatever is on the cart, so a code of theirs that beats
         * everything we hold has to be put back at the end, by name.
         */
        const linkCodes = caramelRankByValue(coupons, _cart0.total_price).slice(
            0,
            8,
        )
        const arrivedWith = _existingCartDiscount(_cart0)
        let bestTotal = _cart0.total_price
        let bestCode = null
        let bestId = null
        let bestCurrency = _cart0.currency
        for (let i = 0; i < linkCodes.length; i++) {
            if (_caramelCancelled) {
                // Stopping mid-probe leaves whichever code we tried last on the
                // cart. If the shopper had their own, hand it back before we
                // go — via the cart-aware put, because if their code is still
                // live here then a bare re-send is what would remove it.
                if (arrivedWith) await _caramelPutCodeOnCart(arrivedWith.code)
                log('AUTO_INSERT_STOP', {
                    result: 'cancelled',
                    restored: arrivedWith ? arrivedWith.code : null,
                    t: performance.now(),
                })
                return
            }
            const { code, id } = linkCodes[i]
            await updateTestingModal(i + 1, linkCodes.length, code)
            _markTriedCode(code)
            const after = await applyViaDiscountLink(code)
            // A null result means the request failed or the cart became
            // unreadable — we learned nothing about this code, so don't leave
            // it blacklisted for the rest of the session (see _unmarkTriedCode).
            if (!after) _unmarkTriedCode(code)
            if (after && after.total_price < bestTotal) {
                bestTotal = after.total_price
                bestCode = code
                bestId = id
                bestCurrency = after.currency || bestCurrency
            }
        }
        /* The cart currently carries whichever code we probed LAST, so the
         * winner has to go back on before anyone is told about it — and what we
         * then report is what the cart says AFTER that, not what we hoped for.
         *
         * Shopping around introduced this risk and has to carry it: the re-apply
         * is one more request, and it can fail (rate limit, a code the store
         * accepts once, an expiry that lands mid-run). Reporting `bestTotal`
         * regardless would announce a saving that is no longer on the cart —
         * exactly the class of false claim the measured-total rule exists to
         * prevent, reintroduced by the fix for a different problem.
         */
        let confirmed = null
        // Kept when the re-apply loses it: this is the one code we WATCHED work,
        // and it must not disappear into the bottom of the copy list (every
        // probed code is marked tried, and the sink puts tried codes last — so
        // without this the single proven code would be the hardest one to find).
        let lostWinner = null
        let lostWinnerSave = ''
        if (bestCode) {
            // Cart-aware put, not a bare re-send: the winner was probed, so it
            // is already in the discount list, and re-sending an attached code
            // demotes it — the likeliest reading of REAPPLY_LOST below firing
            // at all. The confirmation underneath is unchanged and still
            // decides the verdict, so this can only turn a lost win into a
            // measured one.
            confirmed = await _caramelPutCodeOnCart(bestCode)
            if (!confirmed || confirmed.total_price >= _cart0.total_price) {
                // Nothing is riding on the cart now. Say so rather than claim a
                // win, and let the no-win branch below hand over the codes.
                log('AUTO_INSERT_REAPPLY_LOST', {
                    code: bestCode,
                    expected: bestTotal,
                    got: confirmed ? confirmed.total_price : null,
                    reason: 'the winning code did not go back on the cart — reporting no win rather than a saving we cannot see',
                })
                lostWinner = bestCode
                lostWinnerSave = _caramelCartMoney(
                    _cart0,
                    _cart0.total_price - bestTotal,
                )
                bestCode = null
                confirmed = null
            } else {
                /* The drop is real — but is it OUR code producing it?
                 *
                 * The confirmation checks the total, not the identity, and QA
                 * caught the gap on 2 of 3 live wins (2026-08-06): the card
                 * said "Code LAYAN" while 100percentpure's cart carried
                 * `ATsxsb7x` with `LAYAN:false`, and said "26-10OFFTTWMH0"
                 * while goodr's carried `26-10OFFLNREWZ`.
                 *
                 * Those two look identical and are not, and the money says to
                 * treat them differently:
                 *
                 *   · A store that rewrites our code into a generated
                 *     single-use one (LAYAN → ATsxsb7x) is still our win, and
                 *     OUR code is the one the shopper can type again. Naming
                 *     the generated string would be accurate and useless.
                 *   · A cart honouring a DIFFERENT code WE PROBED means the
                 *     re-apply never took and that other code is doing the
                 *     work. Naming ours credits the wrong code and tells the
                 *     shopper to expect one that is not applied.
                 *
                 * Telling them apart is possible only because we know exactly
                 * what we sent. Nothing here touches the AMOUNT: that is still
                 * read off the cart, so this can correct a name, never inflate
                 * a saving. */
                const honoured = _existingCartDiscount(confirmed)
                const ours =
                    honoured && honoured.code !== bestCode.toUpperCase()
                        ? linkCodes.find(
                              c =>
                                  String(c.code).toUpperCase() ===
                                  honoured.code,
                          )
                        : null
                if (ours) {
                    log('AUTO_INSERT_REAPPLY_OTHER_CODE', {
                        named: bestCode,
                        honoured: honoured.code,
                        reason: 'the cart is honouring a different code we probed — crediting that one instead',
                    })
                    bestCode = ours.code
                    bestId = ours.id
                }
                if (confirmed.total_price > bestTotal) {
                    // It landed, but for less than it did on the probe. The
                    // cart is the authority; report what is actually on it.
                    log('AUTO_INSERT_REAPPLY_SMALLER', {
                        code: bestCode,
                        expected: bestTotal,
                        got: confirmed.total_price,
                    })
                }
            }
        }
        if (bestCode) {
            const saved = (_cart0.total_price - confirmed.total_price) / 100
            log('AUTO_INSERT_STOP', {
                result: 'applied',
                via: 'discount-link',
                bestCode,
                bestSave: saved,
                considered: linkCodes.length,
                t: performance.now(),
            })
            // Dispatch the "worked" trust-loop report BEFORE the reload below
            // unloads the page (the POST is already in flight by then).
            reportOutcome(bestId, 'worked')
            // Reload so the page's own UI shows the applied discount (tag + new
            // total), then re-show our result on the fresh document —
            // sessionStorage survives same-tab reloads and is per-origin, so the
            // handoff can't leak across sites.
            try {
                sessionStorage.setItem(
                    'caramel_applied',
                    JSON.stringify({
                        code: bestCode,
                        saved,
                        currency: confirmed.currency || bestCurrency,
                        t: Date.now(),
                    }),
                )
            } catch {
                /* storage blocked — the discount is still applied */
            }
            location.reload()
            return
        }
        // Nothing we hold beat what the shopper already had. Probing MAY have
        // taken their code off — and may equally have left it untouched, which
        // is the case that used to be destroyed here. Leaving them worse off
        // than before we ran is the one outcome this flow must never produce,
        // and asserting we didn't is not the same as checking.
        const keptExisting = arrivedWith
            ? await _caramelRestoreArrivedDiscount(arrivedWith)
            : null
        // Their discount is gone and would not go back on. Everything below
        // has to read differently when this is set — most of all the sentence
        // that would otherwise tell them a dead code is saving them money.
        const lostTheirs =
            arrivedWith && !keptExisting ? arrivedWith.code : null
        log('AUTO_INSERT_STOP', {
            result: 'none',
            via: 'discount-link',
            tried: linkCodes.map(c => c.code),
            kept: keptExisting ? keptExisting.code : null,
            lostTheirs,
            t: performance.now(),
        })
        // None of the codes BEAT the baseline. That is not the same as "nothing
        // worked", and saying so when the cart already carries a discount is
        // the most dangerous thing this flow can tell a user.
        //
        // Seen twice on real stores (2026-08-05), both with the discount
        // printed on screen behind our own modal: goodr.com holding
        // BOLDERBOULDER15 at -$8.00, and 1thrive.com holding JESS20 at -$20.00
        // that WE had just won. In both cases the modal read "Auto-apply didn't
        // stick this time. Copy a code and paste it in the store's promo box"
        // and offered the already-applied code as the first thing to copy.
        // Following that advice is what actually costs the money: pasting
        // another code into a Shopify promo box REPLACES the live one. The tool
        // never dropped the discount itself — it just told the user to.
        /* A code we watched work, that then wouldn't stay on. Lead with it.
         *
         * It is the single most useful thing on this card — we measured it — and
         * the default ordering would bury it: every probed code is marked tried,
         * and the sink deliberately puts tried codes last. So it goes first, by
         * name, with the amount it produced, and the shopper is told plainly
         * what happened rather than being handed a silent list. */
        if (lostWinner) {
            const first = coupons.filter(
                c => String(c.code).toUpperCase() === lostWinner.toUpperCase(),
            )
            const rest = coupons.filter(
                c => String(c.code).toUpperCase() !== lostWinner.toUpperCase(),
            )
            const theirs = keptExisting
                ? keptExisting.restored
                    ? ` We've put your ${keptExisting.code} back on the cart.`
                    : ` Your ${keptExisting.code} is still on the cart.`
                : lostTheirs
                  ? ` Your own ${lostTheirs} came off while we were testing and the store wouldn't take it back — it's in the list too.`
                  : ''
            showFinalModal(
                0,
                null,
                `${lostWinner} took ${lostWinnerSave} off when we tested it, but the store wouldn't keep it on your cart.${theirs} It's first in the list below — worth pasting in by hand.`,
                false,
                [
                    ...first,
                    ...(lostTheirs ? [_caramelOwnCodeRow(lostTheirs)] : []),
                    ...caramelSinkTriedCodes(rest),
                ],
            )
            return
        }
        if (keptExisting) {
            // Drop the live code from the copy list: re-sending a code the cart
            // already holds is measurably how you delete it, so offering it
            // would cost them the exact amount this sentence congratulates
            // them on.
            const others = coupons.filter(
                c => String(c.code).toUpperCase() !== keptExisting.code,
            )
            showFinalModal(
                0,
                null,
                `${keptExisting.code} is already applied and saving you ${keptExisting.amountText} — we checked ${linkCodes.length} other code${linkCodes.length === 1 ? '' : 's'} and none beat it.`,
                false,
                others,
            )
            return
        }
        if (lostTheirs) {
            /* We took their discount off and could not put it back. No version
             * of this is good news, and the old code reached for the good-news
             * sentence anyway. Say what happened and lead with the one code we
             * know worked on this cart. */
            const rest = coupons.filter(
                c => String(c.code).toUpperCase() !== lostTheirs,
            )
            showFinalModal(
                0,
                null,
                `We couldn't put your ${lostTheirs} back on the cart — paste it in at checkout to get that discount again. None of the ${linkCodes.length} code${linkCodes.length === 1 ? '' : 's'} we checked beat it.`,
                false,
                [
                    _caramelOwnCodeRow(lostTheirs),
                    ...caramelSinkTriedCodes(rest),
                ],
            )
            return
        }
        // Genuinely no discount on the cart — hand the codes over to copy
        // instead of also grinding the (deaf) DOM form.
        showFinalModal(0, null, null, false, coupons)
        return
    }

    // Nothing to discount? Say so, and don't spend the user's time or the
    // merchant's goodwill finding out.
    //
    // Observed on eddiebauer.com (2026-08-05): the prompt appeared on a cart
    // reading "Your cart is empty / Total $0.00", clicking it ran the full loop
    // for ~23 SECONDS, submitted two live codes to the merchant against zero
    // items, and then told the user to paste a code into an empty cart. From
    // the merchant's side that is indistinguishable from code-guessing traffic,
    // on every user who lands on an empty cart page. The extension's own
    // diagnosis was wrong too — it logged "no cart signal — checkout not
    // accepting injection", blaming a store that was behaving perfectly.
    //
    // Two independent signals, because the platforms differ: the cart payload
    // when probeCartJson() works (Shopify-class), and a readable total of zero
    // otherwise. `returnLargest` matters — it is the ORDER TOTAL, so a $0.00
    // reading means every number in the summary is zero, not just one line.
    // cricut.com and clarks.com already stay quiet on an empty cart, so this
    // aligns the rest of the fleet with behaviour users already get elsewhere.
    //
    // BUT the payload describes the STOREFRONT cart, and once a shopper is
    // inside the checkout it no longer describes what they are buying: Shopify
    // moves the items into the checkout session, so /cart.js on shop.<brand>.com
    // answers "0 items" for a cart that is plainly full. Measured on
    // bombas.com (2026-08-06): a $55.50 cart, one item, the store's own summary
    // reading "Total USD $70.50" one inch from our modal — and we told the
    // shopper their cart was empty and stopped, never attempting NATE, the one
    // code our own popup badges "✓ Verified" and which was worth $11.10 by hand.
    // Telling someone their full cart is empty is worse than the grind this
    // guard exists to prevent, so the payload is not consulted there.
    //
    // And neither signal may overrule the other: a claim this absolute needs
    // BOTH to be either empty or silent. Where they disagree, we simply carry
    // on and try codes, which is the recoverable mistake.
    const onCheckoutSurface =
        /\/checkouts?\//i.test(location.pathname) ||
        /^shop\./i.test(location.hostname)
    const domTotal = rec.priceContainer
        ? getPrice(rec.priceContainer, { returnLargest: true })
        : NaN
    const domSaysEmpty = Number.isFinite(domTotal) && domTotal === 0
    const domSaysFull = Number.isFinite(domTotal) && domTotal > 0
    const payloadUsable = !!_cart0 && !onCheckoutSurface
    const payloadSaysEmpty = payloadUsable && _cart0.item_count === 0
    const payloadSaysFull = !!_cart0 && _cart0.item_count > 0
    const emptyCart =
        (payloadSaysEmpty && !domSaysFull) || (domSaysEmpty && !payloadSaysFull)
    if (emptyCart) {
        log('AUTO_INSERT_STOP', { result: 'empty-cart', t: performance.now() })
        showFinalModal(
            0,
            null,
            "Your cart is empty — add something and we'll find you a code.",
        )
        return
    }

    // Before pretending to "try" codes, confirm the promo box is actually
    // reachable on this page. If the config's selectors don't match (stale
    // config, or the box lives on a later checkout step), say so honestly and
    // hand over the codes to copy — instead of churning through 8 codes against
    // nothing and then showing a misleading "didn't stick" message.
    // Visibility-aware: a box that exists but sits inside a collapsed
    // accordion (Magento-class carts) is as unusable as a missing one — reveal
    // it via showInput up front so the whole loop runs against a box the user
    // can actually SEE, and wait for visibility, not mere presence.
    let _box = pickBestMatch(rec.couponInput)
    if (!_box || !_isVisible(_box)) {
        // The config's own toggle first; failing that, the disclosure the page
        // itself declares around the box (see caramelDisclosureFor — most
        // configs never got a showInput, which is why phone checkouts went
        // dark). Same click, same guards, either way.
        const _toggle = rec.showInput
            ? pickBestMatch(rec.showInput, _box)
            : caramelDisclosureFor(_box)
        if (caramelIsForbiddenControl(_toggle)) {
            // Same refusal as the apply path: a reveal-toggle selector that
            // resolved to the checkout's own order button must never be driven.
            log('AUTO_INSERT_REFUSED_CONTROL', {
                reason: 'showInput selector resolved to an order-completing control',
            })
        } else if (_toggle) {
            _toggle.click()
            try {
                await waitForVisible(rec.couponInput, 2500)
            } catch {
                // late-bound accordion widgets can miss the first click
                _toggle.click()
                try {
                    await waitForVisible(rec.couponInput, 1500)
                } catch {
                    /* box still didn't appear */
                }
            }
            _box = pickBestMatch(rec.couponInput)
        }
    }
    if (!_box || !_isVisible(_box)) {
        log('AUTO_INSERT_STOP', {
            result: 'no-coupon-box',
            t: performance.now(),
        })
        showFinalModal(
            0,
            null,
            "We couldn't find the promo box on this page — copy a code below and paste it where the store asks for a promo code.",
            false,
            coupons,
        )
        return
    }

    // Cap ATTEMPTS to limit runtime — but keep every fetched code for the
    // manual fallback list. Truncating the shared array meant the codes we
    // never got around to trying were also never offered to the user: on a
    // store with 20 codes, 12 of them vanished from a modal whose whole job is
    // "here are codes you can paste yourself".
    const MAX_ATTEMPTS = 8
    const allCoupons = coupons
    if (coupons.length > MAX_ATTEMPTS) coupons = coupons.slice(0, MAX_ATTEMPTS)

    // From here on a submit may navigate, which ends this document mid-loop.
    // Opening the run record now is what lets the next page pick the loop back
    // up instead of leaving the shopper to click the pill again per code (see
    // caramelBeginRun). Deliberately NOT opened on the discount-link path
    // above: that one measures every code on this page and never hands off.
    caramelBeginRun()

    const hasPriceCfg = !!rec.priceContainer
    const original = hasPriceCfg
        ? getPrice(rec.priceContainer, { returnLargest: true })
        : NaN
    // Snapshot EVERY price the container held, not just the largest — the
    // saving is measured against the tightest of these (caramelBaselineFor).
    const originalPrices = hasPriceCfg ? _caramelLastPrices.slice() : []

    /* Was a discount already on this cart before we touched it?
     *
     * Two separate failures, one snapshot. The cleanup between codes clicks a
     * remove button, and on a cart that already carried the shopper's OWN code
     * it could take that away instead of ours — money removed by an action they
     * never asked for. And the closing message told a shopper whose cart was
     * already discounted that "auto-apply didn't stick", then offered codes to
     * paste, which on many checkouts REPLACES the live discount. The
     * discount-link path already learned this lesson against real carts
     * (goodr -$8.00, 1thrive -$20.00); this is the same honesty for the path
     * that drives the form. */
    const preExistingDiscount = qAll(findAppliedSelector(rec)).some(el =>
        _isVisible(el),
    )
    if (preExistingDiscount) {
        log('AUTO_INSERT_PRE_EXISTING_DISCOUNT', {
            reason: 'the cart already showed an applied discount before this run',
        })
    }
    let bestSave = 0
    // Set when a code demonstrably worked but the measured amount was not
    // believable (see the plausibility gate below) — keeps the "needs a minimum
    // spend" copy off a cart whose total DID move.
    let bestSaveUnmeasurable = false
    let bestCode = null
    let bestId = null // coupon id paired with bestCode, for the trust-loop report
    let lastStoreReason = null // last real error text the store showed us
    let lastFailId = null // coupon id paired with lastStoreReason
    const triedCodes = []
    // Codes the store turned down IN ITS OWN WORDS. The manual fallback sinks
    // these below the untried ones so we never lead with codes the user just
    // watched fail. Only real rejection text counts — a timeout or a silent
    // checkout says nothing about the code.
    const rejectedCodes = new Set()
    // Pattern-based early-exit: if the checkout gives ZERO feedback (no applied
    // row, no error text) for the first couple of codes, it isn't accepting our
    // injected input at all — stop probing instead of freezing the page ~10s ×
    // every code. Checks DOM *signals*, never the config's content.
    const EARLY_PROBE = 2
    let sawSignal = false
    let loggedUnobservable = false

    // Could we SEE an outcome on this page even if one happened?
    //
    // The early exit below reads "no signal after 2 codes" as "this checkout is
    // ignoring our input". That is only a fair reading if we were in a position
    // to notice a signal in the first place. On a store whose config has no
    // priceContainer (or one that no longer matches), every attempt measures
    // newTotal = NaN, no success/error element exists to watch, and the run
    // quits after 2 of 20 codes blaming the store.
    //
    // Measured on bombas.com (QA sweep 2026-08-05): it gave up after DRESSED20
    // and FITZ with "checkout not accepting injection", and the code NATE —
    // 4th in its own list, badged "Verified" in its own popup — was then
    // applied BY HAND in the same field seconds later for a real -$11.10. The
    // checkout was accepting injection perfectly well; we simply could not read
    // the result and blamed the store for our own blindness.
    //
    // So blindness must not masquerade as evidence. When no observation channel
    // works here, keep going — the wall-clock budget above is the backstop that
    // stops this becoming an unbounded grind — and log a reason that names OUR
    // limitation, so nothing downstream scores a working store as broken.
    const canObserveOutcome = () => {
        if (
            rec.priceContainer &&
            Number.isFinite(
                getPrice(rec.priceContainer, { returnLargest: true }),
            )
        )
            return true
        for (const sel of [rec.successIndicator, rec.errorIndicator])
            if (sel && qAll(sel).length) return true
        return false
    }

    // Wall-clock backstop. The no-signal early-exit above can't help a checkout
    // that stays *responsive* — one that hands back a real "invalid code" error
    // for every code (sawSignal=true) — so without this it would churn all 8
    // codes at ~10s each and trap the user behind the "Applying…" overlay for
    // 80-100s. Once this budget is spent with nothing applied, stop and hand the
    // remaining codes over to copy. A VALID code still wins instantly (success
    // breaks the loop below), so this only ever trims trailing *failing* tries.
    // Time-based, never store-specific.
    const FLOW_BUDGET_MS = 35000
    const loopStart = performance.now()

    for (let i = 0; i < coupons.length; i++) {
        if (_caramelCancelled) break
        if (!bestCode && performance.now() - loopStart > FLOW_BUDGET_MS) {
            log('AUTO_INSERT_TIME_BUDGET', {
                tried: i,
                elapsed: performance.now() - loopStart,
            })
            break
        }
        const { code } = coupons[i]
        triedCodes.push(code)
        await updateTestingModal(i + 1, coupons.length, code)

        _markTriedCode(code)
        // Written BEFORE the submit, because a submit that navigates never
        // comes back here (see caramelMarkPendingSubmit). Cleared immediately
        // after, so a normal attempt leaves nothing for the next page to read.
        caramelMarkPendingSubmit(code, coupons[i].id, originalPrices)
        const res = await applyCoupon(code, rec)
        caramelClearPendingSubmit()

        // Did this attempt prove ANYTHING about this code? An applied row, the
        // store's own error text, or a total we could actually read all count.
        // None of them means we learned nothing — most often because the config
        // has no usable priceContainer, or the cart is empty so no total can
        // move — and a code we never really tested must not stay blacklisted
        // for the rest of the session. See _unmarkTriedCode for the two live
        // cases ($11.25 and $11.10) this cost real users.
        //
        // "The store's own error text" means text we can attribute to THIS
        // attempt. A label that was already on the page (see errorIsNew) proves
        // nothing about the code, so it must not be what keeps the code
        // blacklisted out of the copy list for the rest of the session.
        const saidSomething = !!res.errorMsg && !!res.errorIsNew
        if (
            !res.committed &&
            !saidSomething &&
            !Number.isFinite(res.newTotal)
        ) {
            _unmarkTriedCode(code)
        }

        // Late-total safety net: some checkouts (erincondren-class) flash their
        // error region a beat BEFORE the order total re-renders, so applyCoupon
        // can measure "no drop" and rule a code failed even though it actually
        // stuck. Left uncaught, that applied-but-unrecognised coupon then
        // poisons every later attempt (whose baseline is now the discounted
        // price) and the run ends "nothing applied" while a discount sits on
        // the cart. So: if a coupon row is now showing, poll briefly for the
        // LIVE total to fall below the cart's ORIGINAL total; if it does, this
        // code really worked — credit it and stop. Gated on an applied row +
        // price config, so invalid codes (no row) add no time.
        if (!res.success && hasPriceCfg && !isNaN(original)) {
            const appliedNow = () =>
                qAll(findAppliedSelector(rec)).some(
                    el => _isVisible(el) && !caramelRowReadsRejected(el),
                )
            if (appliedNow()) {
                for (let t = 0; t < 4; t++) {
                    await sleep(400)
                    const cur = getPrice(rec.priceContainer, {
                        returnLargest: true,
                    })
                    if (!isNaN(cur) && cur < original - 0.01) {
                        res.success = true
                        res.newTotal = cur
                        res.committed = true
                        break
                    }
                }
            }
        }

        if (res.success) {
            // Real success — keep this code applied, stop here.
            // Measure against the most conservative baseline the page supports
            // rather than the largest number in the container. A config's
            // price selector is routinely too broad — it catches an MSRP
            // strikethrough or a "save up to $500" banner alongside the real
            // total — and `original - newTotal` would then invent a headline
            // figure the user never received. caramelBaselineFor picks the
            // smallest price seen that is still >= the new total, which can
            // never overstate the discount. NaN (nothing qualifies, e.g. the
            // total went UP) means claim no figure at all.
            const baseline = hasPriceCfg
                ? caramelBaselineFor(res.newTotal, originalPrices)
                : NaN
            const diff =
                hasPriceCfg && !isNaN(res.newTotal) && !isNaN(baseline)
                    ? baseline - res.newTotal
                    : 0
            const believable = diff > 0
            if (hasPriceCfg && !isNaN(original) && baseline !== original) {
                log('AUTO_INSERT_BASELINE_NARROWED', {
                    code,
                    largestSeen: original,
                    baselineUsed: baseline,
                    newTotal: res.newTotal,
                    reason: 'price container held more than one number — used the tightest defensible baseline',
                })
            }
            log(`✓ ${code} saved ${diff || '(unknown — no priceContainer)'}`)
            bestSave = believable ? diff : 0
            // Worked, but no defensible baseline existed (the total didn't drop
            // below anything the container showed). Don't invent a number — and
            // don't blame a minimum spend either.
            bestSaveUnmeasurable =
                hasPriceCfg && !isNaN(res.newTotal) && isNaN(baseline)
            bestCode = code
            bestId = coupons[i].id
            break
        }

        // Apply FAILED. Decide what cleanup is needed before next attempt:
        //   - If the cart visibly accepted the code (`committed`) but an error
        //     showed up → remove that pending coupon so the next try starts
        //     from a clean cart.
        //   - If nothing committed → just clear the input field so the next
        //     try doesn't append to leftover text.
        //   - Either way, then move on to the next code.
        log(`✗ ${code} failed`, {
            committed: res.committed,
            errorMsg: res.errorMsg,
        })
        // Keep the store's own words (login-required, min-spend, expired…) so
        // the final modal can say the REAL reason instead of a generic line.
        //
        // `errorIsNew` is what makes “The store said” honest: text that was
        // already on the page before we submitted is the store's furniture, not
        // its answer (mango.com/ae quoted us the promo field's LABEL). All three
        // consequences hang off this one belief — the quote, the ✗ badge on the
        // code, and the 'failed' verdict we teach the trust loop — so none of
        // them may run on evidence we can't attribute to our own attempt.
        if (
            res.errorMsg &&
            typeof res.errorMsg === 'string' &&
            res.errorIsNew &&
            !/timeout/i.test(res.errorMsg)
        ) {
            lastStoreReason = res.errorMsg
            lastFailId = coupons[i].id // pair the reason with its coupon
            rejectedCodes.add(code)
        }
        if (res.committed) {
            await removeAppliedCoupon(rec, {
                code,
                hadPreExisting: preExistingDiscount,
            })
        } else {
            const inp = pickBestMatch(rec.couponInput)
            if (inp && inp.value) {
                setInputValue(inp, '')
            }
        }
        // A committed row or an error message means the checkout IS reacting to
        // us — keep going. Zero signal after EARLY_PROBE codes means it isn't.
        // Text that was already on the page is not a reaction, so it can't hold
        // the early-exit open: that is how a dead checkout used to keep us
        // grinding all 8 codes.
        if (res.committed || (res.errorMsg && res.errorIsNew)) sawSignal = true
        if (!sawSignal && i + 1 >= EARLY_PROBE) {
            if (canObserveOutcome()) {
                log('AUTO_INSERT_EARLY_EXIT', {
                    tried: i + 1,
                    reason: 'no cart signal — checkout not accepting injection',
                    t: performance.now(),
                })
                break
            }
            // Blind, not ignored — see canObserveOutcome. Keep trying the
            // remaining codes under the wall-clock budget rather than quitting
            // on evidence we were never able to gather.
            if (!loggedUnobservable) {
                loggedUnobservable = true
                log('AUTO_INSERT_UNOBSERVABLE', {
                    tried: i + 1,
                    reason: 'cannot read this checkout (no usable price or success/error selector) — continuing rather than blaming the store',
                    t: performance.now(),
                })
            }
        }
        await waitUntilReady(rec)
        await sleep(160) // tiny visual pause between tries
    }

    // The loop finished on THIS page rather than navigating away mid-attempt,
    // so whatever happens next is a result, not a hop. Close the run before any
    // of the terminal branches below: a record left open would let an unrelated
    // later navigation resume a chain that already had its answer.
    caramelEndRun()

    if (_caramelCancelled) {
        log('AUTO_INSERT_STOP', { result: 'cancelled', t: performance.now() })
        return
    }

    if (bestCode) {
        // bestCode was already applied during the successful loop iteration.
        // Do NOT re-apply — would double-stack on sites that don't dedupe.
        log('AUTO_INSERT_STOP', {
            result: 'applied',
            bestCode,
            bestSave,
            tried: triedCodes,
            t: performance.now(),
        })
        reportOutcome(bestId, 'worked')
        // Feed the popup's savings history — measured wins ONLY. bestSave is 0
        // both when there was no price config and when the measurement failed
        // the plausibility gate; neither is a figure worth banking, and a run
        // of 0s would dilute the user's lifetime total.
        if (bestSave > 0) {
            // The currency the PRICE PARSER actually saw, not a hardcoded USD:
            // the modal already renders £/€ correctly, so banking the history
            // as dollars made the popup's lifetime total disagree with the
            // figure the same user had just been shown.
            caramelRecordSaving({
                domain: location.hostname,
                code: bestCode,
                amount: bestSave,
                currency: caramelCurrencyCode(),
            })
        }
        /* A code that didn't move a READABLE total is not a code we can call
         * applied.
         *
         * The old copy here headlined "✓ Coupon Applied / Discount visible in
         * your cart" and explained the flat total as a minimum spend that
         * hadn't kicked in "yet". On allposters.com (QA sweep 2026-08-05) all
         * three statements were false at once: the total was identical before,
         * after, and after a reload; the promo box was empty; and the store had
         * printed its actual reason next to our modal — promo codes cannot be
         * combined with the sitewide promo the cart already had. We turned a
         * flat rejection into "success, pending", under a Proceed to Checkout
         * button.
         *
         * The measurement is the same; only the claim changes. We say what we
         * did and what we saw, name the store's reason when it gave one, and
         * point the shopper at their own order summary rather than asserting a
         * discount is riding along. A minimum spend is offered as a
         * possibility, not as the explanation. */
        const zeroEffect =
            hasPriceCfg &&
            !isNaN(original) &&
            !(bestSave > 0) &&
            !bestSaveUnmeasurable
        if (zeroEffect) {
            const reason = lastStoreReason
                ? ` The store said: “${String(lastStoreReason).slice(0, 140)}”.`
                : ''
            showFinalModal(
                0,
                null,
                `We put ${bestCode} into the promo box, but your total didn't change.${reason} It may need a minimum spend, or the store may not combine it with a discount you already have — check your order summary before you check out.`,
                false,
                caramelSinkTriedCodes(
                    allCoupons.map(c =>
                        rejectedCodes.has(c.code)
                            ? { ...c, rejected: true }
                            : c,
                    ),
                ),
            )
        } else {
            showFinalModal(bestSave, bestCode)
        }
    } else {
        log('AUTO_INSERT_STOP', {
            result: 'none',
            bestCode: null,
            bestSave: 0,
            tried: triedCodes,
            t: performance.now(),
        })
        // Report 'failed' ONLY when a coupon produced the store's real
        // rejection reason (lastFailId set → lastStoreReason is that text).
        // When the checkout gave no real signal — no-signal early-exit, time
        // budget, or an untrusted synthetic click — lastFailId stays null and
        // we fire NOTHING: a valid code the store rejected only because our
        // click isn't trusted must never be recorded as a coupon failure.
        if (lastFailId) reportOutcome(lastFailId, 'failed', lastStoreReason)
        // Nothing auto-applied. Hand the tried codes to the modal so the user
        // gets a manual copy/paste fallback (covers valid codes the store's
        // checkout rejected only because our synthetic click isn't trusted).
        // When the store told us WHY (login required, min spend, expired…),
        // repeat its own words — that's the honest, transparent version.
        // A cart that arrived with a discount on it was NOT a failure, and the
        // generic "didn't stick — paste one of these" line is actively
        // dangerous there: on most checkouts pasting a second code replaces the
        // live one, so following our advice is what costs the money.
        const storeSaid = lastStoreReason
            ? `The store said: “${String(lastStoreReason).slice(0, 140)}”`
            : null
        let noWinMessage = null
        if (preExistingDiscount) {
            // The warning outranks the usual "copy a code and paste it" advice
            // even when the store gave a reason — that advice is the thing that
            // costs the money here, so it must never appear over a live
            // discount. The store's own words still lead when we have them.
            noWinMessage =
                `${storeSaid ? `${storeSaid} — but ` : ''}your cart already has a discount on it,` +
                ` and none of the ${triedCodes.length} code${triedCodes.length === 1 ? '' : 's'} we tried beat it.` +
                ` Pasting another may replace what you've got, so only swap if you want to.`
        } else if (storeSaid) {
            noWinMessage = `${storeSaid} — copy a code below to try it manually.`
        }
        showFinalModal(
            0,
            null,
            noWinMessage,
            false,
            caramelSinkTriedCodes(
                allCoupons.map(c =>
                    rejectedCodes.has(c.code) ? { ...c, rejected: true } : c,
                ),
            ),
        )
    }
}

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
 * tell: the listener above writes the token as soon as the page answers, so a
 * token in storage IS the acknowledgement. Bounded tightly — this is a courtesy
 * handshake on our own origin, not a retry loop worth spending a page's life on.
 */
const CARAMEL_HELLO_TRIES = 5
const CARAMEL_HELLO_GAP_MS = 600
// Bound at module-eval time below; exported for the suite.
// oxlint-disable-next-line no-unused-vars
async function caramelAnnounceToWebsite() {
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

/* URLs detection has already been answered for, seeded with the one the
 * document loaded at (inject.js runs detection there, and re-running it for the
 * same URL is pure duplication). A store that rewrites its address bar in a
 * loop must not cost a run per rewrite.
 *
 * Guarded `var`, not `const`: re-injection safety, and the test harness evals
 * each source file in its own call where only var/function survive
 * (tests/_load.mjs). */
if (typeof _caramelEvaluatedUrls === 'undefined') {
    var _caramelEvaluatedUrls = new Set([location.href])
}

/* The address bar moved. Re-ask whether we can help here.
 *
 * Detection is not idempotent-by-accident — it re-reads the URL, the referrer
 * and the live cart, which is the whole point: the answer genuinely changes
 * when a store rewrites /?open_cart=true to /. Its own re-entry guards hold
 * (insertCaramelPrompt refuses a second pill, the mutation observer refuses a
 * second install), so a re-run adds a decision, not a duplicate.
 *
 * Returns whether it re-ran, so the test can tell a decision from a no-op. */
function caramelHandleUrlChanged(url) {
    const seen = String(url || '')
    if (!seen || _caramelEvaluatedUrls.has(seen)) return false
    _caramelEvaluatedUrls.add(seen)
    log('URL_CHANGED_REDETECT', { url: seen })
    startCheckoutDetection().catch(err =>
        logError('re-detection after URL change failed', err),
    )
    return true
}

/* --------------------------------------------------  listeners
 * Guard: register once per realm. Without this, SPA re-injections stack
 * duplicate listeners → double-fires, memory leaks. */
if (!window.__caramel_listeners_bound) {
    window.__caramel_listeners_bound = true

    window.addEventListener('message', ev => {
        if (!CARAMEL_ALLOWED_ORIGINS.has(ev.origin)) return
        if (ev.data?.token) {
            caramelSetSession(
                {
                    token: ev.data.token,
                    user: {
                        username: ev.data.username || 'CaramelUser',
                        image: ev.data.image,
                    },
                },
                tryInitialize,
            )
        }
    })
    // Website→extension sign-in relay: on our own site, when the extension has
    // no session yet, announce ourselves — a signed-in page answers with a token
    // (accepted by the listener above, allowlisted origins only). The page mints
    // at most once; see caramelAnnounceToWebsite for why we say it more than
    // once.
    // typeof guard: unlike the deferred listener above, this runs at
    // module-eval time, and the vitest harness evals each file separately
    // (cross-file top-level consts aren't visible there — see _load.mjs).
    if (
        typeof CARAMEL_ALLOWED_ORIGINS !== 'undefined' &&
        CARAMEL_ALLOWED_ORIGINS.has(location.origin)
    ) {
        caramelAnnounceToWebsite()
    }

    currentBrowser.runtime.onMessage.addListener((req, _s, send) => {
        if (req.action === 'userLoggedIn') {
            log('AUTO_INSERT_TRIGGERED_BY_MESSAGE', { t: performance.now() })
            // Fire-and-forget: an async listener returns a Promise (not `true`),
            // so Chrome would close the channel before a post-await send(). Reply
            // immediately and run the long apply flow detached.
            getDomainRecord(location.hostname)
                .then(rec => startApplyingCoupons(rec))
                .catch(err => {
                    logError('apply flow error', err)
                    hideTestingModal()
                })
            send({ success: true })
            return false
        }
        if (req.action === 'caramelUrlChanged') {
            caramelHandleUrlChanged(req.url)
            send({ success: true })
            return false
        }
    })
}
