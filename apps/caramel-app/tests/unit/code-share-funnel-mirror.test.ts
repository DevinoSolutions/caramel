import {
    CODE_SHARE_FUNNEL_STEP_REASONS,
    CodeShareFunnelEventSchema,
    FUNNEL_STORE_PATTERN,
    MIN_USAGE_DIAGNOSTICS_CONSENT_PROMPT_VERSION,
    UsageDiagnosticsConsentProofSchema,
} from '@/lib/analytics/codeShareFunnel'
import {
    EXTENSION_STORES,
    EXTENSION_VERSION_PATTERN,
} from '@/lib/extensionInstall'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The extension has no bundler and cannot import src/lib/analytics/
// codeShareFunnel.ts, so the funnel vocabulary lives in two places:
// apps/caramel-extension/code-share-funnel.js (what the extension is allowed to
// BUILD and send) and the app's schema (what the server accepts and emits).
// This is the drift guard, same idea as shopper-code-pattern-mirror.test.ts and
// checkout-consent-version-mirror.test.ts: it reads the extension's source
// text, rebuilds its pure functions, and requires them to agree with the app.
// Red means one side changed without the other: either every report is
// refused (422) or the server accepts a field the extension does not mean to
// send.

const EXT_DIR = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../caramel-extension',
)
const read = (file: string): string =>
    fs.readFileSync(path.join(EXT_DIR, file), 'utf8')

const funnelSource = (): string => read('code-share-funnel.js')

/** The extension's `export const NAME = <literal>`, evaluated. */
function exportedLiteral(source: string, name: string): unknown {
    const start = source.indexOf(`export const ${name} =`)
    if (start === -1) {
        throw new Error(
            `code-share-funnel.js no longer declares \`export const ${name} = …\` — update this guard together with it`,
        )
    }
    const bodyStart = source.indexOf('=', start) + 1
    const firstLineEnd = source.indexOf('\n', bodyStart)
    const firstLine = source.slice(bodyStart, firstLineEnd)
    // Prettier writes either the whole literal on one line, or an opening
    // bracket ending the first line and the closing one alone on its own line.
    const closing = firstLine.trimEnd().endsWith('{')
        ? '\n}'
        : firstLine.trimEnd().endsWith('[')
          ? '\n]'
          : null
    const literal =
        closing === null
            ? firstLine
            : source.slice(
                  bodyStart,
                  source.indexOf(closing, bodyStart) + closing.length,
              )
    return new Function(`return (${literal})`)()
}

/** A single-line `const NAME = /…/flags` regex literal of the extension. */
function mirroredRegex(source: string, name: string): RegExp {
    const match = new RegExp(
        `^const ${name} =\\s*\\/(.+)\\/([a-z]*)$`,
        'm',
    ).exec(source)
    if (!match) {
        throw new Error(
            `code-share-funnel.js no longer declares \`const ${name} = /…/\` — update this guard together with it`,
        )
    }
    return new RegExp(match[1] as string, match[2])
}

interface ExtensionFunnel {
    buildFunnelEvent: (args: Record<string, unknown>) => Record<string, unknown>
}

/** The extension module, import-free, rebuilt from its source text. */
function extensionFunnel(): ExtensionFunnel {
    const source = funnelSource().replace(/^export /gm, '')
    return new Function(
        `${source}\nreturn { buildFunnelEvent }`,
    )() as ExtensionFunnel
}

