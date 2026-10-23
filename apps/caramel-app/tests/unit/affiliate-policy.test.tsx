import AffiliatePolicyPage, {
    metadata,
} from '@/app/(marketing)/affiliate-policy/page'
import Footer from '@/layouts/Footer/Footer'
import { GITHUB_REPO_URL } from '@/lib/brandLinks'
import { CouponListRowSchema } from '@/lib/couponsDb'
import {
    AFFILIATE_POLICY_COPY,
    AFFILIATE_POLICY_PATH,
    AFFILIATE_POLICY_SECTIONS,
    AFFILIATE_POLICY_TEST_PATH,
    AFFILIATE_POLICY_TEST_URL,
} from '@/lib/marketing/affiliatePolicyContent'
import { SurfaceProvider } from '@/lib/surface/SurfaceProvider'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

// /affiliate-policy is a public claim about what the extension does, so it is
// pinned the way the store listing is (apps/caramel-extension/tests/
// store-listing.test.mjs): no sentence the code does not back up, no statement
// about how Caramel earns money, and the "How we check this" link must point at
// a test that exists. The extension side of the claim (nothing rewrites a URL,
// writes a cookie, opens a hidden frame, ...) is the extension's
// tests/affiliate-integrity.test.mjs; this file pins the page and the catalog.

const APP_ROOT = path.resolve(__dirname, '..', '..')
const REPO_ROOT = path.resolve(APP_ROOT, '..', '..')

const everySentence = [
    AFFILIATE_POLICY_COPY.summary,
    AFFILIATE_POLICY_COPY.checkedOnAfter,
    AFFILIATE_POLICY_COPY.checkBefore,
    AFFILIATE_POLICY_COPY.checkAfter,
    ...AFFILIATE_POLICY_SECTIONS.flatMap(section => [
        section.heading,
        ...(section.intro ? [section.intro] : []),
        ...section.items,
    ]),
]
const everyText = everySentence.join('\n')

describe('/affiliate-policy copy', () => {
    it('makes no promise the code does not back up (same bans as the store listing)', () => {
        const banned = [
            /every (coupon|code|store|site)/i,
            /all (coupon|code|store|site)s/i,
            /best (coupon|code)/i,
            /\balways\b/i,
            /\bnever\b/i,
            /guarantee/i,
            /100%/,
        ]
        for (const pattern of banned) {
            expect(everyText).not.toMatch(pattern)
        }
    })

    it('says nothing about how Caramel earns money', () => {
        // The code cannot show that, so the page does not claim it either way.
        expect(everyText).not.toMatch(
            /\b(revenue|earn\w*|monetiz\w*|fund(ed|ing)|profit|sponsor\w*|commissions?|free)\b/i,
        )
    })

    it('states each verified behaviour it is built on', () => {
        // One assertion per claim, so rewording one cannot silently drop it.
        expect(everyText).toMatch(
            /does not add, replace or remove an affiliate link/,
        )
        expect(everyText).toMatch(
            /makes no change to any link whether or not a code works/,
        )
        expect(everyText).toMatch(
            /does not itself set, change or delete cookies/,
        )
        expect(everyText).toMatch(/cookies permission/)
        expect(everyText).toMatch(/webRequest and declarativeNetRequest/)
        expect(everyText).toMatch(
            /hidden tabs, hidden frames or tracking pixels/,
        )
        expect(everyText).toMatch(/tap the prompt/)
        expect(everyText).toMatch(/up to 8 codes/)
        expect(everyText).toMatch(/types the code into the store/)
    })

    it('discloses the limits: a typed code can be a referral code, and a reload can follow an apply', () => {
        expect(everyText).toMatch(/personal referral codes/)
        expect(everyText).toMatch(/not checked for being referral codes/)
        expect(everyText).toMatch(
            /can replace a code that was already on your cart/,
        )
        expect(everyText).toMatch(/reload the page afterwards/)
    })

    it('never lists a permission the extension does not ask for as one it does', () => {
        const listed = AFFILIATE_POLICY_SECTIONS.flatMap(s => s.items).find(
            item => item.startsWith('The permissions it asks for are'),
        )
        expect(listed).toBeDefined()
        // The wxt config is the single source of the generated manifests.
        const config = readFileSync(
            path.join(REPO_ROOT, 'apps/caramel-extension/wxt.config.ts'),
            'utf8',
        )
        for (const permission of ['tabs', 'storage', 'alarms', 'identity']) {
            expect(listed).toContain(permission)
            expect(config).toContain(`'${permission}'`)
        }
    })
})

