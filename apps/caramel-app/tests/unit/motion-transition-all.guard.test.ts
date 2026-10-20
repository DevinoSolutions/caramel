import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Motion passes 2/3 and 3/3: the files below were moved off `transition-all` onto named
// properties (the brief animates transform and opacity only, plus colours on
// small elements). A reintroduced `transition-all` re-animates layout and
// paint properties, so it fails here. Extend this list as later motion PRs
// clear more files.
const srcDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../src',
)

const CLEARED_FILES = [
    'components/support/support-form.tsx',
    'components/HeroSection.tsx',
    'components/StoreButtons.tsx',
    'components/growth/AgentSetupPill.tsx',
    'layouts/Header/Header.tsx',
    'components/FaqSection.tsx',
    'components/support/SupportDialog.tsx',
    'components/profile/ConfirmDialog.tsx',
    'components/growth/GrowthPromptCard.tsx',
]

// A bare `transition` class is Tailwind's multi-property list (colours, shadow,
// transform, filter...); name the properties instead. Matches the token only at
// a className boundary (start, whitespace or quote/backtick before; whitespace,
// quote/backtick or end after), so `transition-colors`, framer's
// `transition={{` and `transition:` are left alone.
const BARE_TRANSITION = /(^|[\s"'`])transition(?=$|[\s"'`])/

// Drop `/* */` blocks and `//` line comments (a `//` only counts at line start
// or after whitespace, so URLs survive) so prose like "the transition is" in a
// comment cannot false-positive.
function stripComments(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|\s)\/\/.*$/gm, '$1')
}

describe('bare transition matcher self-test', () => {
    it.each([
        'rounded transition hover:bg-white',
        'className="transition"',
        "'shadow transition'",
        'transition',
        'a transition focus:ring',
    ])('flags %s', text => {
        expect(stripComments(text)).toMatch(BARE_TRANSITION)
    })

    it.each([
        'transition-colors duration-fast',
        'transition-[transform,opacity]',
        'transition={{ duration: 0.3 }}',
        'transition: opacity 1s',
        'motion-safe:transition',
        '// the transition is soft',
        '/* the transition is soft */ rounded',
        '{/* a transition between states */}',
        'href="https://x.test/transition"',
    ])('ignores %s', text => {
        expect(stripComments(text)).not.toMatch(BARE_TRANSITION)
    })
})

describe('motion pass: cleared files carry no transition-all', () => {
    it.each(CLEARED_FILES)('%s', file => {
        const source = fs.readFileSync(path.join(srcDir, file), 'utf8')
        expect(source).not.toMatch(
            /transition-all|transition-\[all\]|transition:\s*all/,
        )
        expect(source).not.toMatch(/hover:scale-/)
        expect(stripComments(source)).not.toMatch(BARE_TRANSITION)
    })
})
