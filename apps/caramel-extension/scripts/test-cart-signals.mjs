#!/usr/bin/env node
/**
 * Runs cart-signals.js against the bot's cached debug HTML snapshots and
 * prints the extracted payloads. Usage:
 *   node scripts/test-cart-signals.mjs [debug_root] [limit]
 */
import { JSDOM } from 'jsdom'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)

const DEBUG_ROOT = resolve(
    process.argv[2] || 'c:/Users/alaed/Documents/Github/caramel-coupons/debug',
)
const LIMIT = parseInt(process.argv[3] || '20', 10)

const PAGE_PRIORITY = [
    '01_known_page_cart.html',
    '01_known_page_basket.html',
    '01_known_page_bag.html',
    '01_known_page_checkout.html',
    '02_product_flow_homepage.html',
]

function pickSnapshot(storeDir) {
    for (const name of PAGE_PRIORITY) {
        const p = join(storeDir, name)
        if (existsSync(p) && statSync(p).size > 500) return p
    }
    // Fallback: any non-empty html file
    const files = readdirSync(storeDir).filter(f => f.endsWith('.html'))
    for (const f of files) {
        const p = join(storeDir, f)
        if (statSync(p).size > 500) return p
    }
    return null
}

async function runStore(domain) {
    const storeDir = join(DEBUG_ROOT, domain)
    if (!existsSync(storeDir) || !statSync(storeDir).isDirectory()) return null
    const snapshot = pickSnapshot(storeDir)
    if (!snapshot) return { domain, error: 'no_snapshot' }
    const html = readFileSync(snapshot, 'utf8')
    const dom = new JSDOM(html, {
        url: `https://www.${domain}/`,
        runScripts: 'outside-only',
    })
    const { window } = dom
    window.Shopify = window.Shopify || undefined // extractor probes window only
    // Inject the module into this window
    const extractorSrc = readFileSync(resolve('./cart-signals.js'), 'utf8')
    window.eval(extractorSrc)
    // Stub fetch — we don't want to hit networks during the test
    window.fetch = () => Promise.reject(new Error('fetch disabled in test'))

    const api = window.CaramelCartSignals
    if (!api) return { domain, error: 'extractor_not_loaded', snapshot }
    try {
        const payload = await api.collectCartSignals()
        return { domain, snapshot: snapshot.split(/[\\/]/).pop(), ...payload }
    } catch (e) {
        return {
            domain,
            snapshot: snapshot.split(/[\\/]/).pop(),
            error: String((e && e.message) || e),
        }
    }
}

async function main() {
    if (!existsSync(DEBUG_ROOT)) {
        console.error(`debug root missing: ${DEBUG_ROOT}`)
        process.exit(1)
    }
    const all = readdirSync(DEBUG_ROOT).filter(n => !n.startsWith('.'))
    const targets = all.slice(0, LIMIT)
    console.error(`testing ${targets.length} stores from ${DEBUG_ROOT}`)
    const results = []
    for (const d of targets) {
        const r = await runStore(d)
        if (r) results.push(r)
    }

    // Compact report
    const header = [
        'domain',
        'snapshot',
        'title_len',
        'desc_len',
        'cart_items',
        'ld_hits',
        'platform',
    ]
    console.log(header.join('\t'))
    let hasTitle = 0,
        hasDesc = 0,
        hasItems = 0
    for (const r of results) {
        if (r.error) {
            console.log(
                [r.domain, r.snapshot || '-', 'err:', r.error].join('\t'),
            )
            continue
        }
        const platform =
            Object.entries(r.platform_hints)
                .filter(([, v]) => v)
                .map(([k]) => k)
                .join(',') || 'custom'
        const titleLen = (r.title || '').length
        const descLen = (r.meta_description || '').length
        const itemN = (r.cart_items || []).length
        if (titleLen) hasTitle++
        if (descLen) hasDesc++
        if (itemN) hasItems++
        console.log(
            [
                r.domain,
                r.snapshot,
                titleLen,
                descLen,
                itemN,
                r.cart_items.length,
                platform,
            ].join('\t'),
        )
    }
    console.error(
        `\nCoverage across ${results.length}: title=${hasTitle}, desc=${hasDesc}, cart_items=${hasItems}`,
    )

    // Dump 5 full payloads
    console.error('\n--- Sample payloads (5) ---')
    for (const r of results.slice(0, 5)) {
        console.error(JSON.stringify(r, null, 2))
        console.error('---')
    }
}

main().catch(e => {
    console.error(e)
    process.exit(1)
})
