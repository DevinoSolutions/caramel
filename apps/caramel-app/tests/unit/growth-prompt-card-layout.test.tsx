import GrowthPromptCard from '@/components/growth/GrowthPromptCard'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import tailwindConfig from '../../tailwind.config'

// This repo's Tailwind screens are MAX-width: `md:` means "<= 767px", not
// "from 768px up". The growth card is a bottom-right corner card on desktop
// and a full-width bottom sheet on small screens, so the corner-card classes
// must be UNPREFIXED and the sheet classes must carry `md:`. The reverse
// (the original bug) rendered a full-width bar on desktop and a corner card
// on phones. Fleet growth-prompts spec §B.

function cardClasses(): Set<string> {
    const html = renderToStaticMarkup(
        <GrowthPromptCard
            promptId="install_extension"
            content={{
                title: 'Get Caramel',
                body: 'Codes apply themselves at checkout.',
                acceptLabel: 'Add',
            }}
            onAccept={() => undefined}
            onDismiss={() => undefined}
        />,
    )
    const match = /<section[^>]*data-growth-prompt[^>]*>/.exec(html)
    const className = match && /class="([^"]*)"/.exec(match[0])
    if (!className?.[1]) throw new Error('growth card did not render')
    return new Set(className[1].split(/\s+/))
}

describe('GrowthPromptCard responsive layout', () => {
    it('relies on max-width Tailwind screens (the premise of the class split)', () => {
        const screens = tailwindConfig.theme?.screens as Record<
            string,
            { max?: string }
        >
        expect(screens.md).toEqual({ max: '767px' })
    })

    it('is the 22rem bottom-right corner card with NO breakpoint prefix (desktop)', () => {
        const classes = cardClasses()
        for (const cls of [
            'fixed',
            'bottom-6',
            'right-6',
            'w-[22rem]',
            'rounded-2xl',
        ]) {
            expect(classes.has(cls), cls).toBe(true)
        }
        // A desktop base that pins both edges is the full-width bar.
        expect(classes.has('left-0')).toBe(false)
        expect(classes.has('right-0')).toBe(false)
    })

    it('becomes the full-width bottom sheet under `md:` (<= 767px)', () => {
        const classes = cardClasses()
        for (const cls of [
            'md:bottom-0',
            'md:left-0',
            'md:right-0',
            'md:w-auto',
            'md:rounded-b-none',
        ]) {
            expect(classes.has(cls), cls).toBe(true)
        }
    })

    it('keeps the shared motion class', () => {
        expect(cardClasses().has('motion-growth-card')).toBe(true)
    })
})
