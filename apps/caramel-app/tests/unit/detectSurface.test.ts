import {
    appShellSuperProperties,
    canAdvertiseInstall,
    detectAppShell,
    detectSurface,
    EXTENSION_MESSAGE_TYPES,
    type SurfaceInput,
} from '@/lib/surface/detectSurface'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Fleet growth-prompts spec §A: nothing that advertises the app may render
// where the app already is. Each branch of the surface decision is pinned.

const web: SurfaceInput = {
    extensionStamp: null,
    extensionMessageSeen: false,
    displayModeStandalone: false,
    navigatorStandalone: false,
    userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15',
}

describe('detectSurface', () => {
    it('is web when nothing says otherwise', () => {
        expect(detectSurface(web)).toBe('web')
    })

    it('is extension when the <html> stamp is present, whatever its value', () => {
        expect(detectSurface({ ...web, extensionStamp: '1.4.1' })).toBe(
            'extension',
        )
        expect(detectSurface({ ...web, extensionStamp: '' })).toBe('extension')
    })

    it('is extension when the content script spoke, even without a stamp', () => {
        // Builds before the stamp only send the hello, and only while signed
        // out — still proof the extension is on this browser.
        expect(detectSurface({ ...web, extensionMessageSeen: true })).toBe(
            'extension',
        )
    })

    it('is pwa from the display-mode media query or navigator.standalone', () => {
        expect(detectSurface({ ...web, displayModeStandalone: true })).toBe(
            'pwa',
        )
        expect(detectSurface({ ...web, navigatorStandalone: true })).toBe('pwa')
    })

    it('extension wins over pwa', () => {
        expect(
            detectSurface({
                ...web,
                extensionStamp: '1.4.1',
                displayModeStandalone: true,
            }),
        ).toBe('extension')
    })

    it('accepts both message types the extension has ever posted', () => {
        expect(EXTENSION_MESSAGE_TYPES.has('caramel-ext-hello')).toBe(true)
        expect(EXTENSION_MESSAGE_TYPES.has('caramel-ext-present')).toBe(true)
    })

    it('is app-shell when the UA carries the CaramelApp suffix', () => {
        expect(
            detectSurface({
                ...web,
                userAgent:
                    'Mozilla/5.0 (iPhone) Mobile/15E148 CaramelApp/1.6.0 (ios)',
            }),
        ).toBe('app-shell')
    })

    it('app-shell beats extension and pwa', () => {
        expect(
            detectSurface({
                ...web,
                extensionStamp: '1.4.18',
                displayModeStandalone: true,
                userAgent:
                    'Mozilla/5.0 Mobile/15E148 CaramelApp/1.6.0 (android)',
            }),
        ).toBe('app-shell')
    })
})

describe('detectAppShell', () => {
    it('accepts all four platforms', () => {
        for (const p of ['ios', 'macos', 'android', 'fire'] as const) {
            const r = detectAppShell(`Test CaramelApp/1.6.0 (${p}) Safari`)
            expect(r).toEqual({ version: '1.6.0', platform: p })
        }
    })

    // T-7853 acceptance check 4
    it('rejects a missing patch version', () => {
        expect(detectAppShell('Test CaramelApp/1.6 (ios)')).toBeNull()
    })

    it('rejects a prefix without a word boundary', () => {
        expect(detectAppShell('XCaramelApp/1.6.0 (ios)')).toBeNull()
    })

    it('rejects an unknown platform', () => {
        expect(detectAppShell('Test CaramelApp/1.6.0 (windows)')).toBeNull()
    })
})

describe('canAdvertiseInstall', () => {
    it('never advertises the extension to someone running it', () => {
        expect(canAdvertiseInstall('extension')).toBe(false)
    })

    it('never advertises the extension in the app shell', () => {
        expect(canAdvertiseInstall('app-shell')).toBe(false)
    })

    it('advertises on the web and in the PWA, which has no extension', () => {
        expect(canAdvertiseInstall('web')).toBe(true)
        expect(canAdvertiseInstall('pwa')).toBe(true)
    })

    it('renders the CTA while the surface is still unresolved', () => {
        // First client render — blanking the hero for every visitor while an
        // effect runs would cost far more than a momentary CTA for the few
        // who already have the extension.
        expect(canAdvertiseInstall('unknown')).toBe(true)
    })
})

// T-10055: the shells append a SEPARATE " CaramelBuild/<build>" token after the
// CaramelApp one. Both existing detectors must keep matching a UA that has it.
describe('CaramelBuild token', () => {
    const buildUA = (platform: string) =>
        `Mozilla/5.0 (iPhone) Mobile/15E148 CaramelApp/1.6.0 (${platform}) CaramelBuild/42`

    it('is read once the CaramelApp token matched', () => {
        expect(detectAppShell(buildUA('ios'))).toEqual({
            version: '1.6.0',
            platform: 'ios',
            build: '42',
        })
    })

    it('leaves the build off a shell that predates the token', () => {
        const shell = detectAppShell('Mobile/15E148 CaramelApp/1.6.0 (ios)')
        expect(shell).toEqual({ version: '1.6.0', platform: 'ios' })
        expect(shell).not.toHaveProperty('build')
    })

    it('still detects every platform with the token present', () => {
        for (const p of ['ios', 'macos', 'android', 'fire'] as const) {
            expect(detectAppShell(buildUA(p))?.platform).toBe(p)
            expect(detectSurface({ ...web, userAgent: buildUA(p) })).toBe(
                'app-shell',
            )
        }
    })

    it('ignores a build token with no CaramelApp token', () => {
        expect(detectAppShell('Safari CaramelBuild/42')).toBeNull()
    })

    it('rejects a non-numeric or run-together build token', () => {
        const base = 'Mobile CaramelApp/1.6.0 (ios)'
        expect(detectAppShell(`${base} CaramelBuild/abc`)).not.toHaveProperty(
            'build',
        )
        expect(detectAppShell(`${base} XCaramelBuild/42`)).not.toHaveProperty(
            'build',
        )
        expect(detectAppShell(`${base} CaramelBuild/42x`)).not.toHaveProperty(
            'build',
        )
    })

    it('still matches the inline pre-hydration script in app/layout.tsx', () => {
        // The inline script is a template string, so lift its regex literal out
        // of the source and un-escape the template's doubled backslashes.
        const source = readFileSync(
            join(process.cwd(), 'src/app/layout.tsx'),
            'utf8',
        )
        const literal = /navigator\.userAgent\.match\(\/(.+?)\/\)/.exec(source)
        expect(literal).not.toBeNull()
        const inline = new RegExp(literal![1].split('\\\\').join('\\'))
        for (const p of ['ios', 'macos', 'android', 'fire']) {
            expect(inline.exec(buildUA(p))?.[1]).toBe(p)
        }
        expect(inline.exec('Mobile CaramelApp/1.6 (ios)')).toBeNull()
    })
})

describe('appShellSuperProperties', () => {
    it('carries the shell version and build next to surface and platform', () => {
        expect(
            appShellSuperProperties({
                version: '1.6.0',
                platform: 'ios',
                build: '42',
            }),
        ).toEqual({
            surface: 'app-shell',
            app_platform: 'ios',
            app_shell_version: '1.6.0',
            app_build: '42',
        })
    })

    it('omits app_build for a shell that sent none, and never touches app_version', () => {
        const props = appShellSuperProperties({
            version: '1.5.0',
            platform: 'android',
        })
        expect(props).not.toHaveProperty('app_build')
        expect(props).not.toHaveProperty('app_version')
    })
})
