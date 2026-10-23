/**
 * @vitest-environment node
 *
 * Affiliate-integrity guard (T-7168, 2026-10-23).
 *
 * Caramel says, publicly, that it never adds, replaces or removes affiliate
 * links, tracking codes or cookies (the store listing in
 * scripts/store-listing.mjs, the FAQ, and the /affiliate-policy page). A code
 * audit at main 1221ce5 found nothing that does; this suite is what keeps that
 * true. It fails the build the moment a code path of the kind Honey was accused
 * of appears in the SHIPPED extension source, so the claim cannot rot silently.
 *
 * What it pins, each as its own test:
 *   - the manifest asks only for the four permissions the extension uses, and
 *     none of the ones that let an extension rewrite requests or touch cookies
 *     (declarativeNetRequest, webRequest, cookies, scripting, ...),
 *   - no hard-coded affiliate-network domain, anywhere in the extension source
 *     or the Safari container app,
 *   - no affiliate/tracking query parameter being put on a URL,
 *   - nothing rewrites the page the shopper is on or a tab they open: no
 *     tabs.update, location assignment, history rewrite or window.open; the one
 *     reload stays a reload; every tab the extension opens is a grabcaramel.com
 *     page or the welcome page,
 *   - nothing writes a cookie or uses the cookies API,
 *   - nothing opens a hidden iframe, pixel or beacon,
 *   - every fetch goes to grabcaramel.com or to the shopper's own store origin.
 *
 * Comments are stripped first (esbuild), so prose that merely talks about
 * affiliate links never trips it. Precision over coverage: each pattern names a
 * specific mechanism, and a new legitimate use is added to the explicit
 * allowlist below with a reason, which puts it in front of a reviewer.
 *
 * Known limit, stated so nobody mistakes this for a proof: a static scan cannot
 * see a URL assembled at runtime from data (for example a host fetched from the
 * server). The catalog side of that is pinned in the app suite
 * (tests/unit/affiliate-policy.test.ts: the coupon schema carries no URL field).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { transform } from 'esbuild'
import { describe, expect, it } from 'vitest'

import { EXT_ROOT } from './_entry-modules.mjs'

const APPLE_ROOT = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../caramel-apple',
)

// Directories that are not shipped runtime source.
const SKIP_DIRS = new Set([
    'node_modules',
    'tests',
    'scripts',
    'brand',
    'types',
    'public',
    '.output',
    '.wxt',
    '.size-cache',
    'dist',
])

function walk(dir, files = []) {
    for (const name of readdirSync(dir)) {
        if (name.startsWith('.')) continue
        const full = join(dir, name)
        if (statSync(full).isDirectory()) {
            if (!SKIP_DIRS.has(name)) walk(full, files)
        } else if (['.js', '.ts', '.tsx'].includes(extname(name))) {
            files.push(full)
        }
    }
    return files
}

const LOADERS = { '.js': 'js', '.ts': 'ts', '.tsx': 'tsx' }

/** Shipped source with comments removed, keyed by package-relative path. */
async function shippedSources() {
    const out = {}
    for (const file of walk(EXT_ROOT)) {
        const rel = relative(EXT_ROOT, file).replaceAll('\\', '/')
        // Config files and the generated constants are not runtime code paths
        // that touch a page; the manifest is checked separately below.
        if (rel === 'wxt.config.ts' || rel === 'vitest.config.ts') continue
        const { code } = await transform(readFileSync(file, 'utf8'), {
            loader: LOADERS[extname(file)],
            legalComments: 'none',
            jsx: 'automatic',
        })
        out[rel] = code
    }
    return out
}

const sources = await shippedSources()
const entries = Object.entries(sources)

/** [file, 1-based line, text] of every line of every source matching `re`. */
function hits(re) {
    const found = []
    for (const [file, code] of entries) {
        code.split('\n').forEach((text, i) => {
            if (re.test(text)) found.push(`${file}:${i + 1}: ${text.trim()}`)
        })
    }
    return found
}

describe('shipped source is the thing being scanned', () => {
    it('finds the extension realms (a scan of nothing proves nothing)', () => {
        for (const must of [
            'background.js',
            'coupon-apply.js',
            'coupon-runner.js',
            'popup-core.js',
            'entrypoints/content.ts',
            'entrypoints/background.ts',
            'entrypoints/porkbun-alert.content.ts',
        ]) {
            expect(Object.keys(sources), must).toContain(must)
        }
        expect(entries.length).toBeGreaterThan(20)
    })

    it('does not scan the tests or the build scripts', () => {
        expect(Object.keys(sources).some(f => f.startsWith('tests/'))).toBe(
            false,
        )
        expect(Object.keys(sources).some(f => f.startsWith('scripts/'))).toBe(
            false,
        )
    })
})

