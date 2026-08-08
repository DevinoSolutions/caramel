/**
 * What a build talks to is decided by HOW IT WAS BUILT.
 *
 * The bug these pins exist for: `_isDevInstall()` decided dev-vs-production at
 * runtime by the ABSENCE of `chrome.runtime.getManifest().update_url` — a field
 * the Chrome Web Store injects into installed extensions and nobody else does.
 * Chrome was right by accident; every other target was wrong by construction.
 * Firefox/AMO listed add-ons must be uploaded without an update_url, and the
 * converted Safari build has none either (verified on the converted output).
 * So the Safari builds already in TestFlight, and any AMO upload, resolved
 * their API calls, login tab, store catalog and outcome reporting to the DEV
 * deployment, trusted a dev origin to postMessage a session token into a real
 * user's extension storage, and printed our internals into every store's
 * console.
 *
 * These assert on the ACTUAL BUILT OUTPUT, not on source: the thing that ships
 * is a directory, and the only claim worth making is about that directory.
 */

import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
    buildDist,
    ENV_FILE,
    ENVIRONMENTS,
    renderEnvStamp,
    SHIPPED,
} from '../scripts/build-dist.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const PROD_URL = 'https://grabcaramel.com'
const DEV_URL = 'https://dev.grabcaramel.com'
const LOCAL_URL = 'http://localhost:58000'

/** Every string that must not appear anywhere in a production package. */
const DEV_TARGETS = [DEV_URL, LOCAL_URL, '127.0.0.1']

/**
 * Evaluates a built caramel-env.js the way a browser would and hands back the
 * stamp it installed. Reading the object beats string-matching the file: it is
 * what the extension actually gets.
 */
async function readStamp(outDir) {
    const src = await readFile(join(outDir, ENV_FILE), 'utf8')
    const scope = { globalThis: {} }
    new Function('globalThis', src)(scope.globalThis)
    return scope.globalThis
}

/** Recursively lists files under `dir`, relative to it. */
async function listFiles(dir, prefix = '') {
    const out = []
    for (const entry of await readdir(dir)) {
        const rel = prefix ? `${prefix}/${entry}` : entry
        if ((await stat(join(dir, entry))).isDirectory()) {
            out.push(...(await listFiles(join(dir, entry), rel)))
        } else {
            out.push(rel)
        }
    }
    return out
}

let workdir
let prodDir
let devDir

beforeAll(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'caramel-build-env-'))
    prodDir = join(workdir, 'dist-default')
    devDir = join(workdir, 'dist-dev')
    // No environment argument AT ALL — the same call `pnpm build` makes.
    await buildDist({ outDir: prodDir })
    await buildDist({ outDir: devDir, environment: 'development' })
}, 60000)

afterAll(async () => {
    if (workdir) await rm(workdir, { recursive: true, force: true })
})

describe('a build with no environment flag is a PRODUCTION build', () => {
    it('points every API call at production', async () => {
        const g = await readStamp(prodDir)
        expect(g.CARAMEL_ENV.name).toBe('production')
        expect(g.CARAMEL_ENV.isProduction).toBe(true)
        expect(g.CARAMEL_ENV.baseUrl).toBe(PROD_URL)
        // background.js builds every request URL off this flat alias.
        expect(g.CARAMEL_BASE_URL).toBe(PROD_URL)
    })

    it('trusts no dev origin to postMessage a session token in', async () => {
        const { trustedOrigins } = (await readStamp(prodDir)).CARAMEL_ENV
        expect(trustedOrigins).toContain(PROD_URL)
        for (const origin of trustedOrigins) {
            expect(DEV_TARGETS.some(t => origin.includes(t))).toBe(false)
        }
    })

    it('prints nothing to any console', async () => {
        expect((await readStamp(prodDir)).CARAMEL_ENV.verbose).toBe(false)
    })

    it('contains no reference to a dev target ANYWHERE in the package', async () => {
        // Comments included, deliberately. A store reviewer or a curious user
        // greps the package they were shipped; "it is only in a comment" is a
        // claim someone then has to verify by hand. Zero occurrences is a
        // claim that verifies itself.
        const offenders = []
        for (const file of await listFiles(prodDir)) {
            if (!/\.(js|json|html|css|svg)$/.test(file)) continue
            const src = await readFile(join(prodDir, file), 'utf8')
            for (const target of DEV_TARGETS) {
                if (src.includes(target)) offenders.push(`${file}: ${target}`)
            }
        }
        expect(offenders).toEqual([])
    })
})

