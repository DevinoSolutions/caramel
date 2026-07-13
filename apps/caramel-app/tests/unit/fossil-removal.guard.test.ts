import { nextApiResponse } from '@/lib/apiResponseNext'
import * as gtag from '@/lib/gtag'
import { decryptJsonData } from '@/lib/securityHelpers/decryptJsonData'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// F-009 pin — deletion of the 6 dead Pages-Router fossils (cors.ts,
// initMiddleware.ts, middlewares/{withAuth,withRoles,errorMiddleware}.ts,
// securityHelpers/apiResponse.ts). knip.json's `ignore` list whitelisted
// exactly these paths, which is itself proof they're unused (zero live
// callers, verified by grep + file reads before this change landed).
//
// Written BEFORE the deletion (F-009 plan step 1), so the "is deleted"
// cases below are a real red->green pin, not a tautology: they fail on the
// pre-change tree (files still exist) and only pass once step 2 deletes
// them. The KEEP-live sibling checks are the other half of the pin — they
// prove the deletion didn't collateral-nuke a live neighbor that merely
// looks similar (adversarial review corrected the original fossil set to
// exclude apiResponseNext.ts, which app/api/sources/route.ts imports live).

const srcDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../src',
)

describe('fossil-removal (F-009): KEEP-live siblings still import-resolve', () => {
    it('(a) @/lib/apiResponseNext -> nextApiResponse (live: app/api/sources/route.ts)', () => {
        expect(typeof nextApiResponse).toBe('function')
    })

    it('(b) @/lib/securityHelpers/decryptJsonData -> decryptJsonData (live, via cryptoHelpers.ts)', () => {
        expect(typeof decryptJsonData).toBe('function')
    })

    it('(c) @/lib/gtag -> namespace import (live: app/providers.tsx)', () => {
        expect(typeof gtag.pageView).toBe('function')
        expect(typeof gtag.event).toBe('function')
    })
})

describe('fossil-removal (F-009): the 6 dead files are deleted', () => {
    it.each([
        'lib/cors.ts',
        'lib/initMiddleware.ts',
        'lib/middlewares/withAuth.ts',
        'lib/middlewares/withRoles.ts',
        'lib/middlewares/errorMiddleware.ts',
        'lib/securityHelpers/apiResponse.ts',
    ])('%s no longer exists', relPath => {
        expect(fs.existsSync(path.join(srcDir, relPath))).toBe(false)
    })

    it('the now-empty middlewares/ directory is gone too', () => {
        expect(fs.existsSync(path.join(srcDir, 'lib/middlewares'))).toBe(false)
    })
})
