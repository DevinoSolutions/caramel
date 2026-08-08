import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { userInitial } from '@/lib/userInitial'

describe('userInitial', () => {
    it('prefers the display name', () => {
        expect(userInitial({ name: 'Aladdin Bensalah', email: 'x@y.z' })).toBe(
            'A',
        )
    })

    it('falls back to the email when the account carries no name', () => {
        // The exact production case: a Google account created before social
        // sign-in wrote the provider profile, so `name` is null. The header
        // used to render a meaningless "U" here while the profile page showed
        // "A" for the same session.
        expect(userInitial({ name: null, email: 'aladdin@devino.ca' })).toBe(
            'A',
        )
    })

    it('falls back to the email when the name is only whitespace', () => {
        expect(userInitial({ name: '   ', email: 'zoe@example.com' })).toBe('Z')
    })

    it('uses U only when there is neither a name nor an email', () => {
        expect(userInitial({ name: null, email: null })).toBe('U')
        expect(userInitial({})).toBe('U')
    })

    it('uppercases a lowercase source', () => {
        expect(userInitial({ email: 'ben.amos94@hotmail.com' })).toBe('B')
    })
})

/**
 * The bug was not the fallback chain itself — it was TWO components each
 * deriving one. This is the check that keeps the helper the only derivation, so
 * the next component to show an avatar cannot quietly grow a third variant.
 */
describe('avatar letter has exactly one derivation', () => {
    const SRC = join(__dirname, '..', '..', 'src')
    const HELPER = join(SRC, 'lib', 'userInitial.ts')
    // `user.name?.charAt(0)`, `session.user.email.charAt(0)`, … — any charAt(0)
    // taken off a name/email rather than through the helper.
    const RAW_DERIVATION =
        /\b(?:name|email)\??\.(?:trim\(\)\s*\|\|\s*)?charAt\(0\)/

    function walk(dir: string): string[] {
        return readdirSync(dir).flatMap(entry => {
            const full = join(dir, entry)
            if (statSync(full).isDirectory()) return walk(full)
            return /\.(ts|tsx)$/.test(entry) ? [full] : []
        })
    }

    it('no component derives the avatar letter itself', () => {
        const offenders = walk(SRC)
            .filter(file => file !== HELPER)
            .filter(file => RAW_DERIVATION.test(readFileSync(file, 'utf8')))
            .map(file => file.slice(SRC.length + 1))

        expect(offenders).toEqual([])
    })
})
