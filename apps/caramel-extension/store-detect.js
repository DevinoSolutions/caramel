// owns: supported-store cache, checkout detection, init hook (STORE_CACHE_*, _getCacheTtl, getDomainRecord, _hostMatchesDomain, isCheckout, getCachedCodes, tryInitialize, startCheckoutDetection).
//
// An ES module since the WXT P1 port (2026-08-12). The old "load after:
// caramel-env.js, caramel-base.js, dom-utils.js" manifest ordering is now
// structural — every symbol this file reads arrives through an import below.
//
// There is no init() export because there is nothing to initialize: this file
// registers no listener, touches no DOM and calls no browser API at module
// scope. Its two column-0 statements (`getDomainRecord.cache = null` and the
// `_caramelCodes` guard) seed module-private caches and MUST stay at module
// scope — coupon-fetch and coupon-runner call getDomainRecord/getCachedCodes
// without this file being "started" first. The detection work all hangs off
// startCheckoutDetection(), which inject.js and coupon-runner.js call.
//
// The real cycles through this file are with coupon-fetch and coupon-runner
// (both import from here and are imported here). dom-utils is NOT one of
// them — it imports only caramel-base; the old claim of a dom-utils cycle was
// comment noise in the pre-port sources. Every imported binding below is read
// at CALL time, never during module evaluation, so no TDZ hazard exists.
import {
    caramelRecordSaving,
    caramelSendMessage,
    currentBrowser,
    log,
    logError,
    recordTiming,
    sleep,
} from './caramel-base.js'
import { CARAMEL_ENV } from './caramel-env.js'
import {
    _getTriedCodes,
    caramelPostNavigationVerdict,
    caramelSinkTriedCodes,
    probeCartJson,
} from './coupon-apply.js'
import { fetchCoupons } from './coupon-fetch.js'
import { reportOutcome, startApplyingCoupons } from './coupon-runner.js'
import {
    caramelBaselineFor,
    caramelClaimRunHop,
    caramelCouponAnchors,
    caramelCurrencyCode,
    caramelDisclosureFor,
    caramelEndRun,
    caramelSetCurrencySymbol,
    caramelTakePendingSubmit,
    getPrice,
    pickBestMatch,
    waitForElement,
} from './dom-utils.js'
import {
    hideTestingModal,
    insertCaramelPrompt,
    showFinalModal,
} from './UI-helpers.js'

/* --------------------------------------------------  config cache */
const STORE_CACHE_KEY = 'caramel_supported_stores'
const STORE_CACHE_PROD_TTL = 60 * 60 * 1000 // 1 hour
const STORE_CACHE_DEV_TTL = 0 // bypass cache in a development-stamped build
// One retry, because the measured failure is a cold connection: the first
// fetch of the bulk store list is the slow one and the retry lands quickly.
const STORE_FETCH_ATTEMPTS = 2
const STORE_FETCH_RETRY_DELAY_MS = 750
// Must exceed background.js's FETCH_TIMEOUT_BULK_MS (30s) so we never abandon
// a request the worker is still serving.
const STORE_FETCH_MESSAGE_TIMEOUT_MS = 35000

function _getCacheTtl() {
    return CARAMEL_ENV.isProduction ? STORE_CACHE_PROD_TTL : STORE_CACHE_DEV_TTL
}

