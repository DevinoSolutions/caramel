import { resolveBrowserPosthogHosts } from '@/lib/analytics/posthogHosts'
import {
    buildTelemetryRewrites,
    isTelemetryPath,
    TELEMETRY_PATH,
} from '@/lib/analytics/telemetryProxy.mjs'
import { trailingSlashRedirectPath } from '@/lib/trailingSlash'
import { describe, expect, it } from 'vitest'

// The first-party PostHog path: ONE constant feeds the next.config rewrites
// and the browser SDK's api_host, the rewrites are only built for a real
// production host (a `.invalid` build-time placeholder must not break the
// build), and the trailing-slash middleware leaves the prefix alone because
// posthog-js POSTs to `/i/v0/e/`-style endpoints.

const HOST = 'https://posthog.devino.ca'

describe('buildTelemetryRewrites', () => {
    it('proxies static, array and the catch-all to the PostHog host, in that order', () => {
        expect(
            buildTelemetryRewrites({ dataset: 'production', host: HOST }),
        ).toEqual([
            {
                source: `${TELEMETRY_PATH}/static/:path*`,
                destination: `${HOST}/static/:path*`,
            },
            {
                source: `${TELEMETRY_PATH}/array/:path*`,
                destination: `${HOST}/array/:path*`,
            },
            {
                source: `${TELEMETRY_PATH}/:path*`,
                destination: `${HOST}/:path*`,
            },
        ])
    })

    it('uses the host origin even when the configured value has a path or trailing slash', () => {
        const rewrites = buildTelemetryRewrites({
            dataset: 'production',
            host: `${HOST}/`,
        })
        expect(rewrites.map(r => r.destination)).toEqual([
            `${HOST}/static/:path*`,
            `${HOST}/array/:path*`,
            `${HOST}/:path*`,
        ])
    })

    it.each([undefined, '', '   '])(
        'builds nothing for an empty host (%j)',
        host => {
            expect(
                buildTelemetryRewrites({ dataset: 'production', host }),
            ).toEqual([])
        },
    )

    it('builds nothing for a .invalid build-time placeholder host (DESIGN.md 2(m))', () => {
        expect(
            buildTelemetryRewrites({
                dataset: 'production',
                host: 'https://posthog.invalid',
            }),
        ).toEqual([])
        expect(
            buildTelemetryRewrites({
                dataset: 'production',
                host: 'http://build-placeholder.invalid',
            }),
        ).toEqual([])
    })

    it.each(['e2e', 'disabled', undefined])(
        'only the production dataset is proxied (dataset %j)',
        dataset => {
            expect(buildTelemetryRewrites({ dataset, host: HOST })).toEqual([])
        },
    )

    it('throws loudly on a malformed or non-http host instead of shipping a dead path', () => {
        expect(() =>
            buildTelemetryRewrites({
                dataset: 'production',
                host: 'not a url',
            }),
        ).toThrow(/NEXT_PUBLIC_POSTHOG_HOST is not a valid URL/)
        expect(() =>
            buildTelemetryRewrites({
                dataset: 'production',
                host: 'ftp://posthog.devino.ca',
            }),
        ).toThrow(/must be http\(s\)/)
    })
})

describe('isTelemetryPath', () => {
    it('matches the prefix and everything under it, nothing that merely starts with it', () => {
        expect(isTelemetryPath(TELEMETRY_PATH)).toBe(true)
        expect(isTelemetryPath(`${TELEMETRY_PATH}/`)).toBe(true)
        expect(isTelemetryPath(`${TELEMETRY_PATH}/i/v0/e/`)).toBe(true)
        expect(isTelemetryPath(`${TELEMETRY_PATH}x`)).toBe(false)
        expect(isTelemetryPath('/coupons/')).toBe(false)
    })
})

describe('resolveBrowserPosthogHosts', () => {
    it('production: api_host is the first-party path, ui_host the real PostHog host', () => {
        expect(
            resolveBrowserPosthogHosts({
                host: HOST,
                token: 'phc_x',
                environment: 'production',
            }),
        ).toEqual({ apiHost: TELEMETRY_PATH, uiHost: HOST })
    })

    it('e2e: untouched, the SDK talks straight to the test project host', () => {
        expect(
            resolveBrowserPosthogHosts({
                host: 'https://e2e.example',
                token: 'phc_e2e',
                environment: 'e2e',
            }),
        ).toEqual({ apiHost: 'https://e2e.example' })
    })
})

describe('trailingSlashRedirectPath', () => {
    it('strips a trailing slash from a page path', () => {
        expect(trailingSlashRedirectPath('/coupons/')).toBe('/coupons')
        expect(trailingSlashRedirectPath('/coupons/nike.com/')).toBe(
            '/coupons/nike.com',
        )
        expect(trailingSlashRedirectPath('/foo//')).toBe('/foo')
    })

    it('leaves already-clean paths and the root alone', () => {
        expect(trailingSlashRedirectPath('/coupons')).toBeNull()
        expect(trailingSlashRedirectPath('/')).toBeNull()
    })

    it('never redirects the telemetry prefix (a redirected POST is a lost event)', () => {
        expect(
            trailingSlashRedirectPath(`${TELEMETRY_PATH}/i/v0/e/`),
        ).toBeNull()
        expect(trailingSlashRedirectPath(`${TELEMETRY_PATH}/flags/`)).toBeNull()
        expect(trailingSlashRedirectPath(`${TELEMETRY_PATH}/`)).toBeNull()
    })
})