describe('/affiliate-policy page', () => {
    const html = renderToStaticMarkup(<AffiliatePolicyPage />)

    it('renders the heading, every section and every item', () => {
        expect(html).toContain(AFFILIATE_POLICY_COPY.heading)
        for (const section of AFFILIATE_POLICY_SECTIONS) {
            expect(html).toContain(`id="${section.id}-heading"`)
            expect(html).toContain(section.heading)
            expect(section.items.length).toBeGreaterThan(0)
        }
        expect(html).toContain(AFFILIATE_POLICY_COPY.checkHeading)
        // Apostrophes are escaped in HTML; check a plain-text item instead.
        expect(html).toContain(
            'It does not add, replace or remove an affiliate link',
        )
    })

    it('points "How we check this" at a regression test that exists in the repo', () => {
        expect(AFFILIATE_POLICY_TEST_URL).toBe(
            `${GITHUB_REPO_URL}/blob/main/${AFFILIATE_POLICY_TEST_PATH}`,
        )
        expect(
            existsSync(path.join(REPO_ROOT, AFFILIATE_POLICY_TEST_PATH)),
        ).toBe(true)
        expect(html).toContain(`href="${AFFILIATE_POLICY_TEST_URL}"`)
        expect(html).toContain('href="/support"')
    })

    it('is an indexable page with a canonical URL on its own path', () => {
        expect(metadata.alternates?.canonical).toMatch(
            new RegExp(`${AFFILIATE_POLICY_PATH}$`),
        )
        expect(metadata.robots).toMatchObject({ index: true, follow: true })
        expect(metadata.title).toBe(AFFILIATE_POLICY_COPY.title)
    })

    it('links out only to Caramel’s own repository and pages', () => {
        const hrefs = Array.from(html.matchAll(/href="([^"]+)"/g), m => m[1])
        for (const href of hrefs) {
            expect(
                href.startsWith('/') || href.startsWith(GITHUB_REPO_URL),
                href,
            ).toBe(true)
        }
    })
})

describe('/affiliate-policy is linked', () => {
    it('from the footer’s Legal list, next to the privacy policy', () => {
        const footer = renderToStaticMarkup(
            <SurfaceProvider>
                <Footer />
            </SurfaceProvider>,
        )
        const legal = footer.slice(footer.indexOf('aria-label="Legal"'))
        expect(legal).toContain(`href="${AFFILIATE_POLICY_PATH}"`)
        expect(legal).toContain('href="/privacy"')
    })
})

describe('the catalog carries no link or affiliate field', () => {
    const FORBIDDEN_FIELD =
        /url|link|href|affiliate|tracking|redirect|network|clickid/i

    it('has none in the coupon read schema', () => {
        expect(
            Object.keys(CouponListRowSchema.shape).filter(key =>
                FORBIDDEN_FIELD.test(key),
            ),
        ).toEqual([])
    })

    it('has none in the Coupon table', () => {
        const schema = readFileSync(
            path.join(APP_ROOT, 'prisma/schema.prisma'),
            'utf8',
        )
        const block = schema.match(/\nmodel Coupon \{([\s\S]*?)\n\}/)
        expect(block, 'model Coupon not found').toBeTruthy()
        const fields = (block?.[1] ?? '')
            .split('\n')
            .map(line => line.trim())
            .filter(
                line =>
                    line && !line.startsWith('//') && !line.startsWith('@@'),
            )
            .map(line => line.split(/\s+/)[0])
        expect(fields).toContain('code')
        expect(fields.filter(name => FORBIDDEN_FIELD.test(name))).toEqual([])
    })
})
