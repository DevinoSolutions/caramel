import { expect, test } from '@playwright/test'

// SEO regression gate — everything here reads the RAW server HTML via
// page.request.get (no JS execution), so it asserts exactly what a crawler
// gets on first byte. Motivation: one `ssr:false` wrapper or a stray
// useSearchParams outside Suspense silently collapses every route back to
// the ~50-char CSR shell the 2026-07 SEO restoration just fixed — and no
// DOM-based test notices, because the client still renders fine.
//
// Deployment-safe by design (docs/testing.md "E2E runs in TWO contexts"):
// nothing below asserts SPECIFIC DB rows, so every test stays UNGATED and
// runs against both the hermetic e2e-pr server and the deployed dev site.
// The two pages that server-render catalog reads (/supported-stores,
// /sources) are covered only through visible-text minimums calibrated to
// hold with ANY non-empty catalog — and the catalog is never legitimately
// empty in either context (see pages.spec.ts crawler-view tests, which this
// file extends rather than duplicates: those pin page-specific copy, this
// one pins the structural SEO contract across the whole route set).
//
// Visible-text minimums are MEASURED values minus ~30% slack, not invented.
// Calibration 2026-07-28 against (a) a local production build
// (`next build` + `next start`, seeded catalog) and (b) the deployed
// https://dev.grabcaramel.com (real catalog) — both contexts agreed within
// a few chars:
//   /                  8884 / 8884   -> min 6000
//   /coupons            874 /  874   -> min  600
//   /supported-stores   469 /  469   -> min  320
//   /pricing           1453 / 1453   -> min 1000
//   /sources            499 /  499   -> min  350
//   /privacy           2780 / 2784   -> min 1900
// (/coupons is thin on purpose: the card grid is a client fetch; its server
// HTML carries the shell copy + sidebar. If a route legitimately gains or
// loses big copy, re-measure with the snippet in the PR that added this file
// and update the number — never delete the assertion.)
const ROUTES: ReadonlyArray<{ path: string; minVisibleChars: number }> = [
    { path: '/', minVisibleChars: 6000 },
    { path: '/coupons', minVisibleChars: 600 },
    { path: '/supported-stores', minVisibleChars: 320 },
    { path: '/pricing', minVisibleChars: 1000 },
    { path: '/sources', minVisibleChars: 350 },
    { path: '/privacy', minVisibleChars: 1900 },
]

// Same production-origin set as src/app/robots.ts (and next.config.mjs's
// X-Robots-Tag header) — keep the three in sync. Only these origins serve
// the allow-branch robots.txt; every other BASE_URL is a staging/preview
// deploy that must stay deindexed.
const PRODUCTION_ORIGINS = new Set([
    'https://grabcaramel.com',
    'https://www.grabcaramel.com',
])

