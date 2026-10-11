import { isAllowedExtensionRedirectUri } from '@/lib/auth/extensionOAuthRedirect'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// isAllowedExtensionRedirectUri is the single yes/no that decides where an
// OAuth authorization code may be sent (extensionOAuthRedirect.ts). The
// route-level suites prove the routes call it; this one pins the predicate
// itself, input shape by input shape, because every row below is a way
// someone has tried (or would try) to make a foreign destination look like
// ours. Unit-level on purpose: no route, no network.
const { envMock } = vi.hoisted(() => ({
    envMock: { CHROME_EXTENSION_ORIGIN: undefined as string | undefined },
}))
vi.mock('@/lib/env', () => ({ env: envMock }))

const CHROME_ID = 'gaimofgglbackoimfjopicmbmnlccfoe'
const EDGE_ID = 'leodahchedhnenmiengkfpmmcdendnof'
/** 32 chars of a-p, i.e. a syntactically valid ID that is NOT published. */
const UNPUBLISHED_ID = 'abcdefghijklmnopabcdefghijklmnop'
/** 32 chars outside a-p: never a valid Chromium extension ID. */
const FOREIGN_ID = 'q'.repeat(32)

beforeEach(() => {
    envMock.CHROME_EXTENSION_ORIGIN = undefined
})