export async function getDomainRecord(domain) {
    if (!getDomainRecord.cache) {
        const ttl = _getCacheTtl()
        // Check chrome.storage.local for a recent cached copy first
        try {
            const stored =
                ttl > 0
                    ? await new Promise(r =>
                          currentBrowser.storage.local.get(
                              [STORE_CACHE_KEY],
                              r,
                          ),
                      )
                    : null
            const entry = stored?.[STORE_CACHE_KEY]
            if (ttl > 0 && entry?.data?.length && Date.now() - entry.ts < ttl) {
                getDomainRecord.cache = entry.data
                log('Loaded supported domains from local cache')
            }
        } catch {
            /* storage read failed, proceed to API */
        }

        // Fetch fresh configs from the backend.
        //
        // "The API answered with a list" and "we never reached the API" are
        // different facts and must not collapse into the same one. They used
        // to: any failure left the cache null, and a null cache reads as "this
        // domain isn't supported" — visually identical to a store we don't
        // cover. That is how a slow network became fleet-wide silence with
        // nothing logged (2026-08-07).
        //
        // So a failure is retried once, then falls through to the expired
        // cache below, and is recorded either way. An empty-but-successful
        // answer is a real answer: it is not retried and not cached, which
        // leaves the cache unpoisoned so a later call can still succeed.
        if (!getDomainRecord.cache) {
            let failure = null
            for (let attempt = 0; attempt < STORE_FETCH_ATTEMPTS; attempt++) {
                if (attempt > 0) await sleep(STORE_FETCH_RETRY_DELAY_MS)
                try {
                    const resp = await caramelSendMessage(
                        { action: 'fetchSupportedStores' },
                        STORE_FETCH_MESSAGE_TIMEOUT_MS,
                    )
                    // The worker reports its own fetch failures in-band rather
                    // than by rejecting, so an `error` field is a failure too.
                    if (resp?.error) {
                        failure = String(resp.error)
                        continue
                    }
                    failure = null
                    if (resp?.supported?.length) {
                        getDomainRecord.cache = resp.supported
                        currentBrowser.storage.local.set({
                            [STORE_CACHE_KEY]: {
                                data: resp.supported,
                                ts: Date.now(),
                            },
                        })
                        log('Loaded supported domains from API')
                    }
                    break
                } catch (e) {
                    failure = String(e?.message || e)
                }
            }
            if (failure) {
                // Loud where we can read it: this is the difference between
                // diagnosing a silent install in seconds and bisecting for a
                // night.
                logError('fetchSupportedStores', failure)
                recordTiming('STORE_LIST_FETCH_FAILED', { error: failure })
            }
        }

        // If API failed, try expired cache as last resort
        if (!getDomainRecord.cache) {
            try {
                const stored = await new Promise(r =>
                    currentBrowser.storage.local.get([STORE_CACHE_KEY], r),
                )
                const entry = stored?.[STORE_CACHE_KEY]
                if (entry?.data?.length) {
                    getDomainRecord.cache = entry.data
                    log('Loaded supported domains from expired cache')
                }
            } catch {
                /* nothing we can do */
            }
        }
    }
    return getDomainRecord.cache?.find(r =>
        _hostMatchesDomain(domain, r.domain),
    )
}
getDomainRecord.cache = null

// Match the active hostname to a supported-store domain. Accept an exact match,
// a real dotted subdomain (www./checkout./secure.<domain>), or a hyphen-prefixed
// checkout host (gapfactory-style `secure-<brand>.gapfactory.com`). Plain
// substring matching (the old behavior) false-matched unrelated hosts —
// `art.com` ⊂ `walmart.com`, `bestbuy.com` ⊂ `notbestbuy.com`, even
// `target.com` ⊂ `evil-target.com.attacker.net` — which would apply the wrong
// store's selectors to an unrelated site. Require a label boundary (start, '.'
// or '-') so only genuine same-site hosts match.
// Hyphen-joined checkout hosts are real (`secure-athleta.gap.com` serves
// `athleta.gap.com`'s checkout) but a bare "any prefix + '-'" rule also lets
// an ATTACKER-registered `evil-target.com` inherit `target.com`'s selectors
// and coupons. Every genuine hyphen host in the catalog is a known checkout
// prefix in front of a domain that already has its own subdomain, so require
// BOTH: an allow-listed prefix label, and a domain of 3+ labels. That admits
// every real case (`secure-{athleta,oldnavy,bananarepublic,…}.<brand>.<tld>`)
// while `evil-target.com` → `target.com` (2 labels, unknown prefix) is out.
const HYPHEN_CHECKOUT_PREFIXES = new Set([
    'secure',
    'checkout',
    'www',
    'shop',
    'store',
])
/* A Shopify store's own checkout can live on its <shop>.myshopify.com host
 * rather than on the brand domain. 5starnutritionusa.com does exactly this
 * (QA sweep 2026-08-05): the shopper adds $44.99, hits checkout, lands on
 * 5starnutritionusa.myshopify.com — and the extension goes dark at the one
 * moment it matters, because the config's domain is the brand host and no
 * suffix rule connects the two. No coupon fetch happens at all.
 *
 * Matched on the shop LABEL equalling the config domain's first label, which
 * is how a store's myshopify host is named when it maps to its brand domain.
 * Deliberately narrow: the suffix is the fixed, Shopify-owned `myshopify.com`,
 * so this cannot be used to inherit another store's config the way a bare
 * "any prefix" rule could — nobody can register `target.myshopify.com` and
 * become target.com without Shopify handing them that shop name.
 *
 * Stores whose shop name does NOT match their brand label (naturepedic's is
 * `0vjjgk-zp.myshopify.com`) are not helped by this and still need their own
 * catalogue row; this fixes the aligned majority, not every case.
 */
