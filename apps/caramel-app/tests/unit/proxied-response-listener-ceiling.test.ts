import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { raiseListenerCeilingForProxiedResponses } from '@/lib/proxiedResponseListenerCeiling'

// Next's external-rewrite proxy leaves 11 `close` listeners on one proxied
// ServerResponse (measured on prod 2026-10-20, one warning per /_t/k3v
// request). These pin that the ceiling clears that count, that it never lowers
// a ceiling the process already raised, and that register() calls it.
const CLOSE_LISTENERS_PER_PROXIED_RESPONSE = 11

let original: number

beforeEach(() => {
    original = EventEmitter.defaultMaxListeners
})

afterEach(() => {
    EventEmitter.defaultMaxListeners = original
})

describe('the listener ceiling for proxied responses', () => {
    it('lets a proxied response carry its 11 close listeners without a leak warning', async () => {
        EventEmitter.defaultMaxListeners = 10
        raiseListenerCeilingForProxiedResponses()

        const warnings: Error[] = []
        const onWarning = (warning: Error) => warnings.push(warning)
        process.on('warning', onWarning)
        try {
            const response = new EventEmitter()
            for (let i = 0; i < CLOSE_LISTENERS_PER_PROXIED_RESPONSE; i += 1) {
                response.on('close', () => undefined)
            }
            expect(response.listenerCount('close')).toBe(
                CLOSE_LISTENERS_PER_PROXIED_RESPONSE,
            )
            // process.emitWarning delivers on the next tick.
            await new Promise(resolve => setImmediate(resolve))
        } finally {
            process.off('warning', onWarning)
        }
        expect(
            warnings.filter(w => w.name === 'MaxListenersExceededWarning'),
        ).toEqual([])
    })

    it('still warns on a real pile-up past the raised ceiling', async () => {
        EventEmitter.defaultMaxListeners = 10
        const ceiling = raiseListenerCeilingForProxiedResponses()
        expect(ceiling).toBe(20)

        const warnings: Error[] = []
        const onWarning = (warning: Error) => warnings.push(warning)
        process.on('warning', onWarning)
        try {
            const emitter = new EventEmitter()
            for (let i = 0; i <= ceiling; i += 1) {
                emitter.on('close', () => undefined)
            }
            await new Promise(resolve => setImmediate(resolve))
        } finally {
            process.off('warning', onWarning)
        }
        expect(
            warnings.filter(w => w.name === 'MaxListenersExceededWarning'),
        ).toHaveLength(1)
    })

    it('never lowers a ceiling the process already raised further', () => {
        EventEmitter.defaultMaxListeners = 50
        expect(raiseListenerCeilingForProxiedResponses()).toBe(50)
    })
})

describe('register() raises it in the Node runtime', () => {
    it('instrumentation.ts calls the ceiling after the edge return', () => {
        const source = readFileSync(
            join(__dirname, '..', '..', 'src', 'instrumentation.ts'),
            'utf8',
        )
        const edgeReturn = source.indexOf("process.env.NEXT_RUNTIME === 'edge'")
        const call = source.indexOf('raiseListenerCeilingForProxiedResponses()')
        expect(source).toContain('@/lib/proxiedResponseListenerCeiling')
        expect(edgeReturn).toBeGreaterThan(-1)
        expect(call).toBeGreaterThan(edgeReturn)
    })
})