describe('isAllowedExtensionRedirectUri', () => {
    const allowed: Array<[string, string]> = [
        ['the Chrome Web Store build', `https://${CHROME_ID}.chromiumapp.org/`],
        ['the Edge Add-ons build', `https://${EDGE_ID}.chromiumapp.org/`],
        [
            'a path under the allowed host',
            `https://${CHROME_ID}.chromiumapp.org/provider_cb`,
        ],
        [
            'an UPPERCASE host (URL parsing lowercases https hosts)',
            `https://${CHROME_ID.toUpperCase()}.CHROMIUMAPP.ORG/`,
        ],
        [
            'the chrome-extension:// form of an allowed ID',
            `chrome-extension://${CHROME_ID}/`,
        ],
    ]
    it.each(allowed)('accepts %s', (_label, uri) => {
        expect(isAllowedExtensionRedirectUri(uri)).toBe(true)
    })

    const refused: Array<[string, string]> = [
        ['an empty string', ''],
        ['whitespace only', '   '],
        ['a relative path', '/api/extension/oauth/redirect'],
        [
            'a trailing-dot (FQDN) host',
            `https://${CHROME_ID}.chromiumapp.org./`,
        ],
        [
            'a trailing-dot host with a path',
            `https://${CHROME_ID}.chromiumapp.org./cb`,
        ],
        [
            'an unpublished extension ID',
            `https://${UNPUBLISHED_ID}.chromiumapp.org/`,
        ],
        [
            'a subdomain in front of the allowed ID',
            `https://evil.${CHROME_ID}.chromiumapp.org/`,
        ],
        [
            'the allowed ID as a mere prefix of a longer label',
            `https://${CHROME_ID}x.chromiumapp.org/`,
        ],
        [
            'the allowed ID under a different parent domain',
            `https://${CHROME_ID}.chromiumapp.org.evil.example/`,
        ],
        [
            'a backslash that makes the real host evil.example',
            `https://evil.example\\@${CHROME_ID}.chromiumapp.org/`,
        ],
        ['a backslash-only authority', 'https:\\\\evil.example\\'],
        ['a javascript: URI', 'javascript:alert(1)'],
        [
            'a javascript: URI that names the allowed host in a comment',
            `javascript:alert(1)//${CHROME_ID}.chromiumapp.org`,
        ],
        ['a data: URI', 'data:text/html,<script>1</script>'],
        [
            'plain http to the allowed host',
            `http://${CHROME_ID}.chromiumapp.org/`,
        ],
        [
            'userinfo (user only) on the allowed host',
            `https://attacker@${CHROME_ID}.chromiumapp.org/`,
        ],
        [
            'userinfo (user:password) on the allowed host',
            `https://attacker:secret@${CHROME_ID}.chromiumapp.org/`,
        ],
        [
            'allowed host smuggled into userinfo of another host',
            `https://${CHROME_ID}.chromiumapp.org@evil.example/`,
        ],
        [
            'an explicit non-default port on the allowed host',
            `https://${CHROME_ID}.chromiumapp.org:8443/`,
        ],
        [
            'a port on the chrome-extension:// form',
            `chrome-extension://${CHROME_ID}:8080/`,
        ],
        [
            'an UPPERCASE chrome-extension:// ID (opaque hosts keep their case)',
            `chrome-extension://${CHROME_ID.toUpperCase()}/`,
        ],
        ['a plain https website', 'https://grabcaramel.com/'],
        [
            'our own /redirect route (never a code destination)',
            'https://grabcaramel.com/api/extension/oauth/redirect',
        ],
    ]
    it.each(refused)('refuses %s', (_label, uri) => {
        expect(isAllowedExtensionRedirectUri(uri)).toBe(false)
    })

    describe('CHROME_EXTENSION_ORIGIN (a deployment-local unpacked build)', () => {
        it('a well-formed origin admits exactly that ID, and nothing else', () => {
            envMock.CHROME_EXTENSION_ORIGIN = `chrome-extension://${UNPUBLISHED_ID}`
            expect(
                isAllowedExtensionRedirectUri(
                    `https://${UNPUBLISHED_ID}.chromiumapp.org/`,
                ),
            ).toBe(true)
            expect(
                isAllowedExtensionRedirectUri(
                    `https://${'p'.repeat(32)}.chromiumapp.org/`,
                ),
            ).toBe(false)
            // ...and the published IDs are still in.
            expect(
                isAllowedExtensionRedirectUri(
                    `https://${CHROME_ID}.chromiumapp.org/`,
                ),
            ).toBe(true)
        })

        it('tolerates a single trailing slash on a well-formed origin', () => {
            envMock.CHROME_EXTENSION_ORIGIN = `chrome-extension://${UNPUBLISHED_ID}/`
            expect(
                isAllowedExtensionRedirectUri(
                    `https://${UNPUBLISHED_ID}.chromiumapp.org/`,
                ),
            ).toBe(true)
        })

        // Each malformed value must be IGNORED: it adds nothing to the
        // allowlist, and in particular does not turn into "allow anything".
        const malformed: Array<[string, string]> = [
            ['a too-short ID', 'chrome-extension://short'],
            ['a too-long ID', `chrome-extension://${UNPUBLISHED_ID}a`],
            [
                'an ID with characters outside a-p',
                `chrome-extension://${FOREIGN_ID}`,
            ],
            [
                'an UPPERCASE ID',
                `chrome-extension://${UNPUBLISHED_ID.toUpperCase()}`,
            ],
            [
                'a trailing path after the ID',
                `chrome-extension://${UNPUBLISHED_ID}/some/path`,
            ],
            ['a different scheme', `https://${UNPUBLISHED_ID}.chromiumapp.org`],
            ['a bare ID with no scheme', UNPUBLISHED_ID],
            ['a wildcard', 'chrome-extension://*'],
            ['an empty string', ''],
        ]
        it.each(malformed)(
            'ignores %s and does not widen',
            (_label, origin) => {
                envMock.CHROME_EXTENSION_ORIGIN = origin
                // The ID the malformed value was gesturing at stays refused...
                expect(
                    isAllowedExtensionRedirectUri(
                        `https://${UNPUBLISHED_ID}.chromiumapp.org/`,
                    ),
                ).toBe(false)
                // ...a short ID does not become an allowed host...
                expect(
                    isAllowedExtensionRedirectUri(
                        'https://short.chromiumapp.org/',
                    ),
                ).toBe(false)
                // ...an arbitrary extension is still foreign...
                expect(
                    isAllowedExtensionRedirectUri(
                        `https://${FOREIGN_ID}.chromiumapp.org/`,
                    ),
                ).toBe(false)
                // ...and the published IDs are unaffected.
                expect(
                    isAllowedExtensionRedirectUri(
                        `https://${CHROME_ID}.chromiumapp.org/`,
                    ),
                ).toBe(true)
            },
        )
    })
})
