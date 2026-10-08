import FaqSection from '@/components/FaqSection'
import { DISCORD_INVITE_URL } from '@/lib/brandLinks'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

// Every "Discord" link Caramel ships opens the community server through ONE
// permanent invite, DISCORD_INVITE_URL in src/lib/brandLinks.ts. Until
// 2026-10-08 the open-source section typed the invite out twice, in the
// discord.com/invite form, beside the brandLinks copy; /support, the FAQ and
// the mobile menu did not offer it at all.

const APP_ROOT = path.resolve(__dirname, '..', '..')
const REPO_ROOT = path.resolve(APP_ROOT, '..', '..')
const DECLARATION = path.join(APP_ROOT, 'src', 'lib', 'brandLinks.ts')

/** Any Discord invite, in either form Discord hands out. */
const INVITE =
    /https:\/\/(?:discord\.gg|discord(?:app)?\.com\/invite)\/[A-Za-z0-9-]+/g

const SKIPPED_DIRS = new Set([
    'node_modules',
    '.next',
    '.output',
    '.wxt',
    'dist',
    'coverage',
    'test-results',
    'playwright-report',
])

function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory())
            return SKIPPED_DIRS.has(entry.name) ? [] : sourceFiles(full)
        return /\.(?:[cm]?[jt]sx?|html)$/.test(entry.name) &&
            !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)
            ? [full]
            : []
    })
}

const read = (relativeToApp: string) =>
    readFileSync(path.join(APP_ROOT, relativeToApp), 'utf8')

const IMPORTS_THE_INVITE =
    /import \{[^}]*\bDISCORD_INVITE_URL\b[^}]*\} from '@\/lib\/brandLinks'/

describe('the Caramel Discord invite', () => {
    it('is the permanent discord.gg invite to the Caramel server', () => {
        expect(DISCORD_INVITE_URL).toBe('https://discord.gg/2vVVrQ5CEB')
    })

    it('is typed out only in brandLinks.ts: no other invite and no second copy in the app, the extension or the UI package', () => {
        const roots = [
            path.join(APP_ROOT, 'src'),
            path.join(REPO_ROOT, 'apps', 'caramel-extension'),
            path.join(REPO_ROOT, 'packages', 'caramel-ui', 'src'),
        ].filter(existsSync)
        expect(roots).toHaveLength(3)

        const strays = roots
            .flatMap(sourceFiles)
            .filter(file => file !== DECLARATION)
            .flatMap(file =>
                Array.from(
                    readFileSync(file, 'utf8').matchAll(INVITE),
                    match =>
                        `${path.relative(REPO_ROOT, file).split(path.sep).join('/')}: ${match[0]}`,
                ),
            )
        expect(strays).toEqual([])
        // A cold file cache (a fresh Windows checkout) can take ~8s to walk
        // these trees; warm it is well under 1s.
    }, 20_000)

    it.each([
        'src/layouts/Footer/Footer.tsx',
        'src/components/OpenSourceSection.tsx',
        'src/app/(marketing)/support/page.tsx',
        'src/components/FaqSection.tsx',
        'src/layouts/Header/Header.tsx',
    ])('%s links it from brandLinks', file => {
        expect(read(file)).toMatch(IMPORTS_THE_INVITE)
    })

    it('/support offers it under the support form, opening in a new tab', () => {
        const page = read('src/app/(marketing)/support/page.tsx')
        const afterForm = page.slice(page.indexOf('<SupportForm'))
        expect(afterForm).toContain('href={DISCORD_INVITE_URL}')
        expect(afterForm).toContain('target="_blank"')
        expect(afterForm).toContain('Join our Discord')
    })

    it('the mobile menu carries a labelled Discord row', () => {
        const header = read('src/layouts/Header/Header.tsx')
        const menuStart = header.indexOf('{isMenuOpen && (')
        expect(menuStart).toBeGreaterThan(-1)
        const menu = header.slice(menuStart)
        expect(menu).toContain('href={DISCORD_INVITE_URL}')
        expect(menu).toContain('Join our Discord')
    })

    it('the FAQ closes by offering the Discord beside contact support', () => {
        const html = renderToStaticMarkup(<FaqSection />)
        const anchor = html.match(
            new RegExp(
                `<a[^>]*href="${DISCORD_INVITE_URL}"[^>]*>[\\s\\S]*?</a>`,
            ),
        )?.[0]
        expect(anchor, 'no Discord anchor in the FAQ').toBeDefined()
        expect(anchor).toContain('target="_blank"')
        expect(anchor).toMatch(/rel="noopener noreferrer"/)
        expect(anchor).toContain('Ask on our Discord')
        expect(html).toContain('href="/support"')
    })
})
