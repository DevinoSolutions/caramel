// The hero wordmark is `lg:w-full` (100% wide below lg). When both of its
// ancestors were shrink-to-fit, that 100% had nothing to resolve against until
// the image had downloaded, so the wordmark laid out at 0×0 and the heading
// grew ~92px on arrival: the vertically centred hero block jumped, which was
// PageSpeed's whole mobile CLS (0.098, 2026-09-26). Both ancestors carry
// `lg:w-full` so the box has its final size from the first frame. Read from
// source: jsdom does no layout, and Lighthouse only sees the shift when the
// image loses the race with first paint.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const hero = readFileSync(
    join(__dirname, '..', '..', 'src', 'components', 'HeroSection.tsx'),
    'utf8',
)

describe('hero wordmark reserves its box before the image loads', () => {
    it('the h1 and the wordmark wrapper are full width below lg', () => {
        expect(hero).toMatch(/<h1 className="hero-enter[^"]*\blg:w-full\b/)
        expect(hero).toMatch(/className="hero-enter-scale relative lg:w-full"/)
    })

    it('the wordmark is the pixel-identical lossless WebP', () => {
        expect(hero).toContain('src="/full-logo.webp"')
    })
})
