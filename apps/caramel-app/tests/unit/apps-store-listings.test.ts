import { PLATFORM_ADVANTAGES } from '@/app/(marketing)/apps/appsAdvantages'
import { generateAppsStructuredData } from '@/app/(marketing)/apps/appsStructuredData'
import {
    STORE_CARDS,
    STORE_LISTINGS,
    buildStoreCards,
    isListedStore,
    listingForBrowser,
} from '@/app/(marketing)/apps/storeListings'
import { CARAMEL_APP } from '@/lib/apps/caramelApp'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// /apps store cards: badges are real files with real image signatures (the
// first Chrome download was a 404 page saved as .png), a store the manifest
// carries no URL for renders as a non-clickable "Coming soon" card, and the
// JSON-LD advertises ONLY listed stores with campaign-free URLs.

const PUBLIC_DIR = path.resolve(__dirname, '../../public')

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function pngSize(buffer: Buffer): { width: number; height: number } {
    return {
        width: buffer.readUInt32BE(16),
        height: buffer.readUInt32BE(20),
    }
}

describe('storeListings — badges', () => {
    it('every badge is a real, unmodified image file whose intrinsic size matches the card', () => {
        for (const card of STORE_CARDS) {
            const file = path.join(PUBLIC_DIR, card.badge.src)
            expect(fs.existsSync(file), `${card.badge.src} missing`).toBe(true)
            const buffer = fs.readFileSync(file)
            if (file.endsWith('.png')) {
                expect(
                    buffer.subarray(0, 8).equals(PNG_MAGIC),
                    `${card.badge.src} is not a PNG`,
                ).toBe(true)
                expect(pngSize(buffer)).toEqual({
                    width: card.badge.width,
                    height: card.badge.height,
                })
            } else {
                expect(file.endsWith('.svg')).toBe(true)
                expect(buffer.toString('utf8', 0, 600)).toMatch(/<svg[\s>]/)
            }
            expect(card.badge.accessibleName).toContain('Caramel')
            expect(card.badge.heightClass).toBe('h-11')
        }
    })

    it('leads with the App Store badge (Apple lineup rule) and is live on all four browsers', () => {
        expect(STORE_CARDS[0].platform).toBe('safari')
        expect(STORE_CARDS.map(card => card.platform)).toEqual([
            'safari',
            'chrome',
            'firefox',
            'edge',
        ])
        expect(STORE_LISTINGS.length).toBe(STORE_CARDS.length)
        expect(STORE_CARDS.every(isListedStore)).toBe(true)
    })

    it('carries campaign params on the clickable href and none on the canonical one', () => {
        for (const listing of STORE_LISTINGS) {
            expect(listing.href).not.toBe(listing.canonicalHref)
            expect(listing.href.startsWith(listing.canonicalHref)).toBe(true)
            expect(listing.canonicalHref).not.toMatch(/utm_|[?&]ct=/)
            expect(listing.href).toMatch(
                /utm_source=grabcaramel\.com|ct=caramel_website/,
            )
        }
    })

    it('resolves the visitor browser to its listing, and "other" to none', () => {
        expect(listingForBrowser('chrome')?.platform).toBe('chrome')
        expect(listingForBrowser('safari')?.storeName).toBe('App Store')
        expect(listingForBrowser('other')).toBeNull()
    })

    it('gives every platform exactly three provenance-backed advantages', () => {
        for (const card of STORE_CARDS) {
            const advantages = PLATFORM_ADVANTAGES[card.platform]
            expect(advantages.length).toBe(3)
            for (const advantage of advantages) {
                expect(advantage.provenance).toMatch(
                    /apps\/caramel-extension\//,
                )
            }
        }
    })
})

describe('storeListings — coming soon (negative control)', () => {
    const withoutEdge = {
        ...CARAMEL_APP,
        stores: CARAMEL_APP.stores.filter(store => store.type !== 'edge'),
    }
    const cards = buildStoreCards(withoutEdge)
    const edge = cards.find(card => card.platform === 'edge')

    it('renders the missing store as a coming-soon card with NO href field at all', () => {
        expect(edge?.status).toBe('coming-soon')
        expect(edge && 'href' in edge).toBe(false)
        expect(edge && 'comingSoonLabel' in edge && edge.comingSoonLabel).toBe(
            'Coming soon to Microsoft Edge Add-ons',
        )
        expect(cards.filter(isListedStore).map(card => card.platform)).toEqual([
            'safari',
            'chrome',
            'firefox',
        ])
    })

    it('keeps the coming-soon store out of the JSON-LD', () => {
        const graph = generateAppsStructuredData(cards.filter(isListedStore))
        const collection = graph[0] as {
            description: string
            mainEntity: { numberOfItems: number; itemListElement: unknown[] }
        }
        expect(collection.mainEntity.numberOfItems).toBe(3)
        expect(collection.description).toBe(
            'Caramel on the App Store, Chrome Web Store and Firefox Add-ons.',
        )
        expect(JSON.stringify(graph)).not.toContain(
            'microsoftedge.microsoft.com',
        )
    })
})

describe('appsStructuredData — live graph', () => {
    const graph = generateAppsStructuredData()
    const serialised = JSON.stringify(graph)

    it('lists one SoftwareApplication per listed store, campaign-free, no ratings', () => {
        const collection = graph[0] as {
            '@type': string
            url: string
            mainEntity: {
                itemListElement: { item: Record<string, unknown> }[]
            }
        }
        expect(collection['@type']).toBe('CollectionPage')
        expect(collection.url).toMatch(/\/apps$/)
        const items = collection.mainEntity.itemListElement.map(e => e.item)
        expect(items.length).toBe(STORE_LISTINGS.length)
        STORE_LISTINGS.forEach((listing, index) => {
            expect(items[index].downloadUrl).toBe(listing.canonicalHref)
            expect(items[index]['@id']).toMatch(
                new RegExp(`/apps#${listing.platform}$`),
            )
        })
        expect(serialised).not.toMatch(/utm_|ct=caramel_website/)
        expect(serialised).not.toMatch(/aggregateRating|reviewRating/)
        expect(graph[1]).toMatchObject({ '@type': 'BreadcrumbList' })
    })
})
