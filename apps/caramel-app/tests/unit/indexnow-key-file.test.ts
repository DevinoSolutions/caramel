import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
    INDEXNOW_KEY,
    INDEXNOW_KEY_PATH,
    indexNowKeyResponse,
} from '@/lib/seo/indexnow'

// CI pin for the IndexNow host-ownership proof.
//
// IndexNow accepts a submission only if the key it is handed is also readable
// at `https://<host>/<key>.txt`. The path is a LITERAL directory name under
// src/app, so nothing type-checks it against the constant: a rotation that
// edits one and not the other builds green and fails every submission at the
// search engine, far from the change that caused it. Hence this pin, which
// checks the directory on disk against the exported constant.

const APP_DIR = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../src/app',
)

/** IndexNow's stated constraint: 8-128 chars of [A-Za-z0-9-]. */
const INDEXNOW_KEY_SHAPE = /^[A-Za-z0-9-]{8,128}$/

/**
 * A key-file route, for spotting one left behind by a half-finished rotation.
 * Narrower than the protocol allows on purpose: our keys are generated as
 * lowercase hex (`randomBytes(16).toString('hex')`), so this cannot mistake a
 * named text route (llms.txt) for an abandoned key. A rotation to some other
 * alphabet must widen this.
 */
const KEY_FILE_ROUTE = /^[0-9a-f]{8,128}\.txt$/

describe('IndexNow key file (src/lib/seo/indexnow.ts)', () => {
    it('holds a key IndexNow will accept', () => {
        expect(INDEXNOW_KEY).toMatch(INDEXNOW_KEY_SHAPE)
    })

    it('derives the fetched path from the key', () => {
        expect(INDEXNOW_KEY_PATH).toBe(`/${INDEXNOW_KEY}.txt`)
    })

    it('routes the key file at exactly /<key>.txt, with no stale twin', () => {
        const textRoutes = fs
            .readdirSync(APP_DIR, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && entry.name.endsWith('.txt'))
            .map(entry => entry.name)

        expect(textRoutes).toContain(`${INDEXNOW_KEY}.txt`)
        expect(textRoutes.filter(name => KEY_FILE_ROUTE.test(name))).toEqual([
            `${INDEXNOW_KEY}.txt`,
        ])

        const handler = fs.readFileSync(
            path.join(APP_DIR, `${INDEXNOW_KEY}.txt`, 'route.ts'),
            'utf8',
        )
        expect(handler).toContain("from '@/lib/seo/indexnow'")
        expect(handler).toContain('indexNowKeyResponse()')
    })

    it('answers with the key as the whole body', async () => {
        const served = indexNowKeyResponse()

        expect(served.status).toBe(200)
        expect(served.headers.get('content-type')).toBe(
            'text/plain; charset=utf-8',
        )
        expect(served.headers.get('cache-control')).toBe(
            'public, max-age=86400',
        )
        // Verbatim: no trailing newline, no BOM, nothing to trim.
        await expect(served.text()).resolves.toBe(INDEXNOW_KEY)
    })
})
