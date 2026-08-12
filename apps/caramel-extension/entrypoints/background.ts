/**
 * The worker realm (WXT P1, 2026-08-12). background.js moved its top-level
 * effects into initBackground() (recipe rule 1b); calling it synchronously
 * here preserves MV3's requirement that every listener registers in the
 * worker's first task. The env stamp needs no call: background.js imports
 * caramel-env.js, whose module evaluation publishes globalThis.CARAMEL_ENV /
 * CARAMEL_BASE_URL before any importer runs — scripts/test-extension.mjs
 * still reads those out of the live worker to prove which deployment a
 * loaded build resolved to.
 */
import { initBackground } from '../background.js'

export default defineBackground(() => {
    initBackground()
})
