import {
    connectErrorMessage,
    disconnectErrorMessage,
    signInMethodRows,
} from '@/lib/auth/signInMethodRules'
import { describe, expect, it } from 'vitest'

// /profile > "Sign-in methods": which rows show, which can Connect, and that
// the last way into the account can never be disconnected.

const rowById = (rows: ReturnType<typeof signInMethodRows>, id: string) => {
    const row = rows.find(candidate => candidate.id === id)
    if (!row) throw new Error(`no row ${id}`)
    return row
}

describe('signInMethodRows', () => {
    it('lists Google, Apple and the password in that order and offers Connect for each missing provider', () => {
        const rows = signInMethodRows(['credential'])
        expect(
            rows.map(row => [row.id, row.connected, row.canConnect]),
        ).toEqual([
            ['google', false, true],
            ['apple', false, true],
            ['credential', true, false],
        ])
    })

    it('keeps the only connected method disabled, and frees it once a second one exists', () => {
        expect(rowById(signInMethodRows(['apple']), 'apple')).toMatchObject({
            isLastMethod: true,
            canDisconnect: false,
        })
        expect(
            rowById(signInMethodRows(['apple', 'google']), 'apple'),
        ).toMatchObject({ isLastMethod: false, canDisconnect: true })
    })

    it('never offers Connect for a missing password and counts an unknown provider as a way in', () => {
        const rows = signInMethodRows(['microsoft', 'google'])
        expect(rowById(rows, 'credential')).toMatchObject({
            connected: false,
            canConnect: false,
        })
        expect(rowById(rows, 'microsoft')).toMatchObject({
            connected: true,
            canDisconnect: true,
        })
    })
})

describe('sign-in method error sentences', () => {
    it('name an account taken by someone else, an unverified address and a stale session distinctly', () => {
        expect(
            connectErrorMessage('account_already_linked_to_different_user'),
        ).toMatch(/different Caramel account/)
        expect(connectErrorMessage('email_not_verified')).toMatch(
            /no verified email/,
        )
        expect(connectErrorMessage('anything_else')).toMatch(/try again/)
        expect(disconnectErrorMessage('SESSION_NOT_FRESH', 'Apple')).toMatch(
            /sign out and back in, then disconnect Apple/,
        )
        expect(
            disconnectErrorMessage('FAILED_TO_UNLINK_LAST_ACCOUNT', 'Apple'),
        ).toMatch(/only way to sign in/)
    })
})
