import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// A stray control byte in a source file is invisible and expensive.
//
// On 2026-08-06 a NUL landed inside a string literal in coupon-apply.js —
// `parts.join(' \0 ')`, where a separator was meant. Nothing broke: the value
// fed one lowercased includes() comparison and never reached the UI, the suite
// stayed green, and the file looked correct in every editor.
//
// What it cost was searchability. grep and ripgrep classify a file with a NUL
// as binary and skip it silently — so `grep -n applyViaDiscountLink *.js`
// reported the callers in coupon-runner.js and no definition anywhere, and the
// obvious reading of that is "the function doesn't exist". A file the repo's
// own tools refuse to open is the context hazard the house rules describe: the
// next session can't tell a file that has no matches from one that was never
// read.
//
// So: the shipped sources are text. Tab, newline and carriage return are text;
// the rest of C0 and the DEL byte are not. Scanning bytes rather than decoded
// characters is deliberate — this is a question about the file on disk.
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

// Everything the extension ships or is built from. dist/ is gitignored build
// output, node_modules isn't ours, and the report directories are test debris.
const SKIP_DIRS = new Set([
    'node_modules',
    'dist',
    '.git',
    'test-results',
    'playwright-report',
    'coverage',
])
const EXTENSIONS = ['.js', '.mjs', '.css', '.html', '.json', '.md']

// A predicate over bytes rather than a character class: a regex spelling this
// out would itself have to contain the control characters it forbids, which
// oxlint rejects (no-control-regex) and which would make this file the one
// place in the repo allowed to hold the thing it exists to ban.
//
// Text: tab (0x09), newline (0x0a), carriage return (0x0d), and everything from
// space (0x20) up. Not text: the rest of C0, and DEL (0x7f).
function isForbiddenByte(byte) {
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d) return false
    return byte < 0x20 || byte === 0x7f
}

function forbiddenOffsets(buffer) {
    const found = []
    for (let i = 0; i < buffer.length; i++) {
        if (isForbiddenByte(buffer[i])) found.push(i)
    }
    return found
}

function sourceFiles(dir = ROOT, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue
            sourceFiles(path.join(dir, entry.name), out)
        } else if (EXTENSIONS.includes(path.extname(entry.name))) {
            out.push(path.join(dir, entry.name))
        }
    }
    return out
}

// Byte offset → "line N, column M", so a failure points at the character
// instead of leaving the reader to count 12,376 bytes by hand.
function locate(buffer, offset) {
    const before = buffer.subarray(0, offset).toString('utf8')
    const line = before.split('\n').length
    const column = offset - (before.lastIndexOf('\n') + 1) + 1
    return `line ${line}, column ${column}`
}

describe('the sources this extension ships', () => {
    it('are plain text, so the tools that search this repo will open them', () => {
        const offenders = []
        for (const file of sourceFiles()) {
            const buffer = fs.readFileSync(file)
            for (const offset of forbiddenOffsets(buffer)) {
                offenders.push(
                    `${path.relative(ROOT, file)} — 0x${buffer[offset]
                        .toString(16)
                        .padStart(2, '0')} at ${locate(buffer, offset)}`,
                )
            }
        }

        expect(offenders).toEqual([])
    })

    it('finds the byte when there is one, rather than passing on an empty scan', () => {
        // Guards the guard: a walker that silently returned nothing would make
        // the assertion above pass forever. This proves the scan reads real
        // bytes and reports a usable position.
        const buffer = Buffer.from('const separator = " \0 "\n', 'utf8')
        const hit = forbiddenOffsets(buffer)

        expect(hit).toHaveLength(1)
        expect(locate(buffer, hit[0])).toBe('line 1, column 21')
    })

    it('reads every content script the manifest injects', () => {
        // The scan is only worth anything if it covers the files that matter;
        // a bad SKIP_DIRS entry or extension list would quietly shrink it.
        const scanned = new Set(
            sourceFiles().map(f => path.relative(ROOT, f).replace(/\\/g, '/')),
        )
        const manifest = JSON.parse(
            fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'),
        )
        const injected = manifest.content_scripts.flatMap(cs => cs.js ?? [])

        expect(injected.length).toBeGreaterThan(0)
        for (const file of injected) expect(scanned.has(file)).toBe(true)
    })
})
