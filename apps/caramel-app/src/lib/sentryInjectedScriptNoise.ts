// Browser-extension scripts injected into our pages, dropped by the browser
// SDK before they are sent (Sentry `denyUrls`, T-2935).
//
// `executors/<n>.js` is not ours: no file by that name exists in the app or
// the extension. A third-party extension injects it into the page, and its
// `TypeError: Cannot read properties of undefined (reading 'M_ID')` reaches
// window.onunhandledrejection, so the SDK reported it as ours: CARAMEL-Z
// (117 events in 13 minutes on /welcome) and VOICELABS-WEB-15 (1,227 events)
// carry the identical frames, `executors/200.js:1:1442 (E)` and `:1:761 (Y)`.
//
// `denyUrls` is matched against the URL of the frame that threw, so an error
// from our own bundle keeps reporting even when its message is the same. The
// pattern matches the file at any location: a bare `executors/200.js` from a
// `//# sourceURL`, the `app:///executors/200.js` form Sentry shows after the
// Next.js frame rewrite, and an extension or page origin in front of it.
export const INJECTED_SCRIPT_DENY_URLS: RegExp[] = [
    /(?:^|\/)executors\/\d+\.js(?:[?#:]|$)/,
]
