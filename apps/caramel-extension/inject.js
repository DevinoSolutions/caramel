log('Injected script')
// Detection starts at `load` — but never ONLY at load. Measured live
// (chomps.com drawer, 2026-08-07): a subresource never resolved, `load`
// never fired, and on a store we hold codes for the extension was
// indistinguishable from not installed. One stuck tracker must not switch
// us off — DOMContentLoaded + a grace delay races the load listener,
// turning "never" into seconds; on healthy pages load still wins, keeping
// load-gating's intent. Pinned by tests/entry-not-load-gated.test.mjs.
var _caramelDetectionStarted = false
function _caramelStartDetectionOnce() {
    if (_caramelDetectionStarted) return
    _caramelDetectionStarted = true
    startCheckoutDetection()
}
var CARAMEL_DCL_GRACE_MS = 5000
if (document.readyState === 'complete') {
    // Injection can land after `load` already fired; a listener would never run.
    _caramelStartDetectionOnce()
} else {
    window.addEventListener('load', _caramelStartDetectionOnce)
    if (document.readyState === 'interactive') {
        setTimeout(_caramelStartDetectionOnce, CARAMEL_DCL_GRACE_MS)
    } else {
        document.addEventListener('DOMContentLoaded', () =>
            setTimeout(_caramelStartDetectionOnce, CARAMEL_DCL_GRACE_MS),
        )
    }
}
