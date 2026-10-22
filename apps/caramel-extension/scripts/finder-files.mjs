// The finder's source file, the path it ships under, and the names it shares
// with the content script. Kept apart from scripts/finder-bundle.mjs so the
// test suites can use them without loading the bundler.
export const FINDER_SOURCE = 'coupon-box-discovery.js'
export const FINDER_ASSET = 'assets/coupon-box-finder.js'

// The modules the finder shares with the content script rather than bundling.
export const HOST_MODULES = new Set([
    './caramel-base.js',
    './dom-utils.js',
    './coupon-box-finder-loader.js',
])

/** The names the finder imports from the modules it shares with the content
 *  script: exactly what the loader must hand over. */
export function finderHostNames(source) {
    const names = []
    for (const m of source.matchAll(
        /^import\s*\{([^}]*)\}\s*from\s*'([^']+)'/gm,
    )) {
        if (!HOST_MODULES.has(m[2])) continue
        for (const n of m[1].split(',').map(s => s.trim())) if (n) names.push(n)
    }
    return names.sort()
}
