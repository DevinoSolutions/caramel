/**
 * TODO(WXT-P1): SCAFFOLD STUB — not the real service worker. The shipping
 * background is still background.js (Chrome MV3 service_worker; Firefox
 * background.scripts with caramel-env.js prepended). P1 ports it here.
 */
export default defineBackground(() => {
    // Stamp-first: the flat alias mirrors caramel-env.js, which
    // scripts/test-extension.mjs reads out of the live worker to prove which
    // deployment a loaded build resolved to.
    globalThis.CARAMEL_ENV = Object.freeze(__CARAMEL_ENV__)
    globalThis.CARAMEL_BASE_URL = __CARAMEL_ENV__.baseUrl
})
