import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// "Rules become checks": env reads must go through src/lib/env.ts (server)
// or src/lib/env.client.ts (client). Direct process.env.X elsewhere drifts
// away from the zod-validated, fail-fast schema.
//
// Legitimate exceptions:
//   - The env modules themselves (they ARE the access layer)
//   - instrumentation files (run before the app boots / before env modules)
//   - buildInfo.ts (Next.js build-time constant replacement)
//   - prisma.ts (bridge-sync imports it under tsx where server-only throws)
//   - decryptJsonData.ts (needs dynamic per-test process.env stubs)
//   - process.env.NODE_ENV / NEXT_PHASE / NEXT_RUNTIME are Next.js
//     compile-time constants (dead-code elimination), not real env reads

const REPO_ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../..',
)
const APP_SRC_DIR = path.join(REPO_ROOT, 'apps/caramel-app/src')

const NEXT_COMPILE_TIME_VARS = new Set([
    'NODE_ENV',
    'NEXT_PHASE',
    'NEXT_RUNTIME',
])

const ALLOWLISTED_FILES = new Set([
    'env.ts',
    'env.client.ts',
    'instrumentation.ts',
    'instrumentation-client.ts',
    'buildInfo.ts',
    'prisma.ts',
    'decryptJsonData.ts',
])

const SKIP_DIR_NAMES = new Set([
    'node_modules',
    '.next',
    'dist',
    'coverage',
    '.output',
    '.size-cache',
])

function walk(dir: string): string[] {
    if (!fs.existsSync(dir)) return []
    const found: string[] = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (SKIP_DIR_NAMES.has(entry.name)) continue
            found.push(...walk(path.join(dir, entry.name)))
        } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
            found.push(path.join(dir, entry.name))
        }
    }
    return found
}

const PROCESS_ENV_RE = /process\.env\.(\w+)/g

interface Violation {
    file: string
    variable: string
    line: number
}

function findViolations(files: string[]): Violation[] {
    const violations: Violation[] = []
    for (const file of files) {
        const base = path.basename(file)
        if (ALLOWLISTED_FILES.has(base)) continue
        if (base.endsWith('.test.ts') || base.endsWith('.test.tsx')) continue

        const content = fs.readFileSync(file, 'utf8')
        const lines = content.split('\n')
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i]
            if (line.trimStart().startsWith('//')) continue
            for (const match of line.matchAll(PROCESS_ENV_RE)) {
                const varName = match[1]
                if (NEXT_COMPILE_TIME_VARS.has(varName)) continue
                violations.push({
                    file: path.relative(REPO_ROOT, file),
                    variable: varName,
                    line: i + 1,
                })
            }
        }
    }
    return violations
}

describe('env-module enforcement', () => {
    it('app src/ reads env only via lib/env.ts or lib/env.client.ts (never raw process.env.X)', () => {
        const files = walk(APP_SRC_DIR)
        expect(files.length).toBeGreaterThan(0)
        const violations = findViolations(files)
        if (violations.length > 0) {
            const msg = violations
                .map(
                    v =>
                        `  ${v.file}:${v.line} — process.env.${v.variable}`,
                )
                .join('\n')
            expect.fail(
                `Found ${violations.length} direct process.env read(s) outside env modules:\n${msg}\n\n` +
                    'Use env.X (from @/lib/env) or clientEnv.X (from @/lib/env.client) instead.\n' +
                    'If this file genuinely cannot import the env modules, add it to ALLOWLISTED_FILES ' +
                    'in this test with a comment explaining why.',
            )
        }
    })
})
