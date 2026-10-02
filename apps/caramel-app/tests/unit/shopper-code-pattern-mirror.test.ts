import { SHOPPER_CODE_PATTERN } from '@/lib/shopperCoupons'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The extension has no bundler and cannot import src/lib/shopperCoupons.ts, so
// apps/caramel-extension/code-capture.js carries a MIRROR of
// SHOPPER_CODE_PATTERN (the server re-validates; the mirror only stops the
// extension sending strings the server is certain to refuse). This is the
// drift guard, same idea as coupon-constants.generated.test.ts: it reads the
// literal out of the extension source and requires it to equal the app's
// pattern exactly. Red means one side changed without the other.

const CAPTURE_PATH = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../caramel-extension/code-capture.js',
)

function mirroredPattern(): RegExp {
    const src = fs.readFileSync(CAPTURE_PATH, 'utf8')
    const match = /^const SHOPPER_CODE_PATTERN = \/(.+)\/([a-z]*)$/m.exec(src)
    if (!match) {
        throw new Error(
            'code-capture.js no longer declares `const SHOPPER_CODE_PATTERN = /…/` on one line — update this guard together with it',
        )
    }
    return new RegExp(match[1] as string, match[2])
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
