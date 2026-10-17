// @vitest-environment node
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildFinderModule } from '../scripts/finder-bundle.mjs'
import {
    FINDER_ASSET,
    FINDER_SOURCE,
    finderHostNames,
} from '../scripts/finder-files.mjs'
import { EXT_ROOT } from './_entry-modules.mjs'

// The promo-box finder ships as its own file (assets/coupon-box-finder.js)
// that the content script loads on demand. These pin the contract between the
// two, which no browser test can see until a shopper hits it:
//   · the built file exports everything the content script calls on it;
//   · the loader hands over exactly the functions the finder imports from the
//     modules it shares with the content script, no fewer (a missing one is
//     undefined inside the finder) and no more;
//   · nothing else is bundled into it (a second copy of a shared module would
//     be a second logger and a second set of last-read prices).

const read = file => readFileSync(join(EXT_ROOT, file), 'utf8')

/** The finder functions the content script calls, read from its source. */
function namesCalledOnTheFinder() {
    const names = new Set()
    for (const file of [
        'store-detect.js',
        'coupon-runner.js',
        'coupon-apply.js',
    ])
        for (const m of read(file).matchAll(
            /(?:\bfinder|caramelLoadFinder\(\)\)|caramelLoadedFinder\(\))\??\.(\w+)/g,
        ))
            names.add(m[1])
    return [...names].sort()
}

/** The keys the loader passes to caramelProvideFinderHost. */
function namesTheLoaderHandsOver() {
    const src = read('coupon-box-finder-loader.js')
    const body = /caramelProvideFinderHost\(\{([^}]*)\}\)/.exec(src)
    expect(body, 'the loader hands the finder its host').not.toBeNull()
    return body[1]
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .sort()
}

describe('the finder file the content script loads on demand', () => {
    let built
    const build = async () => (built ??= await buildFinderModule(EXT_ROOT))

    it('exports every finder function the content script calls, and the host hand-over', async () => {
        const text = await build()
        const url =
            'data:text/javascript;base64,' +
            Buffer.from(text).toString('base64')
        const mod = await import(/* @vite-ignore */ url)
        const called = namesCalledOnTheFinder()
        // The callers really were found (a regex that matches nothing would
        // pass this vacuously).
        expect(called).toEqual(
            expect.arrayContaining([
                'caramelDiscoveredRecord',
                'caramelFinderMayAsk',
                'caramelFinderReadTotal',
                'caramelFinderSeesBox',
                'caramelFinderTotalNow',
                'caramelRemarkFoundBox',
            ]),
        )
        for (const name of called)
            expect(typeof mod[name], `${name} is exported`).toBe('function')
        expect(typeof mod.caramelProvideFinderHost).toBe('function')
    })

    it('the loader asks for the path the build writes the finder to', () => {
        expect(read('coupon-box-finder-loader.js')).toContain(
            `const FINDER_MODULE = '${FINDER_ASSET}'`,
        )
    })

    it('the loader hands over exactly what the finder imports from the shared modules', () => {
        const imported = finderHostNames(read(FINDER_SOURCE))
        expect(imported.length).toBeGreaterThan(0)
        expect(namesTheLoaderHandsOver()).toEqual(imported)
    })

    it('holds the finder alone: the shared modules are not copied into it', async () => {
        const text = await build()
        // Names that live only in the shared modules' bodies.
        expect(text).not.toContain('initCaramelBase')
        expect(text).not.toContain('caramelBeginRun')
    })

    it('fits the budget .size-limit.js gives it', async () => {
        // The budget is written once, in .size-limit.js; this reads it rather
        // than repeating it. A bundle that grew because a shared module was
        // copied in would be caught here before the size gate runs.
        const budgets = createRequire(import.meta.url)('../.size-limit.js')
        const entry = budgets.find(b =>
            b.path.endsWith('coupon-box-finder.min.js'),
        )
        const [, kb] = /^([\d.]+) KB$/.exec(entry.limit)
        expect(Buffer.byteLength(await build())).toBeLessThan(Number(kb) * 1000)
    })
})
