import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'
import { initCaramelBase } from '../caramel-base.js'
import { ToastProvider } from '../entrypoints/popup/components/toast'
import { UsageDiagnosticsCard } from '../entrypoints/popup/components/UsageDiagnosticsCard'
import type { AppApi } from '../entrypoints/popup/types'
import { SettingsView } from '../entrypoints/popup/views/SettingsView'

/**
 * The opt-in surfaces for anonymous usage diagnostics: the one-time popup card
 * ("Help improve Caramel?") and the Settings toggle. Off by default; "Allow"
 * (or switching the toggle on) is the explicit yes; on Firefox the browser's
 * own data-collection prompt comes first and a refusal records nothing.
 */
let syncData: Record<string, any>
let localData: Record<string, any>
let permissions: { request: any; contains: any }
let runtimeUrl: string

const CONSENT_KEY = 'usageDiagnosticsConsent'
const ID_KEY = 'caramel_usage_diagnostics_id'
const accepted = () => ({
    choice: 'accepted',
    at: '2026-10-15T12:00:00.000Z',
    promptVersion: 1,
})

function installChromeStub() {
    const cache = new WeakMap()
    const wrap = (target: any): any => {
        if (cache.has(target)) return cache.get(target)
        const proxy = new Proxy(target, {
            get(obj: any, prop) {
                if (prop === 'then' || typeof prop === 'symbol')
                    return undefined
                if (!(prop in obj)) obj[prop] = wrap(function () {})
                return obj[prop]
            },
            apply: () => undefined,
        })
        cache.set(target, proxy)
        return proxy
    }
    const stub = wrap(function chromeStubRoot() {})
    const area = (data: () => Record<string, any>) => ({
        get: (keys: unknown, cb: any) =>
            cb(
                Object.fromEntries(
                    ([] as string[])
                        .concat(keys as string[])
                        .map(k => [k, data()[k]]),
                ),
            ),
        set: (items: Record<string, unknown>, cb: any) => {
            Object.assign(data(), items)
            cb?.()
        },
        remove: (keys: unknown, cb: any) => {
            for (const k of ([] as string[]).concat(keys as string[]))
                delete data()[k]
            cb?.()
        },
    })
    stub.storage.sync = area(() => syncData)
    stub.storage.local = area(() => localData)
    stub.runtime.lastError = undefined
    stub.runtime.getURL = () => runtimeUrl
    ;(globalThis as any).chrome = stub
    ;(globalThis as any).browser = undefined
    ;(window as any).chrome = stub
    ;(window as any).browser = undefined
    initCaramelBase()
    return stub
}

const makeApi = (): AppApi => ({
    openSignIn: vi.fn(),
    closeOverlay: vi.fn(),
    refresh: vi.fn(),
})

const renderCard = () =>
    render(
        <ToastProvider>
            <UsageDiagnosticsCard />
        </ToastProvider>,
    )

const renderSettings = () =>
    render(
        <ToastProvider>
            <SettingsView
                user={null}
                domain="www.example.com"
                api={makeApi()}
            />
        </ToastProvider>,
    )

const asFirefox = () => {
    runtimeUrl = 'moz-extension://abc/'
    ;(window as any).browser = { permissions }
    ;(globalThis as any).browser = { permissions }
}

beforeAll(() => {
    installChromeStub()
})

beforeEach(() => {
    syncData = {}
    localData = {}
    runtimeUrl = 'chrome-extension://abc/'
    permissions = {
        request: vi.fn(async () => true),
        contains: vi.fn(async () => true),
    }
})

afterEach(() => {
    ;(globalThis as any).browser = undefined
    ;(window as any).browser = undefined
})

