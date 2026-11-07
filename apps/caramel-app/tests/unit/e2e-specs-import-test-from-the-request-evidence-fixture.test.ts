import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// T-9427 — every E2E spec gets its `test` from e2e/support/test.ts, whose
// automatic fixture prints the sanitized failed-request list to the job log
// when a test fails (traces are never uploaded: the repo is public). A spec
// that imports `test` straight from '@playwright/test' silently opts out, and
// its failure leaves no evidence of WHICH request broke the page. Types and
// helpers such as Page or devices may still come from '@playwright/test'.
const E2E_DIR = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../e2e',
)
const PLAYWRIGHT_IMPORT = /import\s*\{([^}]*)\}\s*from\s*'@playwright\/test'/g

function findSpecFiles(dir: string): string[] {
    return fs
        .readdirSync(dir, { withFileTypes: true })
        .flatMap(entry =>
            entry.isDirectory()
                ? findSpecFiles(path.join(dir, entry.name))
                : entry.name.endsWith('.spec.ts')
                  ? [path.join(dir, entry.name)]
                  : [],
        )
}

/** Specs (by name) that import a runtime `test` from '@playwright/test'. */
function specsBypassingTheFixture(sources: Record<string, string>): string[] {
    return Object.entries(sources)
        .filter(([, source]) =>
            Array.from(source.matchAll(PLAYWRIGHT_IMPORT)).some(match =>
                (match[1] ?? '')
                    .split(',')
                    .map(name => name.trim())
                    .some(name => name === 'test'),
            ),
        )
        .map(([name]) => name)
}

describe('e2e specs use the request-evidence fixture', () => {
    it('no spec, at any depth under e2e/, imports `test` from @playwright/test', () => {
        const specFiles = findSpecFiles(E2E_DIR)
        const sources = Object.fromEntries(
            specFiles.map(file => [
                path.relative(E2E_DIR, file),
                fs.readFileSync(file, 'utf8'),
            ]),
        )

        expect(specFiles.length).toBeGreaterThan(0)
        expect(specsBypassingTheFixture(sources)).toEqual([])
    })

    it('finds *.spec.ts files in nested directories (red-proof for the walk)', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-specs-'))
        try {
            fs.mkdirSync(path.join(root, 'nested', 'deeper'), {
                recursive: true,
            })
            fs.writeFileSync(path.join(root, 'top.spec.ts'), '')
            fs.writeFileSync(
                path.join(root, 'nested', 'deeper', 'inner.spec.ts'),
                '',
            )
            fs.writeFileSync(path.join(root, 'nested', 'helper.ts'), '')

            expect(
                findSpecFiles(root)
                    .map(file => path.relative(root, file))
                    .sort(),
            ).toEqual(
                [
                    'top.spec.ts',
                    path.join('nested', 'deeper', 'inner.spec.ts'),
                ].sort(),
            )
        } finally {
            fs.rmSync(root, { recursive: true, force: true })
        }
    })

    it('the detector flags a bypass and accepts the fixture and type-only imports (red-proof)', () => {
        expect(
            specsBypassingTheFixture({
                'bad.spec.ts':
                    "import { expect, test } from '@playwright/test'",
                'bad-multi.spec.ts':
                    "import { devices, test, type Page } from '@playwright/test'",
                'good.spec.ts':
                    "import { expect, test } from './support/test'\nimport { Page } from '@playwright/test'",
                'type-only.spec.ts':
                    "import { type Page, devices } from '@playwright/test'",
            }),
        ).toEqual(['bad.spec.ts', 'bad-multi.spec.ts'])
    })
})