// ---------------------------------------------------------------------------
// Manifest permissions
// ---------------------------------------------------------------------------

describe('manifest permissions', () => {
    // The wxt config text is the single source of the generated manifests.
    const config = readFileSync(join(EXT_ROOT, 'wxt.config.ts'), 'utf8')

    /** Every quoted string inside the `permissions:` expression of the config. */
    function declaredPermissions() {
        const m = config.match(
            /\n\s{8}permissions:\s*([\s\S]*?),\n\s{8}host_permissions/,
        )
        expect(m, 'wxt.config.ts permissions expression not found').toBeTruthy()
        // 'firefox' is the browser name in the ternary, not a permission.
        return [...m[1].matchAll(/'([a-zA-Z]+)'/g)]
            .map(x => x[1])
            .filter(name => name !== 'firefox')
    }

    it('asks for exactly the permissions the extension uses', () => {
        // tabs: badge + welcome tab; storage: settings/session; identity:
        // Chrome sign-in popup; alarms: the badge refresh. Adding one here is
        // a deliberate decision, and the store justification text must follow.
        expect(new Set(declaredPermissions())).toEqual(
            new Set(['tabs', 'storage', 'identity', 'alarms']),
        )
    })

    it('never names a permission that can rewrite requests or touch cookies', () => {
        const banned = [
            'declarativeNetRequest',
            'declarativeNetRequestWithHostAccess',
            'declarativeNetRequestFeedback',
            'webRequest',
            'webRequestBlocking',
            'webRequestAuthProvider',
            'cookies',
            'scripting',
            'webNavigation',
            'proxy',
            'nativeMessaging',
            'contextMenus',
            'history',
            'browsingData',
        ]
        for (const name of banned) {
            expect(config, `wxt.config.ts mentions ${name}`).not.toMatch(
                new RegExp(`['"]${name}['"]`),
            )
        }
        // No optional permissions beyond hosts, and no static DNR ruleset.
        expect(config).not.toMatch(/optional_permissions\s*:/)
        expect(config).not.toMatch(/declarative_net_request/)
    })

    it('keeps the host grant to https pages and declares no ruleset file', () => {
        expect(config).toMatch(/host_permissions:\s*\['https:\/\/\*\/\*'\]/)
        const ruleFiles = walk(EXT_ROOT).filter(f => /rules?.*\.json$/i.test(f))
        expect(ruleFiles).toEqual([])
    })
})

// ---------------------------------------------------------------------------
// Affiliate networks and tracking parameters
// ---------------------------------------------------------------------------

// Hosts that exist to attribute a sale to a publisher. A coupon store such as
// rakuten.com is a plain store domain and is not in this list; only the
// click-tracking hosts of the networks are.
const AFFILIATE_HOSTS = [
    'awin1.com',
    'zenaps.com',
    'impactradius.com',
    'impactradius-go.com',
    'evyy.net',
    'sjv.io',
    'pxf.io',
    'ojrq.net',
    'anrdoezrs.net',
    'dpbolvw.net',
    'jdoqocy.net',
    'tkqlhce.net',
    'kqzyfj.com',
    'lduhtrp.net',
    'qksrv.net',
    'ftjcfx.com',
    'emjcd.com',
    'shareasale.com',
    'shareasale-analytics.com',
    'linksynergy.com',
    'prf.hn',
    'partnerize.com',
    'skimresources.com',
    'skimlinks.com',
    'viglink.com',
    'sovrn.com',
    'redirectingat.com',
    'pjtra.com',
    'pjatr.com',
    'pntra.com',
    'pntrac.com',
    'pntrs.com',
    'flexoffers.com',
    'avantlink.com',
    'avmws.com',
    'tradedoubler.com',
    'tradetracker.com',
    'webgains.com',
    'clickbank.net',
    'refersion.com',
    'howl.link',
    'wild.link',
    'amzn.to',
    'rover.ebay.com',
]
const HOST_RE = new RegExp(
    `(^|[^a-z0-9-])(${AFFILIATE_HOSTS.map(h => h.replaceAll('.', '\\.')).join('|')})($|[^a-z0-9-])`,
    'i',
)

