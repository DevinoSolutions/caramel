import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * providers.tsx keeps a hand-written list of routes that must NOT be wrapped in
 * the marketing Layout. The (auth) group renders its own full-screen shell, so
 * a route missing from that list gets both: two headers, two theme toggles, and
 * a site footer underneath the sign-in form.
 *
 * That is not hypothetical — /forgot-password and /reset-password were added on
 * 2026-08-09 and shipped exactly that way until an e2e snapshot showed the
 * marketing banner above the form. A hand-maintained list next to a filesystem
 * router will drift again, so this derives the truth from the directory.
 */

const appDir = path.resolve(__dirname, '../../src/app')
const authDir = path.join(appDir, '(auth)')
const providersFile = path.join(appDir, 'providers.tsx')

function authRoutes(): string[] {
    return fs
        .readdirSync(authDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .filter(entry =>
            ['page.tsx', 'page.ts'].some(file =>
                fs.existsSync(path.join(authDir, entry.name, file)),
            ),
        )
        .map(entry => `/${entry.name}`)
}

function declaredLayoutlessRoutes(): string[] {
    const source = fs.readFileSync(providersFile, 'utf8')
    const match = source.match(
        /const pagesLayoutless = useMemo\(\s*\(\)\s*=>\s*\[([\s\S]*?)\]/,
    )
    if (!match) {
        throw new Error(
            'Could not find the pagesLayoutless array in providers.tsx — update this test if it was renamed.',
        )
    }
    // exec loop rather than [...matchAll]: this package's tsc target does not
    // allow iterating a RegExpStringIterator (TS2802).
    const routes: string[] = []
    const pattern = /'([^']+)'/g
    let entry: RegExpExecArray | null
    while ((entry = pattern.exec(match[1])) !== null) {
        routes.push(entry[1])
    }
    return routes
}

describe('auth route group is layoutless', () => {
    it('finds the auth routes on disk', () => {
        // Guards the guard: a glob that silently matches nothing would make
        // every assertion below vacuously true.
        expect(authRoutes().length).toBeGreaterThanOrEqual(5)
    })

    it('lists every (auth) route in pagesLayoutless', () => {
        const declared = declaredLayoutlessRoutes()
        const missing = authRoutes().filter(route => !declared.includes(route))
        expect(missing).toEqual([])
    })

    it('does not list routes that no longer exist', () => {
        const routes = authRoutes()
        const stale = declaredLayoutlessRoutes().filter(
            route => !routes.includes(route),
        )
        expect(stale).toEqual([])
    })
})
