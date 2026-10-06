import { beforeEach, describe, expect, it, vi } from 'vitest'

// captureServerEvent / aliasServerDistinctId / getServerPosthogProjectToken in
// ENABLED mode. posthog-node, the env modules and Sentry are TEST DOUBLES
// (…Mock): nothing here reaches a network. (posthogServer.test.ts keeps the
// disabled-mode contract with the real env.)

const { posthogNodeMock } = vi.hoisted(() => {
    const captureImmediate = vi.fn()
    const aliasImmediate = vi.fn()
    return {
        posthogNodeMock: {
            captureImmediate,
            aliasImmediate,
            PostHog: vi.fn(function PostHogMock() {
                return { captureImmediate, aliasImmediate }
            }),
        },
    }
})
vi.mock('posthog-node', () => ({ PostHog: posthogNodeMock.PostHog }))

const { envMock } = vi.hoisted(() => ({
    envMock: { dataset: 'production' as 'production' | 'e2e' | 'disabled' },
}))
vi.mock('@/lib/env', () => ({
    env: {
        get POSTHOG_DATASET() {
            return envMock.dataset
        },
    },
}))
vi.mock('@/lib/env.client', () => ({
    APP_VERSION: '9.9.9-test',
    clientEnv: {
        NEXT_PUBLIC_POSTHOG_HOST: 'https://posthog.devino.ca',
        NEXT_PUBLIC_POSTHOG_KEY: 'phc_prod_token',
        NEXT_PUBLIC_POSTHOG_E2E_TEST_PROJECT_HOST: undefined,
        NEXT_PUBLIC_POSTHOG_E2E_TEST_PROJECT_CAPTURE_TOKEN: undefined,
    },
}))

const { sentryMock } = vi.hoisted(() => ({
    sentryMock: { captureException: vi.fn() },
}))
vi.mock('@sentry/nextjs', () => sentryMock)

import {
    aliasServerDistinctId,
    captureServerEvent,
    getServerPosthogProjectToken,
} from '@/lib/analytics/posthogServer'

const UUID = '11111111-1111-4111-8111-111111111111'

beforeEach(() => {
    envMock.dataset = 'production'
    posthogNodeMock.captureImmediate.mockReset().mockResolvedValue(undefined)
    posthogNodeMock.aliasImmediate.mockReset().mockResolvedValue(undefined)
    sentryMock.captureException.mockReset()
})

describe('captureServerEvent uuid', () => {
    it('without a uuid it sends none and no $insert_id', async () => {
        await expect(
            captureServerEvent({ event: 'x', distinctId: 'd' }),
        ).resolves.toBe(true)
        const sent = posthogNodeMock.captureImmediate.mock.calls[0]![0]
        expect(sent).not.toHaveProperty('uuid')
        expect(sent.properties).not.toHaveProperty('$insert_id')
    })

    it('with a uuid it is the event uuid AND $insert_id (the dedupe key)', async () => {
        await captureServerEvent({
            event: 'extension_installed',
            distinctId: 'd',
            uuid: UUID,
            properties: { store: 'chrome' },
        })
        const sent = posthogNodeMock.captureImmediate.mock.calls[0]![0]
        expect(sent).toMatchObject({
            event: 'extension_installed',
            distinctId: 'd',
            uuid: UUID,
            properties: {
                store: 'chrome',
                $insert_id: UUID,
                app_id: 'caramel',
                environment: 'production',
            },
        })
    })

    it('a send failure is reported to Sentry and returned as false, never thrown', async () => {
        const failure = new Error('posthog unreachable')
        posthogNodeMock.captureImmediate.mockRejectedValue(failure)
        await expect(
            captureServerEvent({ event: 'x', distinctId: 'd' }),
        ).resolves.toBe(false)
        expect(sentryMock.captureException).toHaveBeenCalledWith(failure, {
            tags: { operation: 'posthog_capture_server' },
        })
    })
})

describe('aliasServerDistinctId', () => {
    it('links the anonymous id to the user id', async () => {
        await expect(
            aliasServerDistinctId({
                anonymousDistinctId: 'anon-1',
                userId: 'user-1',
            }),
        ).resolves.toBe(true)
        expect(posthogNodeMock.aliasImmediate).toHaveBeenCalledWith({
            distinctId: 'user-1',
            alias: 'anon-1',
        })
    })

    it('is false (and sends nothing) when capture is disabled', async () => {
        envMock.dataset = 'disabled'
        await expect(
            aliasServerDistinctId({
                anonymousDistinctId: 'anon-1',
                userId: 'user-1',
            }),
        ).resolves.toBe(false)
        expect(posthogNodeMock.aliasImmediate).not.toHaveBeenCalled()
    })

    it('a failure is reported to Sentry and returned as false', async () => {
        const failure = new Error('alias failed')
        posthogNodeMock.aliasImmediate.mockRejectedValue(failure)
        await expect(
            aliasServerDistinctId({
                anonymousDistinctId: 'anon-1',
                userId: 'user-1',
            }),
        ).resolves.toBe(false)
        expect(sentryMock.captureException).toHaveBeenCalledWith(failure, {
            tags: { operation: 'posthog_alias_server' },
        })
    })
})

describe('getServerPosthogProjectToken', () => {
    it('is the production capture token when enabled and null when disabled', () => {
        expect(getServerPosthogProjectToken()).toBe('phc_prod_token')
        envMock.dataset = 'disabled'
        expect(getServerPosthogProjectToken()).toBeNull()
    })
})
