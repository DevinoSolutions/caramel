import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { entryModuleClosure, EXT_ROOT } from './_entry-modules.mjs'

// Safari before 16.4 has no regex lookbehind. macOS 13.0 is inside the release
// workflow's deployment floor (MACOS_DEPLOYMENT_FLOOR in
// .github/workflows/release-extension.yml) and Safari 16.0-16.3 runs there. A
// pattern with a lookbehind is a SyntaxError when the module loads, so one
// literal or one `new RegExp('...')` string anywhere in a shipped script takes
// the whole content script down on those browsers, flag off included.
//
// The scan is over the raw text, so it covers a regex literal, a RegExp string
// and a String.raw template alike. Named groups are fine and are not matched.
// Comments that spell a lookbehind out are flagged too: say it another way
// ("no lookbehind") rather than quoting the syntax.
const LOOKBEHIND_OPENER = /\(\?<[=!]/g

// Every script the browser runs in a store page or the service worker, derived
// from the entrypoints' import graph (the inputs WXT bundles), plus the
// entrypoints themselves, which are TypeScript and so not in the .js closure.
const SHIPPED_SCRIPTS = [
    ...new Set([
        ...entryModuleClosure(
            'entrypoints/content.ts',
            'entrypoints/background.ts',
        ),
        'entrypoints/content.ts',
        'entrypoints/background.ts',
    ]),
].toSorted()

/** 1-based line numbers of every lookbehind opener in `source`. */
function lookbehindLines(source) {
    const lines = []
    for (const match of source.matchAll(LOOKBEHIND_OPENER)) {
        lines.push(source.slice(0, match.index).split('\n').length)
    }
    return lines
}

describe('no regex lookbehind in any shipped script', () => {
    it('scans the content scripts and the service worker, not a hand-kept list', () => {
        for (const file of [
            'coupon-apply.js',
            'coupon-box-discovery.js',
            'coupon-runner.js',
            'store-detect.js',
            'caramel-base.js',
            'background.js',
            'entrypoints/content.ts',
        ]) {
            expect(SHIPPED_SCRIPTS).toContain(file)
        }
    })

    it.each(SHIPPED_SCRIPTS)('%s uses no lookbehind', file => {
        const source = readFileSync(join(EXT_ROOT, file), 'utf8')
        expect(
            lookbehindLines(source),
            `${file} has a regex lookbehind at these lines; Safari before 16.4 throws on it at load`,
        ).toEqual([])
    })

    it('flags a lookbehind in a literal, a RegExp string and a String.raw template', () => {
        expect(lookbehindLines(String.raw`const a = /(?<=[.!?])\s+/`)).toEqual([
            1,
        ])
        expect(
            lookbehindLines(String.raw`const a = new RegExp('(?<!\bno )x')`),
        ).toEqual([1])
        expect(lookbehindLines('const a = String.raw`x(?<!y)z`')).toEqual([1])
        expect(
            lookbehindLines(['a', 'b(?<=c)', '', 'd(?<!e)'].join('\n')),
        ).toEqual([2, 4])
    })

    it('leaves a named group and a fully escaped lookbehind sequence alone', () => {
        expect(lookbehindLines(String.raw`const a = /(?<year>\d{4})/`)).toEqual(
            [],
        )
        expect(lookbehindLines(String.raw`const a = /\(\?<=x/`)).toEqual([])
    })
})
