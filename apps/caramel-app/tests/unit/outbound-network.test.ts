import dns from 'node:dns'
import { readFileSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { configureOutboundNetwork } from '@/lib/outboundNetwork'

// The production shape: a dual-stack host whose IPv4 address is slow to answer
// and whose IPv6 address fails at once (the server has no IPv6 route). The
// IPv4 address here is TEST-NET-1 (RFC 5737), which nothing answers, so a
// connect to it stays pending; ::1 on a closed port refuses immediately, as
// ENETUNREACH does in production.
const SLOW_IPV4 = '192.0.2.1'
const REFUSING_IPV6 = '::1'

type LookupAddress = { address: string; family: number }

function dualStackLookup(
    _host: string,
    options: { all?: boolean },
    callback: (
        error: Error | null,
        address: string | LookupAddress[],
        family?: number,
    ) => void,
) {
    const addresses = [
        { address: SLOW_IPV4, family: 4 },
        { address: REFUSING_IPV6, family: 6 },
    ]
    if (options.all) callback(null, addresses)
    else callback(null, addresses[0].address, addresses[0].family)
}

// Connects and reports what happened within `waitMs`: the error, or "pending".
function connectOutcome(waitMs: number): Promise<string> {
    return new Promise(resolve => {
        const socket = net.connect({
            host: 'dual-stack.test',
            port: 9,
            lookup: dualStackLookup as never,
        })
        const timer = setTimeout(() => {
            socket.destroy()
            resolve('pending')
        }, waitMs)
        socket.on(
            'error',
            (
                error: NodeJS.ErrnoException & {
                    errors?: NodeJS.ErrnoException[]
                },
            ) => {
                clearTimeout(timer)
                // Several attempts fail as one AggregateError carrying each.
                const inner = error.errors
                    ? error.errors.map(e => e.code)
                    : [error.code]
                resolve(`error:${inner.join(',')}`)
            },
        )
        socket.on('connect', () => {
            clearTimeout(timer)
            socket.destroy()
            resolve('connected')
        })
    })
}

describe('outbound connections try IPv4 without a 250 ms cut-off', () => {
    let savedFamily: boolean
    let savedOrder: ReturnType<typeof dns.getDefaultResultOrder>

    beforeEach(() => {
        savedFamily = net.getDefaultAutoSelectFamily()
        savedOrder = dns.getDefaultResultOrder()
    })
    afterEach(() => {
        net.setDefaultAutoSelectFamily(savedFamily)
        dns.setDefaultResultOrder(savedOrder)
    })

    it('Node default: a slow IPv4 connect is abandoned at 250 ms and the request fails', async () => {
        net.setDefaultAutoSelectFamily(true)
        net.setDefaultAutoSelectFamilyAttemptTimeout(250)
        const outcome = await connectOutcome(1500)
        // The exact production error: IPv4 ETIMEDOUT (cut off), then the IPv6
        // attempt failing at once.
        expect(outcome).toBe('error:ETIMEDOUT,ECONNREFUSED')
    })

    it('configured: the same IPv4 connect is still waiting for its answer after 1.5 s', async () => {
        configureOutboundNetwork()
        expect(await connectOutcome(1500)).toBe('pending')
    })

    it('the server applies it at boot, before Sentry or any other import can connect out', () => {
        const source = readFileSync(
            join(__dirname, '../../src/instrumentation.ts'),
            'utf8',
        )
        const configured = source.indexOf('configureOutboundNetwork()')
        expect(configured).toBeGreaterThan(-1)
        // After the edge-runtime return (node:net does not exist there), and
        // before the first server-side import.
        expect(configured).toBeGreaterThan(
            source.indexOf("NEXT_RUNTIME === 'edge'"),
        )
        expect(configured).toBeLessThan(
            source.indexOf("import('../sentry.server.config')"),
        )
    })

    it('reports the settings it applied', () => {
        expect(configureOutboundNetwork()).toEqual({
            autoSelectFamily: false,
            resultOrder: 'ipv4first',
        })
        expect(net.getDefaultAutoSelectFamily()).toBe(false)
        expect(dns.getDefaultResultOrder()).toBe('ipv4first')
    })
})
