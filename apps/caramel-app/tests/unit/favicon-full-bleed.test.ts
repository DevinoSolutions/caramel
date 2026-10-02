import { metadata } from '@/app/layout'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

// Google search crops the favicon to a circle on a white disc. The original
// icons were a rounded orange square inside transparent padding, so search
// results showed a small boxed tile instead of a filled orange circle
// (2026-10-02). Two rules keep both surfaces right:
// - favicon.ico + the 192px PNG reach every edge (opaque edge midpoints, so
//   Google's circle is filled) but round their corners (transparent corner
//   pixels, so browser tabs show a rounded tile like the other Devino apps).
//   Rounding can never show inside Google's circle: any corner radius up to
//   half the side stays outside the inscribed circle.
// - The apple touch icon is a fully opaque square: iOS masks its own corners
//   and paints transparency black.
// Regenerate from public/square_caramel_logo.png (full-bleed 600px source)
// with a 20% corner radius, never from the padded logo.png / app/ios /
// app/android art.

const PUBLIC_DIR = path.resolve(__dirname, '../../public')
const PNG_SIGNATURE = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
])

type DecodedPng = {
    width: number
    height: number
    alphaAt: (x: number, y: number) => number
}

// Minimal decoder for what Pillow writes here: 8-bit, non-interlaced RGB
// (colour type 2) or RGBA (colour type 6).
function decodePng(png: Buffer): DecodedPng {
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true)
    let offset = 8
    let width = 0
    let height = 0
    let colorType = 0
    const idat: Buffer[] = []
    while (offset < png.length) {
        const length = png.readUInt32BE(offset)
        const type = png.toString('ascii', offset + 4, offset + 8)
        const data = png.subarray(offset + 8, offset + 8 + length)
        if (type === 'IHDR') {
            width = data.readUInt32BE(0)
            height = data.readUInt32BE(4)
            expect(data[8]).toBe(8)
            colorType = data[9]
            expect(data[12]).toBe(0)
        } else if (type === 'IDAT') {
            idat.push(data)
        }
        offset += 12 + length
    }
    expect([2, 6]).toContain(colorType)
    const channels = colorType === 6 ? 4 : 3
    const stride = width * channels
    const raw = inflateSync(Buffer.concat(idat))
    const pixels = Buffer.alloc(height * stride)
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)]
        for (let x = 0; x < stride; x++) {
            const value = raw[y * (stride + 1) + 1 + x]
            const left = x >= channels ? pixels[y * stride + x - channels] : 0
            const up = y > 0 ? pixels[(y - 1) * stride + x] : 0
            const upLeft =
                y > 0 && x >= channels
                    ? pixels[(y - 1) * stride + x - channels]
                    : 0
            let predictor = 0
            if (filter === 1) predictor = left
            else if (filter === 2) predictor = up
            else if (filter === 3) predictor = (left + up) >> 1
            else if (filter === 4) {
                const p = left + up - upLeft
                const pa = Math.abs(p - left)
                const pb = Math.abs(p - up)
                const pc = Math.abs(p - upLeft)
                predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
            }
            pixels[y * stride + x] = (value + predictor) & 0xff
        }
    }
    return {
        width,
        height,
        alphaAt: (x, y) =>
            channels === 4 ? pixels[y * stride + x * channels + 3] : 255,
    }
}

function readIcon(url: string): DecodedPng[] {
    const file = readFileSync(path.join(PUBLIC_DIR, url))
    if (!url.endsWith('.ico')) return [decodePng(file)]
    const count = file.readUInt16LE(4)
    return Array.from({ length: count }, (_, i) => {
        const entry = 6 + 16 * i
        const size = file.readUInt32LE(entry + 8)
        const offset = file.readUInt32LE(entry + 12)
        return decodePng(file.subarray(offset, offset + size))
    })
}

function declaredIconUrls(): { icon: string[]; apple: string[] } {
    const icons = metadata.icons
    if (
        !icons ||
        typeof icons !== 'object' ||
        Array.isArray(icons) ||
        icons instanceof URL
    ) {
        throw new Error('layout metadata.icons must be an object')
    }
    const urlsOf = (value: unknown): string[] =>
        (Array.isArray(value) ? value : [value]).map(item =>
            typeof item === 'string'
                ? item
                : String((item as { url: string | URL }).url),
        )
    return { icon: urlsOf(icons.icon), apple: urlsOf(icons.apple) }
}

describe('site icons fill their frame (no transparent padding)', () => {
    const { icon, apple } = declaredIconUrls()

    it('declares the favicon, a 48px-multiple PNG for search, and a touch icon', () => {
        expect(icon).toEqual(['/favicon.ico', '/icons/caramel-icon-192.png'])
        expect(apple).toEqual(['/icons/apple-touch-icon-180.png'])
    })

    it.each(icon)('%s reaches every edge and rounds its corners', url => {
        const frames = readIcon(url)
        expect(frames.length).toBeGreaterThan(0)
        for (const { width, height, alphaAt } of frames) {
            expect(width).toBe(height)
            const mid = Math.floor(width / 2)
            const last = width - 1
            for (const [x, y] of [
                [mid, 0],
                [mid, last],
                [0, mid],
                [last, mid],
            ]) {
                expect(alphaAt(x, y)).toBe(255)
            }
            for (const [x, y] of [
                [0, 0],
                [last, 0],
                [0, last],
                [last, last],
            ]) {
                // Mostly transparent: at 16px an anti-aliased arc may
                // legitimately graze the corner pixel.
                expect(alphaAt(x, y)).toBeLessThan(64)
            }
        }
    })

    it.each(apple)('%s is a fully opaque square', url => {
        for (const { width, height, alphaAt } of readIcon(url)) {
            expect(width).toBe(height)
            for (const [x, y] of [
                [0, 0],
                [width - 1, height - 1],
                [Math.floor(width / 2), 0],
            ]) {
                expect(alphaAt(x, y)).toBe(255)
            }
        }
    })
})
