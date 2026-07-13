import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { renderCouponConstants } from '../../scripts/generate-coupon-constants'

// F-006 (plan step 6) — the extension has no bundler and cannot `import`
// src/lib/coupons.ts, so its copy of the coupon status vocabulary is a
// COMMITTED generated file (apps/caramel-extension/coupon-constants.generated.js).
// This test is the drift guard: it regenerates the content IN-MEMORY (same
// renderCouponConstants() the codegen script calls) and diffs it against
// the committed bytes on disk. Red means someone edited src/lib/coupons.ts
// (or hand-edited the generated file) without running
// `pnpm generate:coupon-constants` — exactly the app<->extension drift
// F-006 exists to prevent.
//
// Byte-equality only works because the generator emits prettier-FORMATTED
// output (the fixed point of the repo's prettier config): husky's
// lint-staged runs root-level `prettier --write` over every staged file at
// commit time, so anything less than prettier's own formatting gets
// rewritten mid-commit and this comparison could never hold at HEAD (the
// first committed version of the generated file hit exactly that).

const GENERATED_PATH = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../caramel-extension/coupon-constants.generated.js',
)

describe('coupon-constants.generated.js (F-006 app<->extension sync)', () => {
    it('the committed file is byte-identical to what renderCouponConstants() emits right now', async () => {
        const committed = fs.readFileSync(GENERATED_PATH, 'utf8')
        expect(committed).toBe(await renderCouponConstants())
    })

    it('sets window.CaramelCoupons with the 4 expected keys (sanity: the generator did not silently emit an empty/malformed payload)', async () => {
        const rendered = await renderCouponConstants()
        expect(rendered).toContain('window.CaramelCoupons = {')
        // Keys are unquoted in the emitted file: prettier's default
        // quoteProps ("as-needed") strips quotes from identifier-safe keys.
        expect(rendered).toContain('STATUSES: [')
        expect(rendered).toContain('VISIBLE_STATUSES: [')
        expect(rendered).toContain('RESTRICTED_STATUSES: [')
        expect(rendered).toContain('STATUS_META: {')
    })
})
