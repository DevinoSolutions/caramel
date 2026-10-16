/**
 * Porkbun's native coupon-failure alert(), kept from freezing the apply run
 * (T-2480, 2026-10-15). The whole story lives in ../porkbun-alert-shim.js.
 *
 * A SECOND content script on purpose: it must run in the page's own world
 * (`world: 'MAIN'`, which has no extension API and needs none), and the main
 * content realm has to stay isolated. Narrowest match that works: the
 * checkout pages on the bare domain, where the coupon modal lives.
 *
 * Not in the Firefox build (`include: ['chrome']`). Safari has no WXT target:
 * the release workflow derives its package from the Chrome build, so Safari
 * DOES ship this entry. If Safari ignores `world: 'MAIN'` the script runs in the
 * isolated world, where wrapping `window.alert` and the capture listeners change
 * nothing the page can see; if it honours it, the shim behaves as on Chrome.
 * Either way Porkbun's native dialog is the fallback.
 * TODO: verify on Safari and on Firefox (128+ has `world: 'MAIN'`), then decide
 * whether Firefox joins.
 */
import { installPorkbunAlertShim } from '../porkbun-alert-shim.js'

export default defineContentScript({
    matches: ['https://porkbun.com/checkout/*'],
    world: 'MAIN',
    runAt: 'document_start',
    include: ['chrome'],
    main() {
        installPorkbunAlertShim(window)
    },
})
