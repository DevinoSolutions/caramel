import { expect, test } from '@playwright/test'
import { existsSync, readFileSync } from 'fs'
import { join, resolve } from 'path'

const extensionDir = resolve(__dirname, '../../caramel-extension')

test.describe('Extension — Manifest Validation', () => {
    let manifest: Record<string, unknown>

    test.beforeAll(() => {
        const raw = readFileSync(join(extensionDir, 'manifest.json'), 'utf-8')
        manifest = JSON.parse(raw)
    })

    test('manifest.json is valid and has required fields', () => {
        expect(manifest.manifest_version).toBe(3)
        expect(manifest.name).toBeTruthy()
        expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/)
        expect(manifest.description).toBeTruthy()
    })

    test('manifest declares required permissions', () => {
        const permissions = manifest.permissions as string[]
        expect(permissions).toContain('tabs')
        expect(permissions).toContain('activeTab')
        expect(permissions).toContain('storage')
    })

    test('manifest has background service worker', () => {
        const background = manifest.background as Record<string, string>
        expect(background?.service_worker).toBe('background.js')
        expect(existsSync(join(extensionDir, background.service_worker))).toBe(
            true,
        )
    })

    test('manifest has popup action', () => {
        const action = manifest.action as Record<string, unknown>
        expect(action?.default_popup).toBe('index.html')
        expect(existsSync(join(extensionDir, 'index.html'))).toBe(true)
    })

    test('content scripts reference existing files', () => {
        const contentScripts = manifest.content_scripts as Array<{
            js: string[]
            matches: string[]
        }>
        expect(contentScripts).toBeDefined()
        expect(contentScripts.length).toBeGreaterThan(0)

        for (const script of contentScripts) {
            expect(script.matches.length).toBeGreaterThan(0)
            for (const jsFile of script.js) {
                expect(existsSync(join(extensionDir, jsFile))).toBe(true)
            }
        }
    })

    test('all icons referenced in manifest exist', () => {
        const icons = manifest.icons as Record<string, string>
        expect(icons).toBeDefined()

        for (const [size, path] of Object.entries(icons)) {
            expect(Number(size)).toBeGreaterThan(0)
            // Icon paths start with / in manifest
            const iconPath = join(extensionDir, path.replace(/^\//, ''))
            expect(existsSync(iconPath)).toBe(true)
        }
    })
})

test.describe('Extension — Supported Sites Validation', () => {
    let supported: Array<Record<string, string>>

    test.beforeAll(() => {
        const raw = readFileSync(join(extensionDir, 'supported.json'), 'utf-8')
        const data = JSON.parse(raw)
        supported = data.supported
    })

    test('supported.json has entries', () => {
        expect(supported).toBeDefined()
        expect(supported.length).toBeGreaterThan(0)
    })

    test('each supported site has required selectors', () => {
        for (const site of supported) {
            expect(site.domain).toBeTruthy()
            expect(site.couponInput).toBeTruthy()
            expect(site.couponSubmit).toBeTruthy()
            expect(site.priceContainer).toBeTruthy()
        }
    })

    test('supported sites include expected domains', () => {
        const domains = supported.map(s => s.domain)
        expect(domains).toContain('amazon.com')
        expect(domains).toContain('ebay.com')
    })

    test('content script matches align with supported domains', () => {
        const manifest = JSON.parse(
            readFileSync(join(extensionDir, 'manifest.json'), 'utf-8'),
        )
        const contentScripts = manifest.content_scripts as Array<{
            matches: string[]
        }>
        const matchPatterns = contentScripts.flatMap(cs => cs.matches)

        for (const site of supported) {
            const domainInPattern = matchPatterns.some(pattern =>
                pattern.includes(site.domain),
            )
            expect(domainInPattern).toBe(true)
        }
    })
})

test.describe('Extension — File Integrity', () => {
    const requiredFiles = [
        'manifest.json',
        'index.html',
        'popup.js',
        'background.js',
        'inject.js',
        // F-008 split shared-utils.js into the 6 files below (load order matters
        // in the manifests; alphabetical here — this test only checks existence).
        'caramel-base.js',
        'dom-utils.js',
        'store-detect.js',
        'coupon-apply.js',
        'coupon-fetch.js',
        'coupon-runner.js',
        // F-006 codegen output, loaded before the split files.
        'coupon-constants.generated.js',
        'UI-helpers.js',
        'supported.json',
        'assets/styles.css',
    ]

    for (const file of requiredFiles) {
        test(`${file} exists`, () => {
            expect(existsSync(join(extensionDir, file))).toBe(true)
        })
    }

    test('Firefox manifest exists', () => {
        expect(existsSync(join(extensionDir, 'manifest-firefox.json'))).toBe(
            true,
        )
    })

    test('Firefox manifest is valid JSON', () => {
        const raw = readFileSync(
            join(extensionDir, 'manifest-firefox.json'),
            'utf-8',
        )
        expect(() => JSON.parse(raw)).not.toThrow()
    })
})
