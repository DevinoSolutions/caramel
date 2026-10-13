// src/lib/extensionInstall.ts
//
// The contract of the post-install handshake, shared by every hop so none of
// them can drift:
//
//   extension background.js   opens   /welcome?src=ext&store=..&v=..&iid=..
//   /welcome (browser)        POSTs   /api/ext/installed  { store, extension_version, iid, distinct_id? }
//   /api/ext/installed        replies { captured: boolean }
//
// The extension is plain JS and cannot import this file; its copy of the store
// vocabulary is pinned to this one by apps/caramel-extension/tests (it asserts
// the URL it builds satisfies the same rules as `parseWelcomeParams`). The
// website side (page, client helper, route) imports from here.

/** The four store channels the extension ships through. */
export const EXTENSION_STORES = ['chrome', 'firefox', 'edge', 'safari'] as const
export type ExtensionStore = (typeof EXTENSION_STORES)[number]

/** The route the welcome page reports an install to. */
export const EXT_INSTALLED_ENDPOINT = '/api/ext/installed'

/** `1.4.6`, `1.4.6.1`: what a WebExtension manifest `version` can be. */
export const EXTENSION_VERSION_PATTERN = /^\d{1,5}(\.\d{1,5}){1,3}$/

/** `crypto.randomUUID()` output: the install id the extension mints once per install. */
export const INSTALL_ID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface ExtInstalledRequest {
    store: ExtensionStore
    extension_version: string
    /** Install id: also the PostHog event uuid, so a retry cannot double-count. */
    iid: string
    /** The browser's PostHog distinct id when posthog-js had loaded. */
    distinct_id?: string
}

export interface ExtInstalledResponse {
    /** PostHog accepted the server-side `extension_installed` event. */
    captured: boolean
}

export function isExtensionStore(value: unknown): value is ExtensionStore {
    return (
        typeof value === 'string' &&
        (EXTENSION_STORES as readonly string[]).includes(value)
    )
}

export function isExtInstalledResponse(
    value: unknown,
): value is ExtInstalledResponse {
    return (
        typeof value === 'object' &&
        value !== null &&
        'captured' in value &&
        typeof value.captured === 'boolean'
    )
}

function firstValue(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value
}

export interface WelcomeParams {
    store: ExtensionStore
    extensionVersion: string
    iid: string
}

/**
 * The install facts from the `/welcome` query string, or null when any is
 * missing or malformed (someone opened /welcome by hand, or an old/foreign
 * link): the page still renders, it just records nothing.
 */
export function parseWelcomeParams(raw: {
    src?: string | string[]
    store?: string | string[]
    v?: string | string[]
    iid?: string | string[]
}): WelcomeParams | null {
    const src = firstValue(raw.src)
    const store = firstValue(raw.store)
    const version = firstValue(raw.v)
    const iid = firstValue(raw.iid)
    if (src !== 'ext') return null
    if (!isExtensionStore(store)) return null
    if (!version || !EXTENSION_VERSION_PATTERN.test(version)) return null
    if (!iid || !INSTALL_ID_PATTERN.test(iid)) return null
    return { store, extensionVersion: version, iid }
}

/** The `source` of an install with no first-touch signal at all. */
export function organicInstallSource(store: ExtensionStore): string {
    return `${store}_web_store_organic`
}
