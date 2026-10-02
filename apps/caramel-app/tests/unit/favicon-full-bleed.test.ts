import { metadata } from '@/app/layout'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Google search crops the favicon to a circle on a white disc. The old icons
// were a rounded orange square with transparent padding, so search results
// showed a small boxed tile instead of a filled orange circle (2026-10-02).
// Every declared icon is now opaque RGB, orange to every edge: no alpha
// channel means no transparent padding can creep back in. Regenerate from
// public/square_caramel_logo.png (full-bleed 600px source), never from the
// padded logo.png / app/ios / app/android art.

const PUBLIC_DIR = path.resolve(__dirname, '../../public')
const PNG_SIGNATURE = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
])
const PNG_COLOR_TYPE_RGB = 2

type PngHeader = { width: number; height: number; colorType: number }

function readPngHeader(png: Buffer): PngHeader {
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true)
    return {
        width: png.readUInt32BE(16),
        height: png.readUInt32BE(20),
        colorType: png[25],
    }
}

function readIcoEntries(ico: Buffer): PngHeader[] {
    const count = ico.readUInt16LE(4)
    return Array.from({ length: count }, (_, i) => {
        const entry = 6 + 16 * i
        const size = ico.readUInt32LE(entry + 8)
        const offset = ico.readUInt32LE(entry + 12)
        return readPngHeader(ico.subarray(offset, offset + size))
    })
}

function declaredIconUrls(): string[] {
    const icons = metadata.icons
    if (
        !icons ||
        typeof icons !== 'object' ||
        Array.isArray(icons) ||
        icons instanceof URL
    ) {
        throw new Error('layout metadata.icons must be an object')
    }
    const urls: string[] = []
    for (const value of [icons.icon, icons.apple]) {
        for (const item of Array.isArray(value) ? value : [value]) {
            if (typeof item === 'string') urls.push(item)
            else if (item && 'url' in item) urls.push(String(item.url))
        }
    }
    return urls
}

describe('site icons are full-bleed (no transparent padding)', () => {
    const urls = declaredIconUrls()

    it('declares the favicon, a 48px-multiple PNG for search, and a touch icon', () => {
        expect(urls).toEqual([
            '/favicon.ico',
            '/icons/caramel-icon-192.png',
            '/icons/apple-touch-icon-180.png',
        ])
    })

    it.each(urls)('%s is square opaque RGB', url => {
        const file = readFileSync(path.join(PUBLIC_DIR, url))
        const headers = url.endsWith('.ico')
            ? readIcoEntries(file)
            : [readPngHeader(file)]
        expect(headers.length).toBeGreaterThan(0)
        for (const header of headers) {
            expect(header.width).toBe(header.height)
            expect(header.colorType).toBe(PNG_COLOR_TYPE_RGB)
        }
    })
})
