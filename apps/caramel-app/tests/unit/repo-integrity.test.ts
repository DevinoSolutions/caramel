import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// F-015 — repo-integrity gate (rules-become-checks). Two independent
// "an artifact lies about itself" invariants the audit found broken:
// (1) the Firefox manifest referenced a content script (amazon.js) that
// had been deleted from disk (broken build shipped to Firefox users), and
// (2) a stray file was committed at repo root with no allowlist to catch
// it. Both checks read the real tracked tree / real manifest files, so
// they fail again the moment either drifts, not just today.

const REPO_ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../..',
)
const EXTENSION_DIR = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../caramel-extension',
)

// A repo root should hold only files a human intentionally put there for
// tooling/workspace reasons — everything else (stray scratch output,
// committed error logs, OS artifacts) is a finding waiting to happen
// (AIH-3). Checked against `git ls-files`, not a raw directory listing, so
// untracked local artifacts (editor state, a stray Windows `nul` file —
// see .gitignore) never trip this in a dev's working copy; only what
// actually ships in the repo counts.
const ROOT_FILE_ALLOWLIST = new Set([
    '.gitattributes',
    '.gitignore',
    '.oxlintrc.json',
    '.prettierignore',
    '.prettierrc.json',
    'CLAUDE.md',
    'DESIGN.md',
    'LICENSE',
    'README.md',
    'RUNBOOK.md',
    'eslint.config.mjs',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tailwind.config.js',
    'turbo.json',
])

function trackedRootFiles(): string[] {
    const out = execFileSync('git', ['ls-files'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
    })
    return out
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.includes('/'))
}

interface ExtensionManifest {
    content_scripts?: Array<{ js?: string[]; css?: string[] }>
    background?: { service_worker?: string; scripts?: string[] }
    action?: { default_popup?: string }
}

function readManifest(name: string): ExtensionManifest {
    return JSON.parse(
        fs.readFileSync(path.join(EXTENSION_DIR, name), 'utf8'),
    ) as ExtensionManifest
}

// Every classic-script/stylesheet path a manifest declares (content
// scripts, background, popup) — the set that MUST exist on disk for the
// browser to actually load the extension.
function manifestFileRefs(manifest: ExtensionManifest): string[] {
    const refs: string[] = []
    for (const cs of manifest.content_scripts ?? []) {
        refs.push(...(cs.js ?? []), ...(cs.css ?? []))
    }
    if (manifest.background?.service_worker) {
        refs.push(manifest.background.service_worker)
    }
    refs.push(...(manifest.background?.scripts ?? []))
    if (manifest.action?.default_popup) {
        refs.push(manifest.action.default_popup)
    }
    return refs
}

// index.html's own <script src> / <link href> tags — local .js/.css/.html
// paths only, never a bare http(s) URL.
function indexHtmlFileRefs(): string[] {
    const html = fs.readFileSync(path.join(EXTENSION_DIR, 'index.html'), 'utf8')
    const re = /(?:src|href)="([^"]+\.(?:js|css|html))"/g
    return Array.from(html.matchAll(re))
        .map(match => match[1])
        .filter(ref => !/^https?:\/\//.test(ref))
}

describe('repo-integrity (F-015): root-file allowlist', () => {
    it('every git-tracked file at repo root is on the allowlist', () => {
        const strays = trackedRootFiles().filter(
            file => !ROOT_FILE_ALLOWLIST.has(file),
        )
        expect(strays).toEqual([])
    })
})

describe('repo-integrity (F-015): extension manifests reference only files that exist', () => {
    const manifests: Record<string, ExtensionManifest> = {
        'manifest.json (Chrome)': readManifest('manifest.json'),
        'manifest-firefox.json (Firefox)': readManifest(
            'manifest-firefox.json',
        ),
    }

    for (const [label, manifest] of Object.entries(manifests)) {
        it.each(manifestFileRefs(manifest))(`${label}: %s exists`, ref => {
            expect(fs.existsSync(path.join(EXTENSION_DIR, ref))).toBe(true)
        })
    }

    it.each(indexHtmlFileRefs())('index.html: %s exists', ref => {
        expect(fs.existsSync(path.join(EXTENSION_DIR, ref))).toBe(true)
    })
})
