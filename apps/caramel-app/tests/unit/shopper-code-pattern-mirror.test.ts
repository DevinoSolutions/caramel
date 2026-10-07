import { SHOPPER_CODE_PATTERN, looksLikeCardNumber } from '@/lib/shopperCoupons'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The extension has no bundler and cannot import src/lib/shopperCoupons.ts, so
// apps/caramel-extension/code-capture.js carries a MIRROR of
// SHOPPER_CODE_PATTERN and of looksLikeCardNumber (the server re-validates; the
// mirror only stops the extension sending strings the server is certain to
// refuse). This is the drift guard, same idea as
// coupon-constants.generated.test.ts: it reads the pattern literal and the
// function out of the extension source and requires them to behave exactly like
// the app's. Red means one side changed without the other.

const CAPTURE_PATH = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../caramel-extension/code-capture.js',
)

const captureSource = (): string => fs.readFileSync(CAPTURE_PATH, 'utf8')

function mirroredPattern(): RegExp {
    const match = /^const SHOPPER_CODE_PATTERN = \/(.+)\/([a-z]*)$/m.exec(
        captureSource(),
    )
    if (!match) {
        throw new Error(
            'code-capture.js no longer declares `const SHOPPER_CODE_PATTERN = /…/` on one line — update this guard together with it',
        )
    }
    return new RegExp(match[1] as string, match[2])
}

/** The extension's looksLikeCardNumber, rebuilt from its source text. */
function mirroredCardShape(): (code: string) => boolean {
    const match =
        /^function looksLikeCardNumber\(code\) \{\n[\s\S]*?\n\}$/m.exec(
            captureSource(),
        )
    if (!match) {
        throw new Error(
            'code-capture.js no longer declares a self-contained `function looksLikeCardNumber(code) {…}` — update this guard together with it',
        )
    }
    return new Function(`${match[0]}\nreturn looksLikeCardNumber`)() as (
        code: string,
    ) => boolean
}

describe('code-capture.js mirrors SHOPPER_CODE_PATTERN (app <-> extension sync)', () => {
    it('is the same pattern, source and flags', () => {
        const mirror = mirroredPattern()
        expect(mirror.source).toBe(SHOPPER_CODE_PATTERN.source)
        expect(mirror.flags).toBe(SHOPPER_CODE_PATTERN.flags)
    })

    it('agrees on a sample of accepted and refused codes', () => {
        const mirror = mirroredPattern()
        const samples = [
            'SAVE10',
            'save-10_x',
            'a1b',
            'a'.repeat(40),
            'ab',
            '',
            'a b',
            '-ABC',
            '<script>',
            'a'.repeat(41),
        ]
        for (const sample of samples) {
            expect(mirror.test(sample), sample).toBe(
                SHOPPER_CODE_PATTERN.test(sample),
            )
        }
    })
})

describe('code-capture.js mirrors looksLikeCardNumber (app <-> extension sync)', () => {
    it('agrees on the boundaries of both card-shape rules', () => {
        const mirror = mirroredCardShape()
        const samples = [
            '',
            'SAVE10',
            'SAVE2024',
            '1234567',
            '12345678',
            '123456789012345',
            '4111111111111111',
            '4111-1111-1111-1111',
            'AB12-3456-7890-1234',
            'ABCD-123456789012',
            'ABCDE-12345678901',
            'A1-23456789012',
            'a'.repeat(40),
            '1'.repeat(40),
            '1'.repeat(7),
            'x' + '1'.repeat(11),
            'xxxx' + '1'.repeat(12),
            'xxxx' + '1'.repeat(11),
        ]
        for (const sample of samples) {
            expect(mirror(sample), sample).toBe(looksLikeCardNumber(sample))
        }
    })

    it('flags the card shapes the capture must refuse (guards the guard)', () => {
        const mirror = mirroredCardShape()
        expect(mirror('12345678')).toBe(true)
        expect(mirror('4111-1111-1111-1111')).toBe(true)
        expect(mirror('SAVE10')).toBe(false)
    })
})
