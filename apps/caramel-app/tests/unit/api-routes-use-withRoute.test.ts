import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Route-pipeline inventory gate (DESIGN.md §1 "16 of 18 route.ts files use
// [withRoute]") — "rules become checks". Every API handler must declare
// itself through src/lib/api/withRoute.ts (CORS/origin/bearer/rate-limit/
// zod-body/OPTIONS + one handleRouteError → Sentry exit). A new route added
// without it silently loses all of that; this gate turns that regression red.
//
// EXACTLY two handlers are allowlisted, each a documented standoff:
//   - auth/[...all]/route.ts — better-auth's own catch-all (toNextJsHandler),
//     not ours to wrap (DESIGN.md §1).
//   - health/db/route.ts     — the monitoring contract (DESIGN.md §2(d)): its
//     own Bearer check, no rate-limit/CORS, so the external Uptime-Kuma poll
//     is never throttled.

const REPO_ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../..',
)
const API_DIR = path.join(REPO_ROOT, 'apps/caramel-app/src/app/api')

const ALLOWLISTED_ROUTES = new Set([
    'auth/[...all]/route.ts',
    'health/db/route.ts',
    // T-7852: the handoff POST needs a CUSTOM bearer-only check that strips
    // cookies (a cookie-only request from a web page must 401 — CSRF safety);
    // withRoute's `auth: 'session'` accepts both bearer and cookie. The
    // redeem GET is a document navigation that accepts no auth at all: it
    // consumes a one-time code and sets a cookie via 303.
    'app/web-session/handoff/route.ts',
    'app/web-session/redeem/route.ts',
])

function findRouteFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) return []
    const found: string[] = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            found.push(...findRouteFiles(full))
        } else if (entry.name === 'route.ts') {
            found.push(full)
        }
    }
    return found
}

/** API-dir-relative, forward-slashed (stable across Windows/POSIX). */
function apiRelative(file: string): string {
    return path.relative(API_DIR, file).split(path.sep).join('/')
}

// A handler "declares itself through withRoute" when it BOTH imports the
// module and calls it — matching how every real route uses it
// (`export const GET = withRoute({...}, handler)`). Requiring both the import
// and the call keeps a stray mention in a comment from satisfying the gate.
function routeDeclaresWithRoute(content: string): boolean {
    const importsWithRoute = /from\s+['"]@\/lib\/api\/withRoute['"]/.test(
        content,
    )
    const callsWithRoute = /\bwithRoute\s*\(/.test(content)
    return importsWithRoute && callsWithRoute
}

describe('api-routes-use-withRoute (DESIGN §1 route pipeline)', () => {
    it('every API route declares itself through withRoute (except the 4 documented standoffs)', () => {
        const files = findRouteFiles(API_DIR)
        expect(files.length).toBeGreaterThan(0) // sanity: the walk found routes

        const offenders = files
            .filter(file => !ALLOWLISTED_ROUTES.has(apiRelative(file)))
            .filter(
                file => !routeDeclaresWithRoute(fs.readFileSync(file, 'utf8')),
            )
            .map(apiRelative)
        expect(offenders).toEqual([])
    })

    it('the 4 allowlisted standoffs exist and genuinely skip withRoute', () => {
        // Guards the allowlist against rot: if a standoff is deleted or later
        // adopts withRoute, this fails so the entry is revisited deliberately
        // rather than silently exempting a route that no longer needs it.
        for (const rel of Array.from(ALLOWLISTED_ROUTES)) {
            const file = path.join(API_DIR, ...rel.split('/'))
            expect(fs.existsSync(file), `${rel} missing`).toBe(true)
            expect(
                routeDeclaresWithRoute(fs.readFileSync(file, 'utf8')),
                `${rel} unexpectedly uses withRoute — retire its allowlist entry`,
            ).toBe(false)
        }
    })

    it('the gate flags a new route that skips withRoute (red-proof)', () => {
        const rawHandler = [
            "import { NextResponse } from 'next/server'",
            'export async function GET() {',
            '  return NextResponse.json({ ok: true })',
            '}',
        ].join('\n')
        expect(routeDeclaresWithRoute(rawHandler)).toBe(false)

        const wrapped = [
            "import { withRoute } from '@/lib/api/withRoute'",
            "export const GET = withRoute({ method: 'GET', routeName: 'x' }, async () => {})",
        ].join('\n')
        expect(routeDeclaresWithRoute(wrapped)).toBe(true)

        // A bare mention in a comment must NOT satisfy the gate.
        const commentOnly =
            '// this route intentionally avoids withRoute\nexport function GET() {}'
        expect(routeDeclaresWithRoute(commentOnly)).toBe(false)
    })
})
