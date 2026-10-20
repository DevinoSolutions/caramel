import { EventEmitter } from 'node:events'

// The listener ceiling for a response Next proxies to another origin.
//
// Analytics requests (`/_t/k3v/*`, see analytics/telemetryProxy.mjs) are an
// EXTERNAL rewrite, which Next serves through httpxy
// (next/dist/server/lib/router-utils/proxy-request.js). That path adds its own
// `close` listeners to the outgoing ServerResponse, on top of the ones Node's
// pipe and Next's response handling already hold. One proxied response ends
// up with 11, Node's default ceiling is 10, so every proxied analytics request
// printed this into the production log (measured 2026-10-20: a single
// `GET /_t/k3v/static/array.js` from inside the container was followed by the
// warning 0.1 s later):
//
//   MaxListenersExceededWarning: Possible EventEmitter memory leak detected.
//   11 close listeners added to [ServerResponse]. MaxListeners is 10.
//
// It is not a leak: the listeners belong to one response and go away when it
// closes. Nothing in proxy-request.js is configurable and app code never holds
// that response, so the ceiling is raised once, in the Node runtime's
// register(). 20 leaves room over the 11 measured, while a listener that really
// piles up on one emitter still warns.
const PROXIED_RESPONSE_LISTENER_CEILING = 20

// Raise Node's default listener ceiling, never lower it.
export function raiseListenerCeilingForProxiedResponses(): number {
    if (EventEmitter.defaultMaxListeners < PROXIED_RESPONSE_LISTENER_CEILING) {
        EventEmitter.defaultMaxListeners = PROXIED_RESPONSE_LISTENER_CEILING
    }
    return EventEmitter.defaultMaxListeners
}
