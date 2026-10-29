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
// `scripts/inpage.js` is MetaMask's injected provider script (extension id
// nkbihfbeogaeaoehlefnkodbefgpgknn); Caramel has no wallet code and no file by
// that name. When MetaMask is not reachable it rejects with `Failed to connect
// to MetaMask` / `No extension found with id: ...`, and window.onunhandledrejection
// reported it as ours: CARAMEL-3D (2 events on /welcome, T-10410), every frame
// `app:///scripts/inpage.js:12:4822 (Object.connect)` and the cause at `:12:4734`.
// Unlike the executors pattern this one is ROOT-anchored (bare, or right after
// `<scheme>://<host>/`): MetaMask serves it from the extension root, and an
// any-location match would also drop a first-party URL such as
// `/_next/static/chunks/scripts/inpage.js` or `main.js?source=/scripts/inpage.js`.
//
// `denyUrls` is matched against the URL of the frame that threw, so an error
// from our own bundle keeps reporting even when its message is the same. The
// pattern matches the file at any location: a bare `executors/200.js` from a
// `//# sourceURL`, the `app:///executors/200.js` form Sentry shows after the
// Next.js frame rewrite, and an extension or page origin in front of it.
export const INJECTED_SCRIPT_DENY_URLS: RegExp[] = [
    /(?:^|\/)executors\/\d+\.js(?:[?#:]|$)/,
    /^(?:(?:https?|app|chrome-extension|moz-extension|safari-web-extension):\/\/[^/?#]*\/)?scripts\/inpage\.js(?:[?#:]|$)/,
]
