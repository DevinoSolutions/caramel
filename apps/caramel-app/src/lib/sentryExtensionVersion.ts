import { EXTENSION_STAMP_ATTRIBUTE } from '@/lib/surface/detectSurface'
import type { ErrorEvent } from '@sentry/nextjs'

// Which Caramel extension build was running in the tab, on every browser
// Sentry event. The extension's content script runs on our own pages too, and
// its storage errors surface here as the page's unhandled rejections
// (CARAMEL-1D, "Exceeded storage quota", T-10681): without the version a
// report from an old build and one from a fixed build look the same. The
// extension stamps <html data-caramel-extension="<version>"> on our origin
// (detectSurface.ts); no stamp means no extension, or a build from before the
// stamp.
export const EXTENSION_VERSION_TAG = 'caramel_extension'

const VERSION_RE = /^\d{1,3}\.\d{1,3}\.\d{1,4}$/

export function tagExtensionVersion(
    event: ErrorEvent,
    root: Pick<Element, 'getAttribute'> | null = typeof document === 'undefined'
        ? null
        : document.documentElement,
): ErrorEvent {
    const stamp = root?.getAttribute(EXTENSION_STAMP_ATTRIBUTE)
    // Any script on the page can write the attribute: only a version is kept.
    if (stamp && VERSION_RE.test(stamp))
        event.tags = { ...event.tags, [EXTENSION_VERSION_TAG]: stamp }
    return event
}
