/**
 * Porkbun's native coupon-failure alert(), kept from freezing the apply run
 * (T-2480, 2026-10-15). The whole story lives in ../porkbun-alert-shim.js.
 *
 * A SECOND content script on purpose: it must run in the page's own world
 * (`world: 'MAIN'`, which has no extension API and needs none), and the main
 * content realm has to stay isolated. Narrowest match that works: the
 * checkout pages on the bare domain, where the coupon modal lives.
 *
 * Shipped in every build, Safari's included (release-extension.yml derives it
 * from the Chrome build). Whether `world: 'MAIN'` is honoured is the BROWSER's
 * business and is never assumed: the shim stamps a marker on <html> only when it
 * can see the page's own handler, i.e. only when it really runs in the page's
 * world, and the content realm sends that proof (`?caps=alertShim`) with its
 * coupon fetch (coupon-fetch.js). GET /api/coupons withholds porkbun.com's codes
 * from an extension that does not send it, so without the marker there are no
 * codes to try and Caramel stays silent on the store.
 * Verified live on porkbun.com 2026-10-16: Chrome (built extension) and Firefox
 * 152 (installed through WebDriver BiDi) both stamp the marker, apply with zero
 * native dialogs; with the script removed (the shape of a browser that ignores
 * `world`) the marker is absent and Caramel stays silent on the store.
 * Firefox 109-127 and Safari were not run: they take the "ignored" path above.
 * TODO: confirm on a real Safari that the marker stays absent or true to form.
 */
import { installPorkbunAlertShim } from '../porkbun-alert-shim.js'

export default defineContentScript({
    matches: ['https://porkbun.com/checkout/*'],
    world: 'MAIN',
    runAt: 'document_start',
    main() {
        installPorkbunAlertShim(window)
    },
})