// Crude but dependency-free: what a text-only crawler would extract. Strips
// non-content elements, then tags, then entities. Matches the calibration
// snippet exactly — thresholds are only meaningful against this function.
function visibleTextLength(html: string): number {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<template[\s\S]*?<\/template>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&[a-z#0-9]+;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim().length
}

// Raw <script type="application/ld+json"> payloads. Deliberately NOT a
// count of the string "application/ld+json" in the page — the RSC flight
// payload echoes it and inflates naive counts.
function extractJsonLdBlocks(html: string): string[] {
    // exec loop instead of matchAll: this tsconfig's target predates
    // downlevelIteration, so spreading a RegExpStringIterator is TS2802.
    const pattern =
        /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g
    const blocks: string[] = []
    let match = pattern.exec(html)
    while (match !== null) {
        blocks.push(match[1])
        match = pattern.exec(html)
    }
    return blocks
}

function metaContent(html: string, name: string): string | undefined {
    // Next.js renders metadata as `<meta name="..." content="..."/>` /
    // `<meta property="..." content="..."/>` in that attribute order.
    return new RegExp(
        `<meta (?:name|property)="${name}" content="([^"]*)"`,
    ).exec(html)?.[1]
}

function stripTrailingSlash(url: string): string {
    return url.replace(/\/+$/, '')
}

test.describe('SEO regression gate (raw server HTML)', () => {
    for (const { path: routePath, minVisibleChars } of ROUTES) {
        // Title avoids "/" — the failure-artifact path derives from the test
        // title, and a slash splits it into directories ("...contract: " with
        // a trailing space is an invalid dir name on Windows).
        const routeLabel = routePath === '/' ? 'home' : routePath.slice(1)
        test(`crawler HTML contract: ${routeLabel}`, async ({ page }) => {
            const res = await page.request.get(routePath)
            expect(res.ok(), `${routePath} must return 2xx`).toBe(true)
            const html = await res.text()

            // THE load-bearing assertion: server HTML carries real content.
            // A CSR-shell regression (ssr:false wrapper, useSearchParams
            // outside Suspense) drops this to well under 100 chars.
            const textLen = visibleTextLength(html)
            expect(
                textLen,
                `${routePath} server HTML visible text collapsed to ${textLen} chars ` +
                    `(min ${minVisibleChars}; calibrated values in this file's header) — ` +
                    `this is the CSR-empty-shell regression the SEO restoration fixed`,
            ).toBeGreaterThanOrEqual(minVisibleChars)

            // Exactly one <h1> per page.
            const h1Count = (html.match(/<h1[\s>]/gi) ?? []).length
            expect(
                h1Count,
                `${routePath} must have exactly one <h1>, found ${h1Count}`,
            ).toBe(1)

            // Title: present and non-generic (branded).
            const title = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? ''
            expect(
                title.length,
                `${routePath} <title> too short/missing`,
            ).toBeGreaterThan(15)
            expect(title, `${routePath} <title> must be branded`).toMatch(
                /caramel/i,
            )

            // Meta description present and substantive.
            const description = metaContent(html, 'description') ?? ''
            expect(
                description.length,
                `${routePath} meta description missing or too short`,
            ).toBeGreaterThanOrEqual(50)

            // Canonical present and absolute. (Home/sources resolve against
            // metadataBase, the rest hardcode the prod origin — both render
            // as absolute URLs in the HTML.)
            const canonical = /<link rel="canonical" href="([^"]*)"/.exec(
                html,
            )?.[1]
            expect(
                canonical,
                `${routePath} canonical link missing`,
            ).toBeTruthy()
            expect(
                canonical,
                `${routePath} canonical must be an absolute URL, got "${canonical}"`,
            ).toMatch(/^https?:\/\//)

            // OG basics + twitter card — every route in the set declares
            // them today (home inherits OG from the root layout; Next
            // derives its twitter card from OG).
            expect(
                metaContent(html, 'og:title'),
                `${routePath} og:title missing`,
            ).toBeTruthy()
            expect(
                metaContent(html, 'og:image'),
                `${routePath} og:image missing`,
            ).toBeTruthy()
            expect(
                metaContent(html, 'twitter:card'),
                `${routePath} twitter:card missing`,
            ).toBe('summary_large_image')

            // Structured data: at least the site-wide entity graph, every
            // block valid JSON, and — claim-integrity rule, extending the
            // home.spec.ts DOM guard to raw HTML on ALL routes — never any
            // invented social proof (aggregateRating / Review markup).
            const jsonLdBlocks = extractJsonLdBlocks(html)
            expect(
                jsonLdBlocks.length,
                `${routePath} must ship at least one JSON-LD block`,
            ).toBeGreaterThanOrEqual(1)
            for (const block of jsonLdBlocks) {
                const parsed: unknown = JSON.parse(block) // throws = red
                expect(
                    JSON.stringify(parsed),
                    `${routePath} JSON-LD must not contain Review-type markup`,
                ).not.toMatch(/"@type"\s*:\s*"[A-Za-z]*Review/)
            }
            expect(
                /aggregateRating/i.test(html),
                `${routePath} HTML must never contain aggregateRating (no invented social proof)`,
            ).toBe(false)
        })
    }

    test('titles are unique across the public route set', async ({ page }) => {
        const titles = new Map<string, string>()
        for (const { path: routePath } of ROUTES) {
            const html = await (await page.request.get(routePath)).text()
            const title = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? ''
            const clash = titles.get(title)
            expect(
                clash,
                `duplicate <title> "${title}" on ${routePath} and ${clash}`,
            ).toBeUndefined()
            titles.set(title, routePath)
        }
    })

    test('home raw HTML ships FAQPage + entity JSON-LD (crawler view)', async ({
        page,
    }) => {
        // home.spec.ts asserts these blocks exist in the hydrated DOM; this
        // pins them in the RAW HTML, which is what answer engines ingest.
        const html = await (await page.request.get('/')).text()
        const types = extractJsonLdBlocks(html)
            .map(block => JSON.stringify(JSON.parse(block)))
            .join(' ')
        expect(types).toContain('"@type":"FAQPage"')
        expect(types).toContain('"@type":"Organization"')
        expect(types).toContain('"@type":"SoftwareApplication"')
    })

    test('robots.txt honours the env-aware indexing contract', async ({
        baseURL,
        page,
    }) => {
        const res = await page.request.get('/robots.txt')
        expect(res.ok()).toBe(true)
        const body = await res.text()

        const origin = stripTrailingSlash(baseURL ?? '')
        if (PRODUCTION_ORIGINS.has(origin)) {
            // Prod-allow branch is deliberately NOT asserted here: CI runs
            // this suite against localhost and dev.grabcaramel.com (both
            // non-prod), and a main-push run against prod can race the
            // deploy. Both robots() branches are pinned at unit level in
            // tests/unit/robots-env-contract.test.ts.
            expect(body.trim().length).toBeGreaterThan(0)
            return
        }

        // Non-production origin (hermetic localhost AND deployed dev):
        // blanket disallow, no Allow, and no sitemap line — a staging deploy
        // must never invite indexing or leak a sitemap into the index.
        expect(body).toMatch(/User-Agent: \*/i)
        expect(body, 'non-prod robots.txt must blanket-disallow').toMatch(
            /^Disallow: \/$/m,
        )
        expect(body, 'non-prod robots.txt must not allow anything').not.toMatch(
            /^Allow:/im,
        )
        expect(
            body,
            'non-prod robots.txt must not advertise a sitemap',
        ).not.toMatch(/^Sitemap:/im)
    })

    test('sitemap.xml is well-formed and lists every static route', async ({
        baseURL,
        page,
    }) => {
        const res = await page.request.get('/sitemap.xml')
        expect(res.ok()).toBe(true)
        expect(res.headers()['content-type']).toContain('xml')
        const xml = await res.text()

        // Well-formedness without an XML-parser dependency: prologue,
        // urlset envelope, and balanced url/loc tags. Enough to catch a
        // truncated or exception-interrupted render.
        expect(xml).toMatch(/^<\?xml version="1\.0"/)
        expect(xml).toContain('<urlset')
        expect(xml.trimEnd()).toMatch(/<\/urlset>\s*$/)
        expect((xml.match(/<url>/g) ?? []).length).toBe(
            (xml.match(/<\/url>/g) ?? []).length,
        )
        expect((xml.match(/<loc>/g) ?? []).length).toBe(
            (xml.match(/<\/loc>/g) ?? []).length,
        )

        // The 6 static marketing routes, emitted against the deployment's
        // own origin (sitemap.ts builds each <loc> from BASE_URL, which
        // matches the origin this suite targets in all CI contexts).
        const origin = stripTrailingSlash(baseURL ?? '')
        for (const { path: routePath } of ROUTES) {
            const loc = `<loc>${origin}${routePath}</loc>`
            expect(xml, `sitemap.xml missing ${loc}`).toContain(loc)
        }
    })

    test('llms.txt is served for answer engines', async ({ page }) => {
        const res = await page.request.get('/llms.txt')
        expect(res.ok()).toBe(true)
        expect(res.headers()['content-type']).toContain('text/plain')
        const body = await res.text()
        expect(body).toContain('Caramel')
    })
})
