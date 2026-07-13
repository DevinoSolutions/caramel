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
async function startApplyingCoupons(rec) {
    log('=== Starting coupon flow ===')
    if (!rec) {
        // No store config (unsupported host / lookup failed). Degrade cleanly
        // instead of throwing mid-flow behind the overlay.
        log('AUTO_INSERT_STOP', { result: 'no-domain-record' })
        showFinalModal(0, null, "We don't have codes for this store yet.")
        return
    }
    log('AUTO_INSERT_START', { domain: rec.domain, t: performance.now() })
    _caramelCancelled = false
    await showTestingModal()

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
        const linkCodes = coupons.slice(0, 8)
        for (let i = 0; i < linkCodes.length; i++) {
            if (_caramelCancelled) {
                log('AUTO_INSERT_STOP', {
                    result: 'cancelled',
                    t: performance.now(),
                })
                return
            }
            const { code } = linkCodes[i]
            await updateTestingModal(i + 1, linkCodes.length, code)
            _markTriedCode(code)
            const after = await applyViaDiscountLink(code)
            if (after && after.total_price < _cart0.total_price) {
                const saved = (_cart0.total_price - after.total_price) / 100
                log('AUTO_INSERT_STOP', {
                    result: 'applied',
                    via: 'discount-link',
                    bestCode: code,
                    bestSave: saved,
                    t: performance.now(),
                })
                // Reload so the page's own UI shows the applied discount
                // (tag + new total), then re-show our result on the fresh
                // document — sessionStorage survives same-tab reloads and is
                // per-origin, so the handoff can't leak across sites.
                try {
                    sessionStorage.setItem(
                        'caramel_applied',
                        JSON.stringify({
                            code,
                            saved,
                            currency: after.currency,
                            t: Date.now(),
                        }),
                    )
                } catch {
                    /* storage blocked — the discount is still applied */
                }
                location.reload()
                return
            }
        }
        log('AUTO_INSERT_STOP', {
            result: 'none',
            via: 'discount-link',
            tried: linkCodes.map(c => c.code),
            t: performance.now(),
        })
        // None of the codes moved the total — hand them over to copy instead
        // of also grinding the (deaf) DOM form.
        showFinalModal(0, null, null, false, coupons)
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
    if ((!_box || !_isVisible(_box)) && rec.showInput) {
        const _toggle = pickBestMatch(rec.showInput, _box)
        if (_toggle) {
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

    // Cap attempts to a reasonable number to limit runtime
    const MAX_ATTEMPTS = 8
    if (coupons.length > MAX_ATTEMPTS) coupons = coupons.slice(0, MAX_ATTEMPTS)

    const hasPriceCfg = !!rec.priceContainer
    const original = hasPriceCfg
        ? getPrice(rec.priceContainer, { returnLargest: true })
        : NaN
    let bestSave = 0
    let bestCode = null
    let lastStoreReason = null // last real error text the store showed us
    const triedCodes = []
    // Pattern-based early-exit: if the checkout gives ZERO feedback (no applied
    // row, no error text) for the first couple of codes, it isn't accepting our
    // injected input at all — stop probing instead of freezing the page ~10s ×
    // every code. Checks DOM *signals*, never the config's content.
    const EARLY_PROBE = 2
    let sawSignal = false

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
        const res = await applyCoupon(code, rec)

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
                qAll(findAppliedSelector(rec)).some(el => _isVisible(el))
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
            const diff =
                hasPriceCfg && !isNaN(res.newTotal)
                    ? original - res.newTotal
                    : 0
            log(`✓ ${code} saved ${diff || '(unknown — no priceContainer)'}`)
            bestSave = diff
            bestCode = code
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
        if (
            res.errorMsg &&
            typeof res.errorMsg === 'string' &&
            !/timeout/i.test(res.errorMsg)
        ) {
            lastStoreReason = res.errorMsg
        }
        if (res.committed) {
            await removeAppliedCoupon(rec)
        } else {
            const inp = pickBestMatch(rec.couponInput)
            if (inp && inp.value) {
                setInputValue(inp, '')
            }
        }
        // A committed row or an error message means the checkout IS reacting to
        // us — keep going. Zero signal after EARLY_PROBE codes means it isn't.
        if (res.committed || res.errorMsg) sawSignal = true
        if (!sawSignal && i + 1 >= EARLY_PROBE) {
            log('AUTO_INSERT_EARLY_EXIT', {
                tried: i + 1,
                reason: 'no cart signal — checkout not accepting injection',
                t: performance.now(),
            })
            break
        }
        await waitUntilReady(rec)
        await sleep(160) // tiny visual pause between tries
    }

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
        // A committed code that didn't move a READABLE total is usually a
        // threshold promo (min-spend) — say so instead of a bare "applied".
        const zeroEffect = hasPriceCfg && !isNaN(original) && !(bestSave > 0)
        showFinalModal(
            bestSave,
            bestCode,
            zeroEffect
                ? `Code ${bestCode} is on your cart but hasn't changed the total yet — it may need a minimum spend to kick in.`
                : null,
        )
    } else {
        log('AUTO_INSERT_STOP', {
            result: 'none',
            bestCode: null,
            bestSave: 0,
            tried: triedCodes,
            t: performance.now(),
        })
        // Nothing auto-applied. Hand the tried codes to the modal so the user
        // gets a manual copy/paste fallback (covers valid codes the store's
        // checkout rejected only because our synthetic click isn't trusted).
        // When the store told us WHY (login required, min spend, expired…),
        // repeat its own words — that's the honest, transparent version.
        showFinalModal(
            0,
            null,
            lastStoreReason
                ? `The store said: “${String(lastStoreReason).slice(0, 140)}” — copy a code below to try it manually.`
                : null,
            false,
            coupons,
        )
    }
}

/* --------------------------------------------------  listeners
 * Guard: register once per realm. Without this, SPA re-injections stack
 * duplicate listeners → double-fires, memory leaks. */
if (!window.__caramel_listeners_bound) {
    window.__caramel_listeners_bound = true

    window.addEventListener('message', ev => {
        if (!CARAMEL_ALLOWED_ORIGINS.has(ev.origin)) return
        if (ev.data?.token) {
            currentBrowser.storage.sync.set(
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
    currentBrowser.runtime.onMessage.addListener((req, _s, send) => {
        if (req.action === 'userLoggedIn') {
            log('AUTO_INSERT_TRIGGERED_BY_MESSAGE', { t: performance.now() })
            // Fire-and-forget: an async listener returns a Promise (not `true`),
            // so Chrome would close the channel before a post-await send(). Reply
            // immediately and run the long apply flow detached.
            getDomainRecord(location.hostname)
                .then(rec => startApplyingCoupons(rec))
                .catch(err => {
                    console.error('Caramel: apply flow error', err)
                    hideTestingModal()
                })
            send({ success: true })
            return false
        }
    })
}
