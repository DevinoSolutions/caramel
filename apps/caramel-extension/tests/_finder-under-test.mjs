// The finder as the test suites load it. The shipped file
// (scripts/finder-bundle.mjs) adds caramelProvideFinderHost, which fills the
// finder's shared imports; under vitest those imports already are the content
// script's own modules, so the hand-over here has nothing to fill.
export * from '../coupon-box-discovery.js'
export function caramelProvideFinderHost() {}