describe('the one-time "Help improve Caramel?" card', () => {
    it('asks with the approved wording and two equal buttons, writing nothing until pressed', async () => {
        renderCard()

        expect(
            await screen.findByRole('heading', {
                name: 'Help improve Caramel?',
            }),
        ).toBeInTheDocument()
        expect(
            screen.getByText(
                "Send anonymous usage diagnostics, such as whether the code-sharing offer appeared on a supported store and why a code wasn't shared. Never your codes, your browsing history, or anything that identifies you. You can change this anytime in Settings.",
            ),
        ).toBeInTheDocument()
        const allow = screen.getByRole('button', { name: 'Allow' })
        const decline = screen.getByRole('button', { name: 'No thanks' })
        // Same class: declining is exactly as easy as accepting.
        expect(allow.className).toBe(decline.className)
        expect(syncData[CONSENT_KEY]).toBeUndefined()
        expect(localData[ID_KEY]).toBeUndefined()
    })

    it('Allow records an explicit acceptance, mints the id, and the card goes away', async () => {
        renderCard()
        await userEvent.click(
            await screen.findByRole('button', { name: 'Allow' }),
        )

        await waitFor(() =>
            expect(syncData[CONSENT_KEY]).toMatchObject({
                choice: 'accepted',
                promptVersion: 1,
            }),
        )
        expect(localData[ID_KEY]).toMatch(/^[0-9a-f-]{36}$/)
        await waitFor(() =>
            expect(
                screen.queryByRole('heading', {
                    name: 'Help improve Caramel?',
                }),
            ).not.toBeInTheDocument(),
        )
        // Not Firefox: the browser was never asked for anything.
        expect(permissions.request).not.toHaveBeenCalled()
    })

    it('No thanks records a decline, mints no id, and the card goes away for good', async () => {
        renderCard()
        await userEvent.click(
            await screen.findByRole('button', { name: 'No thanks' }),
        )

        await waitFor(() =>
            expect(syncData[CONSENT_KEY]).toMatchObject({ choice: 'declined' }),
        )
        expect(localData[ID_KEY]).toBeUndefined()
        await waitFor(() =>
            expect(
                screen.queryByRole('heading', {
                    name: 'Help improve Caramel?',
                }),
            ).not.toBeInTheDocument(),
        )
    })

    it.each([
        ['accepted', accepted()],
        ['declined', { ...accepted(), choice: 'declined' }],
    ])('an already %s shopper is not asked again', async (_label, stored) => {
        syncData[CONSENT_KEY] = stored
        renderCard()
        await new Promise(r => setTimeout(r, 50))

        expect(
            screen.queryByRole('heading', { name: 'Help improve Caramel?' }),
        ).not.toBeInTheDocument()
    })

    it('a record for an older prompt version asks again', async () => {
        syncData[CONSENT_KEY] = { ...accepted(), promptVersion: 0 }
        renderCard()

        expect(
            await screen.findByRole('heading', {
                name: 'Help improve Caramel?',
            }),
        ).toBeInTheDocument()
    })

    it('Firefox: Allow asks the browser for technicalAndInteraction first, then records', async () => {
        asFirefox()
        renderCard()
        await userEvent.click(
            await screen.findByRole('button', { name: 'Allow' }),
        )

        expect(permissions.request).toHaveBeenCalledWith({
            data_collection: ['technicalAndInteraction'],
        })
        await waitFor(() =>
            expect(syncData[CONSENT_KEY]).toMatchObject({ choice: 'accepted' }),
        )
    })

    it('Firefox: a refused browser prompt records NOTHING and tells the shopper', async () => {
        asFirefox()
        permissions.request.mockResolvedValue(false)
        renderCard()
        await userEvent.click(
            await screen.findByRole('button', { name: 'Allow' }),
        )

        expect(
            await screen.findByText(/browser did not allow it/),
        ).toBeInTheDocument()
        expect(syncData[CONSENT_KEY]).toBeUndefined()
        expect(localData[ID_KEY]).toBeUndefined()
        // Still on screen: they can say No thanks instead.
        expect(
            screen.getByRole('button', { name: 'No thanks' }),
        ).toBeInTheDocument()
    })

    it('when the choice cannot be saved the shopper is told and nothing is recorded', async () => {
        const stub = (globalThis as any).chrome
        const realSet = stub.storage.sync.set
        stub.storage.sync.set = (_items: unknown, cb: any) => {
            stub.runtime.lastError = { message: 'quota exceeded' }
            cb()
            stub.runtime.lastError = undefined
        }
        renderCard()
        await userEvent.click(
            await screen.findByRole('button', { name: 'Allow' }),
        )

        expect(
            await screen.findByText(/Couldn’t change that setting/),
        ).toBeInTheDocument()
        expect(syncData[CONSENT_KEY]).toBeUndefined()
        expect(localData[ID_KEY]).toBeUndefined()
        stub.storage.sync.set = realSet
    })
})

describe('the Settings toggle "Send anonymous usage diagnostics"', () => {
    const toggle = () =>
        screen.findByRole('checkbox', {
            name: /Send anonymous usage diagnostics/,
        })

    it('is OFF by default and writes nothing', async () => {
        renderSettings()

        expect(await toggle()).not.toBeChecked()
        expect(syncData[CONSENT_KEY]).toBeUndefined()
    })

    it('turning it on records an explicit acceptance and mints the id; turning it off declines and deletes the id', async () => {
        renderSettings()
        const box = await toggle()

        await userEvent.click(box)
        await waitFor(() =>
            expect(syncData[CONSENT_KEY]).toMatchObject({ choice: 'accepted' }),
        )
        expect(localData[ID_KEY]).toBeTruthy()
        expect(box).toBeChecked()

        await userEvent.click(box)
        await waitFor(() =>
            expect(syncData[CONSENT_KEY]).toMatchObject({ choice: 'declined' }),
        )
        expect(localData[ID_KEY]).toBeUndefined()
        expect(box).not.toBeChecked()
    })

    it('reads an accepted record back as on', async () => {
        syncData[CONSENT_KEY] = accepted()
        renderSettings()

        expect(await toggle()).toBeChecked()
    })

    it('Firefox: accepted but the browser grant revoked shows OFF (it would send nothing)', async () => {
        asFirefox()
        permissions.contains.mockResolvedValue(false)
        syncData[CONSENT_KEY] = accepted()
        renderSettings()

        expect(await toggle()).not.toBeChecked()
    })

    it('Firefox: a refused browser prompt leaves it off and records nothing', async () => {
        asFirefox()
        permissions.request.mockResolvedValue(false)
        renderSettings()
        const box = await toggle()
        await userEvent.click(box)

        await waitFor(() => expect(box).not.toBeChecked())
        expect(syncData[CONSENT_KEY]).toBeUndefined()
        expect(
            await screen.findByText(/browser did not allow it/),
        ).toBeInTheDocument()
    })
})
