// Where a test's runtime.getURL stub sends the finder the content script loads
// on demand (coupon-box-finder-loader.js): the build ships the bundle at
// FINDER_ASSET, and under vitest the source module, with the host hand-over
// the bundle adds (_finder-under-test.mjs), stands in for it.
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FINDER_ASSET, FINDER_SOURCE } from '../scripts/finder-files.mjs'
import { EXT_ROOT } from './_entry-modules.mjs'

export { FINDER_ASSET }
export const FINDER_FILE = pathToFileURL(
    join(EXT_ROOT, 'tests', '_finder-under-test.mjs'),
).href
// The bare source: a module with no host hand-over, which the loader refuses.
export const FINDER_WITHOUT_HANDOVER = pathToFileURL(
    join(EXT_ROOT, FINDER_SOURCE),
).href

/** A runtime.getURL stub for suites that load nothing else from the package:
 *  the finder resolves to its stand-in, any other asset to a URL that does
 *  not load. */
export const finderOnlyGetURL = path =>
    path === FINDER_ASSET ? FINDER_FILE : 'chrome-extension://caramel/' + path
