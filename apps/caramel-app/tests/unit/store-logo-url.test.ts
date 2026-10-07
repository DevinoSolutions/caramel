import { storeLogoUrl } from '@/lib/storeLogo'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Store logos come from ONE helper (src/lib/storeLogo.ts). Before 2026-10-02
// four components each built the Google favicon URL inline; this gate keeps
// the raw URL from coming back anywhere else in src/.

const APP_SRC_DIR = path.resolve(__dirname, '../../src')
const RAW_FAVICON_SERVICE = 'google.com/s2/favicons'
const HELPER = path.join(APP_SRC_DIR, 'lib', 'storeLogo.ts')

function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) return sourceFiles(full)
        return /\.(ts|tsx)$/.test(entry.name) ? [full] : []
    })
}

describe('storeLogoUrl', () => {
    it('builds the 128px Google favicon URL with the domain encoded', () => {
        expect(storeLogoUrl('gapcanada.ca')).toBe(
            'https://www.google.com/s2/favicons?sz=128&domain_url=gapcanada.ca',
        )
        expect(storeLogoUrl('a b&c')).toBe(
            'https://www.google.com/s2/favicons?sz=128&domain_url=a%20b%26c',
        )
    })

    it('is the only place in src/ that builds a favicon-service URL', () => {
        const offenders = sourceFiles(APP_SRC_DIR).filter(
            file =>
                file !== HELPER &&
                fs.readFileSync(file, 'utf8').includes(RAW_FAVICON_SERVICE),
        )
        expect(offenders.map(f => path.relative(APP_SRC_DIR, f))).toEqual([])
    })
})
