// Which viewport the probe measures at.
//
// Its own module because it is a POLICY, not a detail: QA must run at the
// viewport the config was DERIVED at. `agent_discovery` drives its browser at
// `--viewport 1920x1080` and writes selectors against that DOM, while this
// probe defaulted to 390x844 — so every config was proven on a desktop layout
// and then graded on a phone one. A phone is a different DOM and frequently a
// different checkout, which made reds that were never about the config.
// Desktop is the default; a mobile pass is opt-in and explicit (owner call,
// 2026-08-14).
//
// Browser-free, like verdict.mjs, so the rule is pinned in CI rather than
// rediscovered on a live store.

/** Matches `agent_discovery`'s `--viewport 1920x1080`. */
export const DESKTOP_VIEWPORT = Object.freeze({ width: 1920, height: 1080 })

/**
 * The conventional height for a phone-class width, so `--width 390` yields a
 * real phone rather than a 390x1080 sliver. `--height` overrides either way.
 */
export const MOBILE_HEIGHT = 844
export const DESKTOP_MIN_WIDTH = 1024

/**
 * `--viewport 1920x1080` (the spelling agent_discovery uses) is authoritative
 * when given; otherwise width and height are taken individually, and a width
 * alone picks the conventional height for its class.
 *
 * @param {{viewport?: string, width?: string|number, height?: string|number}} flags
 * @param {string|number} [widthArg] the positional width, kept for the old call shape
 * @returns {{width: number, height: number}}
 */
export function resolveViewport(flags = {}, widthArg = undefined) {
    const pair = String(flags.viewport || '').match(/^(\d+)\s*[x×]\s*(\d+)$/i)
    if (pair) return { width: Number(pair[1]), height: Number(pair[2]) }
    const width = Number(flags.width || widthArg || DESKTOP_VIEWPORT.width)
    const height = Number(
        flags.height ||
            (width >= DESKTOP_MIN_WIDTH
                ? DESKTOP_VIEWPORT.height
                : MOBILE_HEIGHT),
    )
    return { width, height }
}
