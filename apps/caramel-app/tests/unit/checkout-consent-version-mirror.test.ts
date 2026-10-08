import { MIN_CHECKOUT_CONSENT_PROMPT_VERSION } from '@/lib/shopperCoupons'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The extension has no bundler and cannot be imported here, so the consent
// prompt version lives in two places: CODE_SHARING_PROMPT_VERSION in
// apps/caramel-extension/code-sharing-consent.js (what the extension stamps into
// the record and sends as proof) and MIN_CHECKOUT_CONSENT_PROMPT_VERSION in
// src/lib/shopperCoupons.ts (the floor POST /api/coupons/submit enforces).
// This is the drift guard, same idea as shopper-code-pattern-mirror.test.ts: it
// reads the extension's constant out of its source text. Red means the server
// floor moved above what the extension sends (every opted-in shopper would be
// refused with 403 consent-required) or the extension constant is no longer
// declared in the shape this guard reads.

const CONSENT_PATH = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../caramel-extension/code-sharing-consent.js',
)

function extensionPromptVersion(): number {
    const match = /^const CODE_SHARING_PROMPT_VERSION = (\d+)$/m.exec(
        fs.readFileSync(CONSENT_PATH, 'utf8'),
    )
    if (!match) {
        throw new Error(
            'code-sharing-consent.js no longer declares `const CODE_SHARING_PROMPT_VERSION = <int>` on one line; update this guard together with it',
        )
    }
    return Number(match[1])
}

describe('checkout consent prompt version: extension vs server floor', () => {
    it('the server floor never exceeds the version the extension sends', () => {
        expect(MIN_CHECKOUT_CONSENT_PROMPT_VERSION).toBeLessThanOrEqual(
            extensionPromptVersion(),
        )
    })

    it('the server floor is a positive integer', () => {
        expect(Number.isInteger(MIN_CHECKOUT_CONSENT_PROMPT_VERSION)).toBe(true)
        expect(MIN_CHECKOUT_CONSENT_PROMPT_VERSION).toBeGreaterThanOrEqual(1)
    })
})