describe('affiliate networks and tracking parameters', () => {
    it('names no affiliate-network host in the extension source', () => {
        expect(hits(HOST_RE)).toEqual([])
    })

    it('names no affiliate-network host in the Safari container app', () => {
        const swift = []
        const stack = [APPLE_ROOT]
        while (stack.length) {
            const dir = stack.pop()
            for (const name of readdirSync(dir)) {
                if (name.startsWith('.') || name === 'Caramel.xcodeproj')
                    continue
                const full = join(dir, name)
                if (statSync(full).isDirectory()) stack.push(full)
                else if (name.endsWith('.swift')) swift.push(full)
            }
        }
        expect(swift.length).toBeGreaterThan(5)
        for (const file of swift) {
            expect(readFileSync(file, 'utf8'), file).not.toMatch(HOST_RE)
        }
    })

    it('puts no affiliate or tracking parameter on a URL', () => {
        // `?tag=`, `&irclickid=` inside any string, and URLSearchParams
        // set/append of the same names. `ref` and `utm_*` only count when they
        // are being written as a parameter, so the first-touch field list in
        // install-attribution.js (names of Caramel's OWN record) is not a hit.
        const names =
            'tag|ref|aff|affid|aff_id|affiliate|affiliate_id|irclickid|clickid|ranMID|ranEAID|ranSiteID|subid|u1|campid|customid|utm_[a-z]+'
        const inString = new RegExp(`[?&](${names})=`, 'i')
        const asParam = new RegExp(
            `searchParams\\s*\\.\\s*(set|append)\\(\\s*["'\`](${names})["'\`]`,
            'i',
        )
        expect(hits(inString)).toEqual([])
        expect(hits(asParam)).toEqual([])
    })
})

// ---------------------------------------------------------------------------
// Navigation: nothing rewrites where the shopper is going
// ---------------------------------------------------------------------------

