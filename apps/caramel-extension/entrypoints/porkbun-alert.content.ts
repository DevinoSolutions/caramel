/**
 * Porkbun's native coupon-failure alert(), kept from freezing the apply run
 * (T-2480, 2026-10-15). The whole story lives in ../porkbun-alert-shim.js.
 *
 * A SECOND content script on purpose: it must run in the page's own world
 * (`world: 'MAIN'`, which has no extension API and needs none), and the main
 * content realm has to stay isolated. Narrowest match that works: the
 * checkout pages on the bare domain, where the coupon modal lives.
 *
 * Chromium builds only. Manifest `world: 'MAIN'` is what Chrome/Edge honour;
 * where it is unsupported the entry is left out rather than shipped as an
 * isolated script that would silently do nothing. Firefox and Safari keep
 * Porkbun's native dialogs until `world: 'MAIN'` is verified there.
 * TODO: verify Firefox (128+) and Safari manifest MAIN-world support, then
 * widen `include`.
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
