// Enforces the three.js lazy-load boundary: `three` (and anything that
// imports it, i.e. couponTicket3d) may only be pulled in from the scene
// modules that are themselves loaded via next/dynamic ssr:false. If a
// statically-imported component (HeroSection, CouponVaultSection, page.tsx…)
// imports from either, the whole three/R3F stack lands in the home page's
// first-load JS (~+400 KB) and hydration slows enough to flake the
// navigation e2e suite in CI — which is exactly how this test came to exist.
// DOM shells that need the CSS notch mask import '@/lib/ticketMask' instead.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = path.join(__dirname, '..', '..', 'src')

// The only modules allowed to import `three` / `@react-three/*` /
// `./couponTicket3d`: the two dynamic scene chunks and the shared 3D helper
// they both consume.
const ALLOWED = new Set([
    'components/HeroTicketScene.tsx',
    'components/couponTicket3d.tsx',
])

const BANNED_IMPORT =
    /from\s+['"](three|@react-three\/[^'"]+|\.\/couponTicket3d)['"]/

function walk(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) return walk(full)
        return /\.(ts|tsx)$/.test(entry.name) ? [full] : []
    })
}

describe('three.js lazy-load boundary', () => {
    it('only the dynamic scene modules import three / couponTicket3d', () => {
        const offenders = walk(SRC)
            .map(file => ({
                rel: path.relative(SRC, file).replace(/\\/g, '/'),
                text: fs.readFileSync(file, 'utf8'),
            }))
            .filter(
                ({ rel, text }) =>
                    !ALLOWED.has(rel) && BANNED_IMPORT.test(text),
            )
            .map(({ rel }) => rel)

        expect(
            offenders,
            'these files import three (directly or via couponTicket3d) outside the dynamic scene chunks — use @/lib/ticketMask for the CSS mask, or load the module via next/dynamic ssr:false',
        ).toEqual([])
    })
})