describe('code-share-funnel.js mirrors the server vocabulary (app <-> extension sync)', () => {
    it('declares the same steps, in the same order, with the same reasons per step', () => {
        const ext = exportedLiteral(
            funnelSource(),
            'CODE_SHARE_FUNNEL_STEP_REASONS',
        ) as Record<string, string[]>

        expect(Object.entries(ext)).toEqual(
            Object.entries(CODE_SHARE_FUNNEL_STEP_REASONS),
        )
    })

    it('store_not_accepted keeps the retired not-committed (old builds send it) beside the split reasons', () => {
        expect(CODE_SHARE_FUNNEL_STEP_REASONS.store_not_accepted).toEqual(
            expect.arrayContaining([
                'not-committed',
                'store-error',
                'not-tied-to-code',
                'price-dropped-no-row',
                'no-signal',
            ]),
        )
    })

    it('declares the same browsers as the install-attribution store channels', () => {
        const ext = exportedLiteral(
            funnelSource(),
            'CODE_SHARE_FUNNEL_BROWSERS',
        ) as string[]

        expect([...ext].sort()).toEqual([...EXTENSION_STORES].sort())
    })

    it('uses the same store and version patterns', () => {
        const source = funnelSource()
        const store = mirroredRegex(source, 'STORE_PATTERN')
        const version = mirroredRegex(source, 'VERSION_PATTERN')

        expect(store.source).toBe(FUNNEL_STORE_PATTERN.source)
        expect(store.flags).toBe(FUNNEL_STORE_PATTERN.flags)
        expect(version.source).toBe(EXTENSION_VERSION_PATTERN.source)
        expect(version.flags).toBe(EXTENSION_VERSION_PATTERN.flags)
    })

    it('everything the extension can build, the server accepts (every step x reason)', () => {
        const { buildFunnelEvent } = extensionFunnel()
        const base = {
            store: 'example.com',
            extVersion: '1.4.14',
            browser: 'chrome',
            sharingPromptVersion: 1,
        }
        for (const [step, reasons] of Object.entries(
            CODE_SHARE_FUNNEL_STEP_REASONS,
        )) {
            for (const reason of reasons.length ? reasons : [undefined]) {
                const built = buildFunnelEvent({ step, reason, ...base })
                const parsed = CodeShareFunnelEventSchema.safeParse(built)
                expect(
                    parsed.success,
                    `${step}/${reason}: ${JSON.stringify(built)}`,
                ).toBe(true)
            }
        }
    })

    it('the server schema accepts nothing beyond what the extension builds (strict)', () => {
        const { buildFunnelEvent } = extensionFunnel()
        const built = buildFunnelEvent({
            step: 'capture_armed',
            store: 'example.com',
            extVersion: '1.4.14',
            browser: 'chrome',
            sharingPromptVersion: 1,
            code: 'SAVE10',
        })

        expect(Object.keys(built).sort()).toEqual([
            'browser',
            'extVersion',
            'sharingPromptVersion',
            'step',
            'store',
        ])
        expect(
            CodeShareFunnelEventSchema.safeParse({ ...built, code: 'SAVE10' })
                .success,
        ).toBe(false)
    })
})

describe('usage-diagnostics consent prompt version: extension vs server floor', () => {
    function extensionPromptVersion(): number {
        const match = /^const USAGE_DIAGNOSTICS_PROMPT_VERSION = (\d+)$/m.exec(
            read('usage-diagnostics-consent.js'),
        )
        if (!match) {
            throw new Error(
                'usage-diagnostics-consent.js no longer declares `const USAGE_DIAGNOSTICS_PROMPT_VERSION = <int>` on one line; update this guard together with it',
            )
        }
        return Number(match[1])
    }

    it('the server floor never exceeds the version the extension sends', () => {
        expect(
            MIN_USAGE_DIAGNOSTICS_CONSENT_PROMPT_VERSION,
        ).toBeLessThanOrEqual(extensionPromptVersion())
    })

    it('the server floor is a positive integer', () => {
        expect(
            Number.isInteger(MIN_USAGE_DIAGNOSTICS_CONSENT_PROMPT_VERSION),
        ).toBe(true)
        expect(
            MIN_USAGE_DIAGNOSTICS_CONSENT_PROMPT_VERSION,
        ).toBeGreaterThanOrEqual(1)
    })

    it('the proof the extension sends (choice + promptVersion, as background.js builds it) satisfies the server gate', () => {
        const proof = {
            choice: 'accepted',
            promptVersion: extensionPromptVersion(),
        }

        expect(
            UsageDiagnosticsConsentProofSchema.safeParse(proof).success,
        ).toBe(true)
        // background.js sends exactly these two keys; pin that in the source.
        const background = read('background.js')
        expect(background).toMatch(
            /consent:\s*\{\s*choice:\s*latest\.choice,\s*promptVersion:\s*latest\.promptVersion,\s*\}/,
        )
    })
})
