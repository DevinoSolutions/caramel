import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// No "go to the app" dead ends (owner rule: anything a signed-in user can do
// in Caramel, an agent can do over MCP). Every sentence an agent reads, from
// the server instructions to a tool description or a refusal, names a tool
// that does the thing instead of sending the user somewhere else. Agent-facing
// text also never carries a URL inside a refusal, and always writes the
// product name as "Caramel".

vi.mock('@/lib/prisma', () => ({ default: {} }))

import { MCP_PRODUCT_INSTRUCTIONS, registeredTools } from '@/lib/mcp/server'

const BANNED = [
    /in the (app|dashboard|ui|web app|website|extension settings)\b/i,
    /via the (ui|dashboard|website)/i,
    /not available (via|through) (the )?mcp/i,
    /requires the app/i,
    /cannot be done/i,
    /must be (done|created|edited) (by|in)/i,
    /only from a signed-in session/i,
    /go to (the )?(app|dashboard|settings|website|profile)\b/i,
    /visit (the )?(app|website|dashboard)\b/i,
    /fall back to the web app/i,
]

const ROOT = process.cwd()
const DIRS = ['src/lib/mcp']
const FILES = ['src/app/api/mcp/route.ts']

function walk(dir: string): string[] {
    if (!existsSync(join(ROOT, dir))) return []
    return readdirSync(join(ROOT, dir)).flatMap(name => {
        const rel = join(dir, name)
        return statSync(join(ROOT, rel)).isDirectory() ? walk(rel) : [rel]
    })
}

const scanned = [...DIRS.flatMap(walk), ...FILES].filter(file =>
    /\.(ts|tsx|md)$/.test(file),
)

describe('agent-facing text has no go-to-the-app phrasing', () => {
    it('scans the MCP sources (guards against a path typo)', () => {
        expect(scanned.length).toBeGreaterThan(15)
    })

    it.each(scanned)('%s', file => {
        const text = readFileSync(join(ROOT, file), 'utf8')
        for (const re of BANNED) {
            expect(text, `${file} matches ${re}`).not.toMatch(re)
        }
    })

    it('tool titles and descriptions write the product name as Caramel', () => {
        for (const tool of registeredTools()) {
            for (const text of [tool.title, tool.description]) {
                expect(text, tool.id).not.toMatch(/\bcaramel\b(?!:)/)
                expect(text, tool.id).not.toMatch(/https?:\/\//)
            }
        }
        expect(MCP_PRODUCT_INSTRUCTIONS).not.toMatch(/\bcaramel\b(?!:)/)
    })

    it('every tool description says what it does in a sentence', () => {
        for (const tool of registeredTools()) {
            expect(tool.description.length, tool.id).toBeGreaterThan(30)
            expect(tool.title, tool.id).toMatch(
                /^[A-Z][A-Za-z]*( [A-Z][A-Za-z]*)*$/,
            )
        }
    })
})
