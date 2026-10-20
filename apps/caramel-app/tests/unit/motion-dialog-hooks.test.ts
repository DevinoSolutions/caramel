import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Motion pass 3/3: the soft dialog/FAQ/growth-card entrances are CSS classes
// in styles/globals.css; each element only animates if it carries its hook.
const srcDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../src',
)
const read = (file: string): string =>
    fs.readFileSync(path.join(srcDir, file), 'utf8')

describe('motion pass 3/3: entrance class hooks', () => {
    it.each([
        ['components/support/SupportDialog.tsx', 'motion-dialog'],
        ['components/profile/ConfirmDialog.tsx', 'motion-dialog'],
        ['components/FaqSection.tsx', 'motion-faq-answer'],
        ['components/growth/GrowthPromptCard.tsx', 'motion-growth-card'],
    ])('%s carries %s', (file, hook) => {
        expect(read(file)).toContain(hook)
    })

    it.each(['motion-dialog', 'motion-faq-answer', 'motion-growth-card'])(
        'globals.css defines .%s',
        hook => {
            expect(read('styles/globals.css')).toContain(`.${hook}`)
        },
    )
})
