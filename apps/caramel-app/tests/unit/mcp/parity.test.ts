import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

// MCP parity (owner rule: anything a signed-in user can do in Caramel, an
// agent can do over MCP). Every exported handler of every API route is either
// covered by a tool (its `covers` list) or recorded in NOT_EXPOSED with the
// reason. A new route fails this test until it is one or the other, and a
// stale entry (a route that no longer exists) fails it too.

vi.mock('@/lib/prisma', () => ({ default: {} }))

import { CARAMEL_TOOLS, NOT_EXPOSED } from '@/lib/mcp/tools/registry'

const APP_DIR = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../src/app',
)
const API_DIR = path.join(APP_DIR, 'api')
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

function routeFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) return routeFiles(full)
        return entry.name === 'route.ts' ? [full] : []
    })
}

/** "METHOD /api/..." for every handler the route module exports. */
function routeOperations(): string[] {
    return routeFiles(API_DIR).flatMap(file => {
        const source = fs.readFileSync(file, 'utf8')
        const route = `/api/${path
            .relative(API_DIR, path.dirname(file))
            .split(path.sep)
            .join('/')}`
        const exported = new Set<string>()
        for (const method of METHODS) {
            const direct = new RegExp(
                `export\\s+(?:const|async\\s+function|function)\\s+${method}\\b`,
            )
            const destructured = new RegExp(
                `export\\s+const\\s+\\{[^}]*\\b${method}\\b[^}]*\\}`,
            )
            if (direct.test(source) || destructured.test(source)) {
                exported.add(method)
            }
        }
        return [...exported].map(method => `${method} ${route}`)
    })
}

const covered = new Set(CARAMEL_TOOLS.flatMap(tool => tool.covers))
const pageRoot = path.join(APP_DIR)

describe('MCP parity: every API operation is a tool or a recorded exclusion', () => {
    const operations = routeOperations()

    it('finds the route tree', () => {
        expect(operations.length).toBeGreaterThan(40)
    })

    it('leaves no operation unaccounted for', () => {
        const missing = operations.filter(
            op => !covered.has(op) && !(op in NOT_EXPOSED),
        )
        expect(missing).toEqual([])
    })

    it('never both covers and excludes an operation', () => {
        expect(Object.keys(NOT_EXPOSED).filter(op => covered.has(op))).toEqual(
            [],
        )
    })

    it('records a reason for every exclusion', () => {
        for (const reason of Object.values(NOT_EXPOSED)) {
            expect(reason.trim().length).toBeGreaterThan(10)
        }
    })

    it('names only operations that exist', () => {
        const existing = new Set(operations)
        const stale = [...covered, ...Object.keys(NOT_EXPOSED)].filter(op => {
            if (op.startsWith('PAGE ')) {
                // A page a tool reproduces (e.g. the store coupon page).
                const segments = op.slice('PAGE '.length).split('/')
                return !fs.existsSync(
                    path.join(pageRoot, '(marketing)', ...segments, 'page.tsx'),
                )
            }
            return !existing.has(op)
        })
        expect(stale).toEqual([])
    })
})