describe('targeting dev takes an explicit, visible flag', () => {
    it('--env=development stamps the dev deployment', async () => {
        const g = await readStamp(devDir)
        expect(g.CARAMEL_ENV.name).toBe('development')
        expect(g.CARAMEL_ENV.isProduction).toBe(false)
        expect(g.CARAMEL_ENV.baseUrl).toBe(DEV_URL)
        expect(g.CARAMEL_BASE_URL).toBe(DEV_URL)
        expect(g.CARAMEL_ENV.verbose).toBe(true)
    })

    it('a dev build trusts dev origins and NOT production ones', async () => {
        // The environments do not overlap in either direction: a build talking
        // to dev has no business accepting a production session relayed from a
        // prod tab either.
        const { trustedOrigins } = (await readStamp(devDir)).CARAMEL_ENV
        expect(trustedOrigins).toContain(DEV_URL)
        expect(trustedOrigins).toContain(LOCAL_URL)
        expect(trustedOrigins).not.toContain(PROD_URL)
    })

    it('rejects an environment name that does not exist', async () => {
        await expect(
            buildDist({
                outDir: join(workdir, 'nope'),
                environment: 'staging',
            }),
        ).rejects.toThrow(/unknown environment "staging"/)
    })
})

describe('the stamp is the only thing that decides the environment', () => {
    it('no shipped file branches on update_url', async () => {
        // Comments are stripped first (same technique as
        // console-silence.test.mjs): the history of WHY this heuristic was
        // wrong is worth keeping in the files that used to depend on it. What
        // is banned is a build's behavior depending on the field again.
        const offenders = []
        for (const file of await listFiles(prodDir)) {
            if (!file.endsWith('.js')) continue
            const code = (await readFile(join(prodDir, file), 'utf8'))
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/^\s*\/\/.*$/gm, '')
            if (/update_url/.test(code)) offenders.push(file)
            if (/_isDevInstall/.test(code))
                offenders.push(`${file} (_isDevInstall)`)
        }
        expect(offenders).toEqual([])
    })

    it('loads the stamp before anything that reads it, in all three contexts', async () => {
        const chrome = JSON.parse(
            await readFile(join(prodDir, 'manifest.json'), 'utf8'),
        )
        const firefox = JSON.parse(
            await readFile(join(ROOT, 'manifest-firefox.json'), 'utf8'),
        )
        const index = await readFile(join(prodDir, 'index.html'), 'utf8')

        // content scripts (both manifests)
        expect(chrome.content_scripts[0].js[0]).toBe(ENV_FILE)
        expect(firefox.content_scripts[0].js[0]).toBe(ENV_FILE)

        // popup page
        const scripts = [...index.matchAll(/<script src="([^"]+)"/g)].map(
            m => m[1],
        )
        expect(scripts[0]).toBe(ENV_FILE)

        // background: Chrome's single-file service worker pulls it in itself,
        // Firefox's background script list names it first.
        const worker = await readFile(
            join(prodDir, chrome.background.service_worker),
            'utf8',
        )
        expect(worker).toMatch(/importScripts\(['"]\/?caramel-env\.js['"]\)/)
        expect(firefox.background.scripts[0]).toBe(ENV_FILE)
    })

    it('the committed package-root stamp is the DEVELOPMENT one, and matches its renderer', async () => {
        // That copy is what an unpacked load of this directory gets (`pnpm
        // dev`, the Playwright harness). It is never copied into a package —
        // buildDist writes a fresh one — but it must not drift from the
        // renderer, or a developer debugs a stamp nobody generates any more.
        const committed = await readFile(join(ROOT, ENV_FILE), 'utf8')
        expect(committed).toBe(renderEnvStamp('development'))
        expect(SHIPPED).not.toContain(ENV_FILE)
    })

    it('every environment names a distinct deployment', () => {
        const urls = Object.values(ENVIRONMENTS).map(e => e.baseUrl)
        expect(new Set(urls).size).toBe(urls.length)
    })
})
