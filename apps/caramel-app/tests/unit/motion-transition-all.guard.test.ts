import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Motion pass 2/3: the files below were moved off `transition-all` onto named
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
]

describe('motion pass: cleared files carry no transition-all', () => {
    it.each(CLEARED_FILES)('%s', file => {
        const source = fs.readFileSync(path.join(srcDir, file), 'utf8')
        expect(source).not.toMatch(
            /transition-all|transition-\[all\]|transition:\s*all/,
        )
        expect(source).not.toMatch(/hover:scale-/)
    })
})
