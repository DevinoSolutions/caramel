import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Pins the things the iOS container app (apps/caramel-apple) copies from this
// package, so a drift fails here instead of shipping:
//  - the Safari "Always Allow on Every Website" onboarding copy
//    (SafariAllSitesSteps.tsx is the source; OnboardingView.swift repeats it),
//  - the brand AppIcon (a byte copy of brand/generated/ios),
//  - the background-task identifier named in both Swift and project.yml.
const read = (relative, encoding) =>
    readFileSync(new URL(relative, import.meta.url), encoding)

/** The text a reader sees: tags dropped, entities decoded, whitespace collapsed. */
function visibleText(jsx) {
    return jsx
        .replace(/<[^>]+>/g, '')
        .replace(/&gt;/g, '>')
        .replace(/\{' '\}/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}

describe('apple container parity', () => {
    it('onboarding repeats the Safari every-website route from SafariAllSitesSteps', () => {
        const tsx = visibleText(
            read(
                '../entrypoints/popup/components/SafariAllSitesSteps.tsx',
                'utf8',
            ),
        )
        const swift = read(
            '../../caramel-apple/App/Features/Onboarding/OnboardingView.swift',
            'utf8',
        )
        const iphoneRoute =
            'tap the page menu at the left of the address bar, choose Caramel, then Always Allow > Always Allow on Every Website'
        expect(tsx).toContain(iphoneRoute)
        expect(swift).toContain(iphoneRoute)
    })

    it('the app icon is a byte copy of the generated brand iOS icon', () => {
        const master = read(
            '../brand/generated/ios/AppIcon.appiconset/icon-1024.png',
        )
        const app = read(
            '../../caramel-apple/App/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png',
        )
        expect(Buffer.compare(master, app)).toBe(0)
    })

    it('the alerts background task id matches between Swift and project.yml', () => {
        const swift = read('../../caramel-apple/App/AppConfig.swift', 'utf8')
        const yml = read('../../caramel-apple/project.yml', 'utf8')
        const id = /alertsTaskIdentifier = "([^"]+)"/.exec(swift)?.[1]
        expect(id).toBeTruthy()
        expect(yml).toContain(`- ${id}`)
    })
})
