// The copy of /affiliate-policy (T-7168), as data.
//
// DRAFT FOR OWNER APPROVAL: this is a public claim about what the extension
// does, so the PR that adds it stays a draft until the owner approves the
// wording. Every sentence below states something the code does today and
// something tests/unit/affiliate-policy.test.ts and the extension's
// tests/affiliate-integrity.test.mjs back up. It says nothing about how Caramel
// earns money, on purpose: the code cannot tell us that, so the page does not
// either. If the extension's behaviour changes, change the sentence in the same
// PR, or the regression test goes red first.
//
// Audit record: code audit 2026-10-23 at main 1221ce5 (extension entrypoints,
// manifest permissions, git history, the Safari container app, and every app
// route and page the extension calls or opens). Findings are summarised in the
// research file section "caramel vs Honey, Capital One Shopping, Rakuten".
import { GITHUB_REPO_URL } from '@/lib/brandLinks'

export const AFFILIATE_POLICY_PATH = '/affiliate-policy'

/** The day the claims below were last checked against the code. */
export const AFFILIATE_POLICY_CHECKED_ON = new Date(Date.UTC(2026, 9, 23))

/** The regression test the "How we check this" section points at. */
export const AFFILIATE_POLICY_TEST_PATH =
    'apps/caramel-extension/tests/affiliate-integrity.test.mjs'

export const AFFILIATE_POLICY_TEST_URL = `${GITHUB_REPO_URL}/blob/main/${AFFILIATE_POLICY_TEST_PATH}`

export type AffiliatePolicySection = {
    id: string
    heading: string
    /** Optional paragraph shown above the list. */
    intro?: string
    items: ReadonlyArray<string>
}

export const AFFILIATE_POLICY_COPY = {
    title: 'Affiliate policy | Caramel',
    heading: 'Our affiliate policy',
    description:
        'What the Caramel extension does and does not do with affiliate links, tracking codes and cookies at checkout, and how it is checked.',
    summary:
        'Caramel does not replace, rewrite or add affiliate links or tracking codes on the pages you visit. This page says exactly what the extension does at checkout, what it does not do, and how you can check it yourself.',
    checkedOn: 'Last checked against the code on',
    checkedOnAfter:
        '. It describes what the extension and this website do today and does not cover anything else.',
    checkHeading: 'How we check this',
    checkBefore:
        'Caramel is open source under the AGPL-3.0 license, so you can read all of it. We also keep a test that fails the build if any of the things above appear in the extension: ',
    checkLink: 'affiliate-integrity.test.mjs',
    checkAfter:
        '. It looks for network affiliate addresses, affiliate or tracking parameters on links, anything that changes the address of a page or tab, cookie writes, hidden frames and pixels, requests to anywhere other than grabcaramel.com and the store you are on, and any permission that would let an extension read or change network requests or cookies. It runs in our automated checks on every change to the extension. A test like this cannot see everything, which is why the source is public as well.',
    reportBefore: 'If you ever see Caramel change a link or a cookie, ',
    reportLink: 'tell us',
    reportAfter: ' and we will treat it as a bug.',
} as const

export const AFFILIATE_POLICY_SECTIONS: ReadonlyArray<AffiliatePolicySection> =
    [
        {
            id: 'does-not',
            heading: 'What Caramel does not do',
            items: [
                'It does not add, replace or remove an affiliate link, referral link or tracking code on any page you visit or any link you click. The extension has no code that changes the address of the page you are on.',
                'It makes no change to any link whether or not a code works. Finding no working code leaves the links on your visit exactly as they were.',
                'It does not itself set, change or delete cookies on store sites, and it does not ask your browser for the cookies permission. When a code is applied the store may set its own cookies in response, as it would if you typed the code yourself.',
                'It does not ask for the browser permissions that let an extension read or change network requests (webRequest and declarativeNetRequest).',
                'It does not open hidden tabs, hidden frames or tracking pixels on store sites or on advertising networks.',
                'Its code contains no address belonging to an affiliate network and adds no affiliate or tracking parameter to any address.',
                'It does not start trying codes until you tap the prompt it shows at checkout.',
            ],
        },
        {
            id: 'does',
            heading: 'What Caramel does at checkout',
            items: [
                'After you tap the prompt, it tries up to 8 codes from our catalog on your cart.',
                'To apply a code it types the code into the store’s own coupon box and presses the store’s own apply button. On stores whose cart can be read at /cart.js and that take a code at /discount/<code>, it instead asks the store you are already on to attach the code, then reads your cart total back. It may reload the page afterwards so the store shows the discount. A reload keeps the same address.',
                'Stores usually take one discount code at a time, so a code Caramel applies can replace a code that was already on your cart. On the stores where Caramel compares codes, it keeps the one that gives the lowest total, and puts back the code you arrived with if none of its codes beat it.',
                'The extension’s own requests go to grabcaramel.com. The only other requests it makes go to the store you are on, to read your cart and, where the store supports it, to attach a code. Signing in with Google or Apple opens that provider’s own sign-in window.',
                'It opens tabs only to Caramel pages on grabcaramel.com, such as the welcome page after you install it and the sign-in page. Links inside its popup go to grabcaramel.com and to Caramel’s page on GitHub.',
                'The permissions it asks for are tabs, storage and alarms, identity on Chrome, Edge and Safari (for the sign-in window), and access to https pages so it can work on stores. Its own bookkeeping, such as which codes it already tried in this tab, is kept in the browser’s extension storage and the tab’s session storage, not in cookies.',
            ],
        },
        {
            id: 'codes',
            heading: 'Where the codes come from',
            intro: 'Applying a code means typing it in, and a code is only text. Two things follow from that.',
            items: [
                'Our catalog has no field for a link or an affiliate tag. A code is stored as the code, the store it is for and a short description.',
                'A coupon catalog can contain personal referral codes, which credit the person who shared them. When a batch of codes reaches us, we drop codes whose title or description say they are referral codes, except new-customer offers, which stay and are labelled “New customers only” on the site. Codes that shoppers choose to submit are not checked for being referral codes, so one can get through.',
            ],
        },
        {
            id: 'website',
            heading: 'This website',
            items: [
                'The coupon pages on grabcaramel.com show codes as text. They do not send you to the store through an affiliate or tracking link.',
            ],
        },
    ]