describe('navigation', () => {
    it('never updates a tab, assigns a location, rewrites history or opens a window', () => {
        const patterns = {
            'tabs.update': /\.tabs\s*\.\s*update\s*\(/,
            'location.assign/replace':
                /\blocation\s*\.\s*(assign|replace)\s*\(/,
            'location.href/search/hash/pathname assignment':
                /\blocation\s*\.\s*(href|search|hash|pathname|host|hostname|origin)\s*=[^=]/,
            'bare location assignment': /(^|[^.\w])location\s*=[^=]/,
            'window/top/document location assignment':
                /\b(window|top|self|parent|document)\s*\.\s*location\s*=[^=]/,
            'history.pushState/replaceState':
                /\bhistory\s*\.\s*(pushState|replaceState)\s*\(/,
            'window.open': /\b(window|self|top)\s*\.\s*open\s*\(/,
            'meta refresh': /http-equiv\s*=\s*["']?refresh/i,
        }
        for (const [name, re] of Object.entries(patterns)) {
            expect(hits(re), name).toEqual([])
        }
    })

    it('only ever reloads the page it is on (the post-apply reload), nothing else', () => {
        // The discount-link win reloads so the store's own UI shows the applied
        // discount (coupon-runner.js). A reload keeps the URL the shopper had.
        const reloads = hits(/\blocation\s*\.\s*reload\s*\(/)
        expect(reloads.map(r => r.split(':')[0])).toEqual(['coupon-runner.js'])
    })

    it('opens tabs and windows only to grabcaramel.com or the extension itself', () => {
        const created = hits(/\.(tabs|windows)\s*\.\s*create\s*\(/)
        // Each call site, with the exact URL expression it passes.
        const urlArg = file => {
            const code = sources[file]
            const m = [
                ...code.matchAll(
                    /\.(tabs|windows)\s*\.\s*create\s*\(\s*\{([^}]*?)(,\s*\n|\n|\})/g,
                ),
            ]
            return m.map(x => x[2].replace(/\s+/g, ' ').trim())
        }
        expect(created.map(c => c.split(':')[0]).toSorted()).toEqual([
            'background.js', // welcome tab after install: welcomeUrl() on grabcaramel.com
            'background.js', // the sign-in popup window: the extension's own popup.html
            'popup-core.js', // "sign in on the website": caramelUrl() on grabcaramel.com
        ])
        expect(urlArg('background.js')).toEqual(expect.arrayContaining(['url']))
        expect(sources['background.js']).toMatch(/const url = welcomeUrl\(/)
        expect(sources['background.js']).toMatch(
            /url: currentBrowser\.runtime\.getURL\(/,
        )
        expect(urlArg('popup-core.js')).toEqual(['url: caramelUrl(path)'])
    })

    it('builds every caramel URL from the build-time base, never a literal host', () => {
        expect(sources['popup-core.js']).toMatch(
            /caramelUrl = \(?path\)? =>\s*new URL\(path, `\$\{CARAMEL_ENV\.baseUrl\}\/`\)/,
        )
        expect(sources['background.js']).toMatch(
            /caramelUrl = \(?path\)? => new URL\(path, `\$\{CARAMEL_BASE_URL\}\/`\)/,
        )
    })
})

// ---------------------------------------------------------------------------
// Cookies and storage on other people's sites
// ---------------------------------------------------------------------------

describe('cookies', () => {
    it('never writes a cookie and never uses the cookies API', () => {
        expect(hits(/\bdocument\s*\.\s*cookie\s*=[^=]/)).toEqual([])
        expect(
            hits(/\b(chrome|browser|currentBrowser|api)\s*\.\s*cookies\b/),
        ).toEqual([])
        expect(hits(/cookieStore\s*\.\s*(set|delete)\b/)).toEqual([])
        expect(hits(/set-cookie/i)).toEqual([])
    })

    it('reads document.cookie only on a Caramel origin, for the first-touch record', () => {
        const reads = hits(/\bdocument\s*\.\s*cookie\b/)
        expect(reads.map(r => r.split(':')[0])).toEqual(['coupon-runner.js'])
        // The call sits behind the Caramel-origin check.
        expect(sources['coupon-runner.js']).toMatch(
            /CARAMEL_ALLOWED_ORIGINS\.has\(location\.origin\)/,
        )
    })
})

// ---------------------------------------------------------------------------
// Hidden frames, pixels, beacons
// ---------------------------------------------------------------------------

describe('hidden requests', () => {
    it('opens no iframe, pixel, beacon, socket or XHR', () => {
        const patterns = {
            iframe: /createElement\(\s*["'`](iframe|frame|embed|object)["'`]/i,
            'iframe markup': /<\s*(iframe|frame|embed|object)\b/i,
            'script/link/img element created':
                /createElement\(\s*["'`](script|link|img|form)["'`]/i,
            'new Image': /\bnew\s+Image\s*\(/,
            sendBeacon: /\bsendBeacon\s*\(/,
            XHR: /\bXMLHttpRequest\b/,
            WebSocket: /\bnew\s+WebSocket\s*\(/,
            EventSource: /\bnew\s+EventSource\s*\(/,
        }
        for (const [name, re] of Object.entries(patterns)) {
            expect(hits(re), name).toEqual([])
        }
    })

    it('loads the only <img> templates from the extension package', () => {
        for (const line of hits(/<img\b/)) {
            expect(line, line).toMatch(/src="\$\{logoUrl\}"/)
        }
        const logoSources = [
            ...sources['UI-helpers.js'].matchAll(/const logoUrl = ([^\n]+)/g),
        ].map(m => m[1])
        expect(logoSources.length).toBeGreaterThan(0)
        for (const src of logoSources) {
            expect(src).toMatch(/^currentBrowser\.runtime\.getURL\(/)
        }
    })
})

// ---------------------------------------------------------------------------
// Where requests go
// ---------------------------------------------------------------------------

describe('network destinations', () => {
    it('hard-codes no absolute URL except Caramel, its repository, the SVG namespace and the one page-world match', () => {
        const allowed =
            /https?:\/\/(www\.w3\.org\/2000\/svg|grabcaramel\.com|github\.com\/DevinoSolutions\/caramel|porkbun\.com\/checkout\/)/
        const literals = hits(/https?:\/\/[a-z0-9.-]+/i).filter(
            line => !allowed.test(line),
        )
        expect(literals).toEqual([])
    })

    it("sends every fetch to grabcaramel.com or to the shopper's own store origin", () => {
        const calls = []
        for (const [file, code] of entries) {
            for (const m of code.matchAll(
                /\bfetch\(\s*([^,)]+(?:\([^)]*\))?[^,)]*)/g,
            )) {
                calls.push({ file, arg: m[1].trim() })
            }
        }
        expect(calls.length).toBeGreaterThan(10)

        const caramelArg =
            /^(caramelUrl\(|`\$\{baseURL\}\/api\/|new URL\(\s*["']api\/extension\/supported-stores["'])/
        // Root-relative paths are the store's own origin (cart reads and the
        // store's /discount/<code>, which attaches a code to the cart).
        const ownStoreArg = /^["'`]\/(?!\/)/
        // Identifiers whose value is built above from caramelUrl().
        const knownVariables = {
            'background.js': new Set(['url', 'url.toString()']),
            'popup-core.js': new Set(['authorizeUrl']),
        }
        // The extension's own packaged files.
        const packagedArg = /^currentBrowser\.runtime\.getURL\(/

        const unexplained = calls.filter(({ file, arg }) => {
            if (caramelArg.test(arg)) return false
            if (ownStoreArg.test(arg)) return false
            if (packagedArg.test(arg)) return false
            if (knownVariables[file]?.has(arg)) return false
            return true
        })
        expect(unexplained).toEqual([])
    })

    it('keeps every identifier-valued fetch pointed at a caramelUrl()', () => {
        expect(sources['popup-core.js']).toMatch(
            /const authorizeUrl = `\$\{baseURL\}\/api\/extension\/oauth\/authorize\?/,
        )
        // background.js: fetchWithTimeout(url) is only reached through
        // fetchCaramelApi / the caramelUrl() call sites, never a literal host.
        const callers = hits(/fetchWithTimeout\(/).filter(
            l => !/function fetchWithTimeout/.test(l),
        )
        expect(callers.length).toBeGreaterThan(3)
    })
})
