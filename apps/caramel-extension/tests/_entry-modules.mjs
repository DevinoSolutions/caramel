// Derives the set of local .js modules a WXT entrypoint actually bundles, by
// walking relative import specifiers transitively from the entrypoint source.
//
// ESM successor to "read the committed manifest.json's content_scripts list"
// (the manifest died with the hand-rolled build — WXT generates it from
// entrypoints/*, so the entrypoint import graph IS what ships). Suites that
// used to derive-check their coverage lists against the manifest derive them
// from here instead, keeping the same property: adding a module to the build
// without adding it to the suite is a red test, not a silent coverage gap.
import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const EXT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// Both import forms the source tree uses: `import ... from './x.js'` /
// `export ... from './x.js'`, and the bare side-effect `import './x.js'`.
const IMPORT_RE =
    /(?:import|export)[^'"()]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]/g

/**
 * Transitive closure of local `.js` modules reachable from the given
 * entrypoint files (paths relative to the package root). Returns a Set of
 * package-root-relative POSIX paths, e.g. 'caramel-base.js'.
 */
export function entryModuleClosure(...entryRelPaths) {
    const found = new Set()
    const queue = entryRelPaths.map(p => resolve(EXT_ROOT, p))
    const visited = new Set()
    while (queue.length > 0) {
        const file = queue.pop()
        if (visited.has(file)) continue
        visited.add(file)
        const src = readFileSync(file, 'utf8')
        for (const match of src.matchAll(IMPORT_RE)) {
            const spec = match[1] ?? match[2]
            if (!spec || !spec.startsWith('.') || !spec.endsWith('.js'))
                continue
            const target = resolve(dirname(file), spec)
            found.add(relative(EXT_ROOT, target).replaceAll('\\', '/'))
            queue.push(target)
        }
    }
    return found
}