const CARAMEL_SHOPIFY_HOST_SUFFIX = '.myshopify.com'
function _shopifyShopHostMatches(host, domain) {
    if (!host.endsWith(CARAMEL_SHOPIFY_HOST_SUFFIX)) return false
    const shop = host.slice(0, -CARAMEL_SHOPIFY_HOST_SUFFIX.length)
    // One label only: `a.b.myshopify.com` is not a shop host.
    if (!shop || shop.includes('.')) return false
    const brandLabel = domain.split('.')[0]
    return !!brandLabel && shop === brandLabel
}

// Exported for tests/host-matches-domain.test.mjs, which pins this boundary
// directly (the rest of the file reaches it through getDomainRecord).
export function _hostMatchesDomain(host, domain) {
    if (!host || !domain) return false
    host = String(host).toLowerCase()
    domain = String(domain).toLowerCase()
    if (host === domain) return true
    if (_shopifyShopHostMatches(host, domain)) return true
    const i = host.length - domain.length
    if (i <= 0) return false
    if (host.slice(i) !== domain) return false
    const sep = host[i - 1]
    if (sep === '.') return true
    if (sep !== '-') return false
    return (
        HYPHEN_CHECKOUT_PREFIXES.has(host.slice(0, i - 1)) &&
        domain.split('.').length >= 3
    )
}

/* --------------------------------------------------  checkout detector */

/* Does this URL name a cart or checkout? Generic across platforms — a word in
 * the path, never a store-specific rule. Used only to decide whether a live
 * cart probe is worth making, so a miss costs nothing but a missed probe.
 * `bag` is deliberately absent: /collections/bag is a product category on a
 * great many stores, and the prompt has no business appearing there.
 *
 * The word must END its path segment. It may begin mid-segment (/shopping-cart
 * is a cart), but a segment that CONTINUES past it is a slug that merely starts
 * with the word — /products/cart-organizer is a product, and it used to be read
 * as a checkout, prompt and cart probe and all. Trading /cart-page away is the
 * price, and it is the cheap side of that trade: a missed probe costs nothing,
 * a prompt on the wrong page is the defect this whole file guards against. */
