// owns: the content script's whole share of the promo-box finder. That is
// the flag read (caramelCouponBoxDiscoveryOn) and the on-demand load of the
// finder itself (caramelLoadFinder, caramelLoadedFinder).
//
// The finder (coupon-box-discovery.js) is not in the content-script bundle.
// The build ships it as assets/coupon-box-finder.js, the same way the outline
// builder ships as assets/coupon-box-outline.js, and it is imported only by a
// page that is about to run it: the finder flag is on, the store list was
// read, and the page has no box a config describes (a store with no config,
// or one whose configured box is no longer on the page). Every other page,
// which with the flag off is every page, never requests it.
//
// The loaded module shares this script's state rather than carrying copies of
// it: the build replaces its imports of caramel-base.js, dom-utils.js and this
// file with the live functions handed over here (caramelProvideFinderHost),
// so the last-read prices, the logger and the flag answers are one.
//
// A finder that cannot be loaded is a finder that found nothing: every caller
// treats null as "no box", the shopper gets the codes to copy, and no saving
// can come of it.
import {
    caramelSendMessage,
    currentBrowser,
    log,
    logError,
    sleep,
} from './caramel-base.js'
import {
    _isVisible,
    caramelFindMoney,
    caramelIsForbiddenControl,
    caramelSetLastPrices,
    getPrice,
} from './dom-utils.js'

/* Is the finder switched on? The background answers from its cached features
 * read; any failure to ask is answered as off. Asked once per page. */
let _discoveryOn = null
// Called from coupon-runner.js and store-detect.js.
export function caramelCouponBoxDiscoveryOn() {
    if (!_discoveryOn)
        _discoveryOn = caramelSendMessage({
            action: 'couponBoxDiscoveryEnabled',
        })
            .then(resp => resp?.enabled === true)
            .catch(e => {
                log('FINDER_FLAG_UNREADABLE', { error: String(e) })
                return false
            })
    return _discoveryOn
}

// Test seam (via coupon-box-discovery.js's reset): forget the flag answer.
export function _caramelResetDiscoveryOn() {
    _discoveryOn = null
}

const FINDER_MODULE = 'assets/coupon-box-finder.js'

let _finder = null
let _loaded = null

/* The finder module, loaded once per page. Resolves to null when it could not
 * be loaded: never throws. */
export function caramelLoadFinder() {
    if (!_finder)
        _finder = Promise.resolve()
            .then(
                () =>
                    import(
                        /* @vite-ignore */ currentBrowser.runtime.getURL(
                            FINDER_MODULE,
                        )
                    ),
            )
            .then(m => {
                // A finder that cannot take the content script's helpers
                // would run with them undefined: treat it as not loaded.
                if (typeof m?.caramelProvideFinderHost !== 'function')
                    throw new Error('the finder module has no host hand-over')
                m.caramelProvideFinderHost({
                    caramelSendMessage,
                    currentBrowser,
                    log,
                    sleep,
                    _isVisible,
                    caramelFindMoney,
                    caramelIsForbiddenControl,
                    caramelSetLastPrices,
                    getPrice,
                    _caramelResetDiscoveryOn,
                })
                _loaded = m
                return m
            })
            .catch(err => {
                // Once per page (the failed load is kept), and never shown to
                // the shopper: logError records it where a shipped build's
                // failures are read, which log() does not.
                logError('FINDER_LOAD_FAILED', err)
                return null
            })
    return _finder
}

/* The finder if this page already loaded it, else null. The apply flow reads
 * it this way: a record the finder built means the finder is loaded. */
export const caramelLoadedFinder = () => _loaded

// Test seam: forget the load.
export function _caramelResetFinderLoad() {
    _finder = null
    _loaded = null
}

// Test seam: a page whose finder is already loaded, for suites that build the
// finder's records by hand.
export function _caramelUseLoadedFinder(m) {
    _loaded = m
    _finder = Promise.resolve(m)
}
