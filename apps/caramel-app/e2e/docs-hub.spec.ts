import { expect, test } from '@playwright/test'

// /docs — the documentation hub (T-7855). A fleet SEO/AEO probe found
// https://grabcaramel.com/docs returning 404, and docs.grabcaramel.com is
// expected to land on it (301 in src/middleware.ts; DNS and a Dokploy domain
// carry the host to the app). This spec fails CI when either stops answering
// 200.
//
// Deployment-safe (docs/testing.md two-context rule): nothing here touches
// the DB, so the page tests run in BOTH the hermetic e2e-pr server and the
// deployed e2e-push site (dev.grabcaramel.com on dev pushes, grabcaramel.com
// on main pushes). The docs.grabcaramel.com test needs the real edge, so it
// runs only when the deployment under test IS production.

// Same production apex as e2e/seo-regression.spec.ts PRODUCTION_ORIGINS (BASE_URL
// is the apex; www redirects to it in middleware.ts).
const PRODUCTION_ORIGIN = 'https://grabcaramel.com'
const DOCS_HOST_URL = 'https://docs.grabcaramel.com/'
const DOCS_H1 = /<h1[^>]*>\s*Caramel documentation\s*<\/h1>/

test.describe('/docs hub', () => {
    test('/docs answers 200 with the documentation H1', async ({ page }) => {
        const res = await page.request.get('/docs')
        expect(res.status(), '/docs must answer 200').toBe(200)
        expect(res.headers()['content-type']).toContain('text/html')
        const html = await res.text()
        expect(html, '/docs must render the documentation H1').toMatch(DOCS_H1)
        expect(html, '/docs must declare its canonical URL').toMatch(
            /<link rel="canonical" href="https:\/\/grabcaramel\.com\/docs"\/?>/,
        )
    })

    test('/docs has a Markdown twin, by path and by Accept header', async ({
        page,
    }) => {
        const byPath = await page.request.get('/docs.md')
        expect(byPath.status(), '/docs.md must answer 200').toBe(200)
        expect(byPath.headers()['content-type']).toContain('text/markdown')
        expect(await byPath.text()).toMatch(/^# Caramel documentation$/m)

        const byAccept = await page.request.get('/docs', {
            headers: { Accept: 'text/markdown' },
        })
        expect(byAccept.status()).toBe(200)
        expect(byAccept.headers()['content-type']).toContain('text/markdown')
    })

    test('llms.txt links the docs hub', async ({ page }) => {
        const res = await page.request.get('/llms.txt')
        expect(res.status()).toBe(200)
        expect(await res.text()).toMatch(/\[Docs\]\(https?:\/\/[^)]+\/docs\)/)
    })

    test('docs.grabcaramel.com redirects to grabcaramel.com/docs with a 200', async ({
        baseURL,
        request,
    }) => {
        const origin = (baseURL ?? '').replace(/\/+$/, '')
        test.skip(
            origin !== PRODUCTION_ORIGIN,
            `needs the production edge; this run targets ${origin || 'no origin'}`,
        )
        // Red until the docs.grabcaramel.com Dokploy domain exists (set up
        // outside this repo, T-7855): that is the check doing its job.
        const res = await request.get(DOCS_HOST_URL, { maxRedirects: 5 })
        expect(
            res.url(),
            `${DOCS_HOST_URL} must end, after redirects, on ${PRODUCTION_ORIGIN}/docs`,
        ).toBe(`${PRODUCTION_ORIGIN}/docs`)
        expect(res.status()).toBe(200)
    })
})