const CARAMEL_CART_PATH_RE =
    /(?:^|[/\-_])(cart|carts|basket|checkout|checkouts)(?:[/?#]|$)/i

/* A query key that means "the cart drawer is open".
 *
 * Stores that answer /cart with a redirect say so in the query instead:
 * ?openCartDrawer=true, ?open_cart=1, ?cart-drawer=1. This matches the SHAPE of
 * such a key — an optional verb, the cart noun, an optional panel noun, in any
 * of the casings and separators the web writes them in — and never one store's
 * literal parameter. That distinction is what the ban above is about: a rule
 * naming a store (or a store's own parameter, which is the same thing wearing a
 * different hat) is still out of bounds; a rule about URL shape holds for every
 * store that writes its URL that way.
 *
 * `view` earns its place the same way the rest did: chomps.com and
 * drsquatch.com both answer /cart with a redirect to `/?viewcart=true`
 * (measured 2026-08-06). The alternation had been written from the two stores
 * in front of us at the time and stopped there, so the plainest verb of the set
 * was the one missing — chomps carries 15 catalogue codes and the extension was
 * silent on its own cart page.
 *
 * Anchored at both ends so `?discart=1` or `?cartoon=1` cannot ride in. */
const CARAMEL_CART_INTENT_PARAM_RE =
    /^(?:(?:open|show|toggle|view)[-_]?)?(?:cart|basket|minicart)(?:[-_]?(?:drawer|panel|modal|flyout))?$/i

/* Values that mean the flag is OFF. The key alone is not the signal — a store
 * that writes ?cart=false is telling us the drawer is closed. */
const CARAMEL_FALSY_FLAG_VALUES = new Set(['', '0', 'false'])

/* A path that is the site's front door: bare root, or a locale root. */
const CARAMEL_SITE_ROOT_RE = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/?)?$/i

/* Did the shopper arrive here FROM this store's own cart URL, landing on its
 * front door? That is the signature of a cart route that redirects: the address
 * bar no longer says cart, and the referrer is the only thing left that does.
 *
 * Both halves are load-bearing. Same-origin, because another site's /cart says
 * nothing about this one. Landing on a ROOT, because leaving the cart to go
 * look at a product is the most ordinary move on any store — treating that as
 * cart intent would follow the shopper around the whole site. */
function _caramelReferrerCartBounce() {
    if (!document.referrer) return false
    let from
    try {
        from = new URL(document.referrer)
    } catch {
        return false
    }
    if (from.origin !== location.origin) return false
    if (!CARAMEL_CART_PATH_RE.test(from.pathname)) return false
    return CARAMEL_SITE_ROOT_RE.test(location.pathname)
}

/* Is the shopper in their cart, whatever the path happens to say?
 *
 * Measured live on 2026-08-06: allbirds.com answers /cart with a 302 to
 * /?openCartDrawer=true, and toms.com navigates /cart to /?open_cart=true and
 * then rewrites the address bar to a bare /. On both, the shopper is looking at
 * a full cart drawer and the path-only rule below saw an ordinary home page, so
 * the extension stayed silent for the entire visit.
 *
 * Returns the name of the signal that answered, or null — the caller logs it,
 * because "the gate opened" is not a useful thing to read in a dev console
 * without knowing which of four rules opened it.
 */
/* Does this HOST name a cart or checkout? Some platforms put the cart word in
 * the hostname, not the path: eBay's cart lives at cart.ebay.com/ (path "/"),
 * and checkout.* subdomains are a common SFCC/legacy shape. Same vocabulary as
 * CARAMEL_CART_PATH_RE, and only the FIRST label — a cart word deeper in the
 * host (secure.cart.example) is not what this page calls itself. Still a rule
 * about URL shape, never about one store. */
// Exported for tests/cart-capability-gate.test.mjs (the host-vocabulary pins).
export function _caramelCartHostname(hostname) {
    return /^(cart|carts|basket|checkout|checkouts)\./i.test(hostname)
}

function _caramelCartIntentSignal() {
    if (CARAMEL_CART_PATH_RE.test(location.pathname + location.search))
        return 'path'
    if (_caramelCartHostname(location.hostname)) return 'host'
    for (const [key, value] of new URLSearchParams(location.search)) {
        if (!CARAMEL_CART_INTENT_PARAM_RE.test(key)) continue
        if (CARAMEL_FALSY_FLAG_VALUES.has(String(value).trim().toLowerCase()))
            continue
        return 'param'
    }
    // Leading '#' stripped so the fragment is matched as the path it stands in
    // for: '#cart' and '#/cart' are the same claim.
    if (CARAMEL_CART_PATH_RE.test(location.hash.replace(/^#/, '')))
        return 'hash'
    if (_caramelReferrerCartBounce()) return 'referrer'
    return null
}

/* Can we act here even though no promo box matched?
 *
 * The DOM check above asks whether the CONFIG matches this page. That is the
 * wrong question on a platform whose cart we can read and drive over the
 * network: the discount-link path (coupon-runner.js) needs no promo box at all,
 * and applies codes perfectly well on pages where the config's selectors — very
 * often written against the checkout, not the cart — match nothing.
 *
 * The 2026-08-05 QA sweep measured what that costs: roughly half the catalogue
 * (~1,300 stores) carries a checkout-only coupon selector, so a shopper sitting
 * on the cart page of a store WITH codes in our database sees nothing at all.
 * Silence on a store that has coupons is the defect the owner named directly.
 *
 * So gate on CAPABILITY rather than configuration: a live cart with something
 * in it means we can genuinely help here. Probed only on a cart-ish URL, so an
 * ordinary product page never pays for the request.
 */
async function _platformCartUsable() {
    const signal = _caramelCartIntentSignal()
    if (!signal) return false
    try {
        const cart = await probeCartJson()
        if (cart && cart.item_count > 0) {
            log('CHECKOUT_VIA_CART_PAYLOAD', {
                items: cart.item_count,
                signal,
                reason: 'no promo box matched, but the platform cart is readable and non-empty',
            })
            return true
        }
    } catch (e) {
        log('CART_PROBE_FAILED', { error: String(e) })
    }
    return false
}

/* A store we hold codes for that has no config row of its own.
 *
 * `domain` is the only thing the apply flow needs from a record that isn't a
 * selector — it is what fetches the codes (getCachedCodes). The discount-link
 * path uses no selectors at all, and if the cart stops being readable the
 * generic path already ends where it should: it reports that it couldn't find
 * a promo box and hands the codes over to copy. So there is nothing to flag and
 * nothing to special-case; a record carrying just the domain is the whole
 * difference between helping here and staying silent. */
// Exported for tests/configless-store.test.mjs, which drives the apply flow
// with exactly this record.
export function caramelConfiglessRecord(hostname) {
    return { domain: hostname }
}

// Exported for tests/cart-capability-gate.test.mjs,
// tests/cart-host-intent.test.mjs and tests/disclosure-reveal.test.mjs, which
// pin this gate directly.
export async function isCheckout() {
    const rec = await getDomainRecord(location.hostname)
    /* No config row is not the same as nothing we can do.
     *
     * _platformCartUsable already exists for configured stores whose selectors
     * were written against the checkout and match nothing on the cart. The
     * question it asks — can we read and drive this cart over the network? —
     * has nothing to do with whether a config row exists, but it was unreachable
     * without one, because of this early return.
     *
     * Sampled against the live catalogue on 2026-08-06: of 573 stores we hold
     * coupons for, 209 (36%) have no config row, and the shopper saw nothing at
     * all on those. The popup lists their codes — it keys on the catalogue —
     * but only if they think to open it; on the page itself the extension was
     * silent, which is the defect the owner named.
     *
     * How many that actually rescues was MEASURED, not assumed, because the
     * honest number is small: /cart.js was probed on 40 of those 209 domains
     * and exactly ONE answered (tog24.com). Config-less stores are mostly
     * config-less for a reason — airlines, restaurants, subscriptions, sites
     * with no cart to read at all. So this is a narrow win on the platform
     * stores hiding in that set, not a fix for 209 stores, and it should not be
     * described as one.
     *
     * The broad half of the same defect is in coupon-runner's no-record branch,
     * which told every one of those 209 stores' shoppers that we held no codes
     * for a store we had codes for.
     *
     * Still a high bar to appear: a cart-shaped URL, a readable cart with
     * something in it, and codes for the domain (tryInitialize). A store with
     * no codes, or a product page, is exactly as quiet as before. */
    if (!rec) return await _platformCartUsable()
    // VISIBLE, not merely present: themes ship hidden coupon markup on
    // non-checkout pages, and some configs point showInput at site-wide
    // controls — the prompt belongs only where the user can actually see a
    // way to enter a code. Same semantics as the re-detection observer.
    //
    // caramelCouponAnchors rather than a raw visibility scan: a selector that
    // matches hundreds of visible elements is not describing a promo box, and
    // answering "yes, a checkout" from one puts the prompt on every page of the
    // site (see its comment for the measured case).
    const anyVisible = () =>
        [rec.couponInput, rec.showInput]
            .filter(Boolean)
            .some(sel => caramelCouponAnchors(sel).length > 0)
    if (anyVisible()) return true
    // Only wait on the selectors the config actually provides — a bare
    // `${null},${null}`/`,${x}` compound is a wasted 3s wait (or a thrown
    // selector that waitForElement just swallows).
    const waitSel = [rec.couponInput, rec.showInput].filter(Boolean).join(',')
    if (waitSel) {
        try {
            await waitForElement(waitSel, 3000)
        } catch (e) {
            log(e)
        }
    }
    if (anyVisible()) return true
    // A promo box the shopper can open in one tap is not a hidden box — it is a
    // closed drawer. Offering help there is the whole point; the apply flow
    // opens the same disclosure before it types (see caramelDisclosureFor for
    // the two stores that measured this, one of them at 1440 wide).
    const _hiddenBox = rec.couponInput ? pickBestMatch(rec.couponInput) : null
    if (_hiddenBox && caramelDisclosureFor(_hiddenBox)) {
        log('CHECKOUT_VIA_DISCLOSURE', {
            reason: 'the promo box is present behind a disclosure the shopper can open',
        })
        return true
    }
    return await _platformCartUsable()
}

/* Coupon-availability cache — fetched once when a checkout is detected so we
   can decide whether to even show the prompt, and reused by the apply flow
   (no double fetch). Keyed by domain. Guarded var for re-injection safety. */
if (typeof _caramelCodes === 'undefined') {
    var _caramelCodes = null // { domain, list }
}
/* Test seam (WXT P1, 2026-08-12): the cache used to be a script global the
   suites reset with `globalThis._caramelCodes = null`; module scope made it
   unreachable, and an import binding cannot be assigned from outside. Only
   tests/store-detect.test.mjs + tests/configless-store.test.mjs call this. */
export function _caramelResetCachedCodes() {
    _caramelCodes = null
}
export async function getCachedCodes(rec) {
    if (_caramelCodes && _caramelCodes.domain === rec.domain)
        return _caramelCodes.list
    let list = []
    try {
        list = await fetchCoupons(rec.domain, '', '')
    } catch {
        list = []
    }
    _caramelCodes = {
        domain: rec.domain,
        list: Array.isArray(list) ? list : [],
    }
    return _caramelCodes.list
}

/* --------------------------------------------------  init hook */
export async function tryInitialize() {
    if (!(await isCheckout())) return
    // isCheckout() has already answered yes. With no config row the only way it
    // could have is the platform-cart capability check, so a stand-in record is
    // enough to fetch codes and run the link path — no second probe needed.
    const rec =
        (await getDomainRecord(location.hostname)) ??
        caramelConfiglessRecord(location.hostname)
    // Don't intercept a checkout we have no codes for — only show the prompt
    // when there's actually something to apply ("checkout without code → why the
    // intercept?"). The fetched list is cached for the apply step.
    const codes = await getCachedCodes(rec)
    if (codes.length) await insertCaramelPrompt(rec)
}

/* Finish an attempt the page interrupted by navigating (see
 * caramelMarkPendingSubmit in dom-utils.js for the 1800petmeds case this
 * exists for: a real $14.78 won, and 180 seconds of silence).
 *
 * The record says only which code was submitted and what the prices were
 * beforehand. Whether it WORKED is measured here, on the page the store just
 * served, so every outcome below is read off the live document:
 *
 *   total dropped        → a real, measured win: bank it and say so
 *   total didn't drop    → say that plainly, and hand over the other codes
 *   nothing readable     → say we can't tell, and point at the order summary
 *
 * The third case is the one worth being strict about. It is tempting to treat
 * "we submitted a code and the page reloaded" as success — that is exactly how
 * a tool starts claiming savings its user never got. Silence was the bug;
 * inventing a number would be a worse one.
 *
 * Returns true when it handled the page (a modal is up), false to continue with
 * normal checkout detection.
 */
/* Pick the loop back up on the page the store navigated us to.
 *
 * A submit on a classic form-POST cart is a page load, so one click tests one
 * code. motoin.de and proaudiostar.com both behave this way: 20 codes means 20
 * clicks and 20 reloads, and nobody gets to the bottom of that list — which is
 * exactly where the untried codes sit.
 *
 * The bounds that make this safe to do without asking again live on the run
 * record itself (hops, wall-clock, cancellation — see caramelBeginRun). Two more
 * are this function's own, because they are about the page we landed on rather
 * than the run:
 *
 *   · a coupon box has to be HERE. The shopper may have navigated themselves,
 *     and continuing on a product page would submit codes into nothing while
 *     spending the chain's budget on it.
 *   · there has to be a code we have not already tried, or the next hop is a
 *     guaranteed no-op that still costs a reload.
 */
async function _caramelContinueRun(rec) {
    if (!rec) return false
    const box = pickBestMatch(rec.couponInput)
    const toggle = rec.showInput ? pickBestMatch(rec.showInput) : null
    if (!box && !toggle) return false
    let codes = []
    try {
        codes = await getCachedCodes(rec)
    } catch {
        return false
    }
    const tried = _getTriedCodes()
    const untried = (codes || []).filter(c => c && c.code && !(c.code in tried))
    if (!untried.length) return false
    const hop = caramelClaimRunHop()
    if (!hop) return false
    log('AUTO_INSERT_RUN_CONTINUES', {
        hop: hop.hops,
        remaining: hop.remaining,
        untried: untried.length,
    })
    try {
        await startApplyingCoupons(rec, { resumed: true })
    } catch (e) {
        // A throw here would leave the shopper behind an "Applying…" overlay
        // with nothing coming. Take the overlay down and report false, so the
        // caller falls through to telling them what happened to the code we
        // already submitted. The hop stays spent — we did try.
        log('AUTO_INSERT_RESUME_FAILED', { error: String(e) })
        hideTestingModal()
        return false
    }
    return true
}

async function _resumePendingSubmit() {
    const pending = caramelTakePendingSubmit()
    if (!pending) return false
    const rec = await getDomainRecord(location.hostname)
    const now =
        rec && rec.priceContainer
            ? getPrice(rec.priceContainer, { returnLargest: true })
            : NaN
    // Same tightest-defensible-baseline rule the in-page path uses, against the
    // prices captured before the submit — it can never overstate a saving.
    const baseline = caramelBaselineFor(now, pending.prices)
    const saved =
        Number.isFinite(now) && Number.isFinite(baseline) ? baseline - now : NaN
    const measured = Number.isFinite(saved) && saved > 0

    log('AUTO_INSERT_RESUMED', {
        code: pending.code,
        measured,
        saved: measured ? saved : null,
        readable: Number.isFinite(now),
    })

    if (measured) {
        // Won — the chain has its answer and must not continue.
        caramelEndRun()
        reportOutcome(pending.id, 'worked')
        caramelRecordSaving({
            domain: location.hostname,
            code: pending.code,
            amount: saved,
            currency: caramelCurrencyCode(),
            couponId: pending.id,
        })
        showFinalModal(saved, pending.code)
        return true
    }

    // Not a win. Deliberately NOT reported as a coupon failure: the page
    // navigating out from under us says nothing about the code, and the runner
    // holds the same line — only the store's own rejection words count.
    let others = []
    try {
        if (rec) others = await getCachedCodes(rec)
    } catch {
        /* no code list to offer — the message below still stands on its own */
    }
    /* The store usually answered on the page it sent us to.
     *
     * motoin.de prints “Dieser Gutschein ist abgelaufen” at the top of the fresh
     * cart, and we were telling the shopper to go and check their order summary
     * for themselves — asking them to work out something the merchant had
     * already spelled out. Only a verdict we can attribute is quoted (it names
     * our code, or it speaks in rejection vocabulary); see
     * caramelPostNavigationVerdict for why comparison isn't available here.
     */
    const verdict = caramelPostNavigationVerdict(rec, pending.code)
    const said = verdict ? `The store said: “${verdict.slice(0, 140)}”. ` : ''

    // That code didn't win, and on this kind of cart every code costs a page
    // load. Carry the run on rather than making the shopper click per code.
    if (await _caramelContinueRun(rec)) return true
    caramelEndRun()

    if (Number.isFinite(now)) {
        // We could read the total and it did not move.
        showFinalModal(
            0,
            null,
            `${said}We submitted ${pending.code} before the page reloaded, but your total hasn't changed — copy another code below to try it yourself.`,
            false,
            caramelSinkTriedCodes(
                others.filter(
                    c =>
                        String(c && c.code).toUpperCase() !==
                        pending.code.toUpperCase(),
                ),
            ),
        )
    } else if (verdict) {
        // The store told us why, so there is nothing for the shopper to go and
        // check — say it, and move them on to the next code.
        showFinalModal(
            0,
            null,
            `${said}Copy another code below to try it yourself.`,
            false,
            caramelSinkTriedCodes(others),
        )
    } else {
        showFinalModal(
            0,
            null,
            `We submitted ${pending.code} just before the page reloaded — check your order summary to see whether it applied.`,
            false,
            caramelSinkTriedCodes(others),
        )
    }
    return true
}

/* Entry point. Beyond the one-shot load check, KEEP WATCHING: on SPA / drawer-
   cart stores (allsaints and most SFCC/Shopify sites) the coupon field is
   injected only when the user opens the bag/cart — with no page navigation, so
   a load-time check finds nothing and the user sees nothing even though the
   promo box is right there. Re-detect it: observe the DOM and show the prompt
   the moment the coupon field appears. Debounced + self-disconnects after it
   fires once, so it costs ~nothing and never nags. */
// Called from inject.js and from coupon-runner.js's URL-change re-detection.
export async function startCheckoutDetection() {
    // A discount-link apply reloads the page so the store's own UI shows the
    // applied code; finish that flow on the fresh document by showing the
    // result modal instead of re-prompting.
    try {
        const raw = sessionStorage.getItem('caramel_applied')
        if (raw) {
            sessionStorage.removeItem('caramel_applied')
            const st = JSON.parse(raw)
            if (st && st.code && Date.now() - (st.t || 0) < 120000) {
                // Discount-link wins reload the page before extension
                // storage can be written safely — record the saving here,
                // on the fresh document, from the sessionStorage handoff.
                caramelRecordSaving({
                    domain: location.hostname,
                    code: st.code,
                    amount: st.saved || 0,
                    currency: st.currency || 'USD',
                    couponId: st.id || null,
                })
                let amount = st.saved || 0
                let msg = null
                if (st.currency && st.currency !== 'USD' && amount > 0) {
                    // No price has been read on this freshly-reloaded page, so
                    // tell the UI the currency the saving was recorded in.
                    // Only then does the headline amount render as "£8.00".
                    let symbolKnown = false
                    try {
                        const sym = new Intl.NumberFormat(undefined, {
                            style: 'currency',
                            currency: st.currency,
                        })
                            .formatToParts(amount)
                            .find(p => p.type === 'currency')?.value
                        symbolKnown = caramelSetCurrencySymbol(sym)
                        if (!symbolKnown) {
                            // Symbol we can't render in the headline (e.g.
                            // "CA$", "R$"). Fall back to the applied-code
                            // presentation, which states the formatted amount
                            // in words rather than mislabelling it as "$".
                            msg = `Code ${st.code} saved you ${new Intl.NumberFormat(
                                undefined,
                                { style: 'currency', currency: st.currency },
                            ).format(amount)} — it's applied to your order.`
                            amount = 0
                        }
                    } catch {
                        /* unknown currency code — fall back to $ */
                    }
                }
                showFinalModal(amount, st.code, msg)
                return
            }
        }
    } catch {
        /* sessionStorage unavailable — continue with normal detection */
    }
    // An attempt the store's own form POST cut short finishes here, on the page
    // that replaced it — before tryInitialize can re-prompt as if nothing had
    // happened, which is precisely what the user saw before.
    if (await _resumePendingSubmit()) return
    await tryInitialize()
    if (window.__caramel_checkout_observer) return
    const rec = await getDomainRecord(location.hostname)
    if (!rec) return // not a supported store — don't observe at all
    let scheduled = false
    const recheck = () => {
        scheduled = false
        // Don't re-prompt if the prompt is already up or we're mid-apply.
        if (
            document.getElementById('caramel-small-prompt') ||
            document.getElementById('caramel-testing-overlay') ||
            document.getElementById('caramel-final-overlay')
        )
            return
        // Require the coupon box (or its reveal toggle) to be VISIBLE, not just
        // present — so a hidden, pre-rendered cart drawer doesn't pop the prompt
        // before the user actually opens the cart. Over-broad selectors are
        // rejected here on the same terms as isCheckout(): this observer runs on
        // every DOM mutation, so a selector matching hundreds of elements would
        // otherwise re-summon the prompt across the whole site.
        if (
            caramelCouponAnchors(rec.couponInput).length > 0 ||
            caramelCouponAnchors(rec.showInput).length > 0
        ) {
            // Only prompt if we actually have codes for this store (no empty
            // intercept). getCachedCodes is cached, so this is cheap.
            getCachedCodes(rec).then(codes => {
                if (
                    !codes.length ||
                    document.getElementById('caramel-small-prompt') ||
                    document.getElementById('caramel-testing-overlay') ||
                    document.getElementById('caramel-final-overlay')
                )
                    return
                insertCaramelPrompt(rec)
                if (window.__caramel_checkout_observer) {
                    window.__caramel_checkout_observer.disconnect()
                    window.__caramel_checkout_observer = null
                }
            })
        }
    }
    const mo = new MutationObserver(() => {
        if (scheduled) return
        scheduled = true
        setTimeout(recheck, 400)
    })
    // childList catches a freshly-inserted coupon box; attributes catches the
    // equally common SPA case of a pre-rendered box merely revealed via a
    // class/style/hidden toggle (no new node, so childList alone misses it).
    // Both feed the same debounced recheck above — no separate mechanism.
    mo.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden'],
    })
    window.__caramel_checkout_observer = mo
}
