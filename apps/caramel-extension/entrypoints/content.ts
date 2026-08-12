/**
 * The content-script realm — the WXT composition of what manifest.json used
 * to load as an 11-file classic-script chain (WXT P1, 2026-08-12).
 *
 * Evaluation order is the module graph's business now; what this entrypoint
 * owns is the EFFECT order. Each ported module moved its top-level effectful
 * statements into an exported init (recipe rule 1b), and main() calls those
 * inits in the exact order the old manifest evaluated the files, so every
 * listener registers and every window seam publishes exactly as it did when
 * script order was the only ordering there was. Modules without an init
 * (dom-utils, store-detect, coupon-apply, coupon-fetch, UI-helpers) proved
 * their bodies side-effect-free — nothing to call.
 *
 * The CSS import is the manifest `css: ["caramel-content.css"]` entry's
 * successor: WXT bundles it and re-attaches it to this content script's css
 * array in the generated manifest.
 */
import '../caramel-content.css'

import { initCaramelBase } from '../caramel-base.js'
import { initCartSignals } from '../cart-signals.js'
import { initCouponConstants } from '../coupon-constants.generated.js'
import { initCouponRunner } from '../coupon-runner.js'
import { initInject } from '../inject.js'

export default defineContentScript({
    matches: ['https://*/*'],
    main() {
        // Old manifest order: env stamp (module graph handles it — see
        // caramel-env.js), constants, cart-signals, base, …, runner, inject.
        initCouponConstants()
        initCartSignals()
        initCaramelBase()
        initCouponRunner()
        initInject()
    },
})
