import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// T-9413 — the Android `devproof` build type (app/build.gradle.kts) is a DEV-ONLY
// release clone for walking a SHRUNK build signed in on an emulator. These are the
// static halves of "it can never ship"; the built-artifact half (the store APK has
// no suffix and no trace of the dev-proof path, the devproof APK is debug-signed)
// is .github/workflows/scripts/android-devproof-guard.sh, run by
// android-devproof-guard.yml on every PR that touches the app.
const REPO_ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../..',
)
const ANDROID_APP = path.join(REPO_ROOT, 'apps/caramel-android/app')
const WORKFLOWS = path.join(REPO_ROOT, '.github/workflows')

function read(...segments: string[]): string {
    return fs.readFileSync(path.join(REPO_ROOT, ...segments), 'utf8')
}

/** The brace-balanced body of `name { ... }` / `create("name") { ... }` inside a Gradle file. */
function block(source: string, opener: string): string {
    const start = source.indexOf(opener)
    expect(start, `${opener} not found in build.gradle.kts`).toBeGreaterThan(-1)
    const open = source.indexOf('{', start)
    let depth = 0
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{') depth++
        if (source[i] === '}' && --depth === 0) return source.slice(open + 1, i)
    }
    throw new Error(`${opener} has no closing brace`)
}

function kotlinFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) return kotlinFiles(full)
        return entry.name.endsWith('.kt') ? [full] : []
    })
}

describe('the release workflow never touches the devproof variant', () => {
    it('release-android-app.yml does not mention devproof anywhere (build, sign, upload or otherwise)', () => {
        expect(read('.github/workflows/release-android-app.yml')).not.toMatch(
            /devproof/i,
        )
    })

    it('its build and upload steps name only the release tasks and the release AAB', () => {
        const workflow = read('.github/workflows/release-android-app.yml')
        const gradleCalls = workflow.match(/\.\/gradlew[^\n]*/g) ?? []
        expect(gradleCalls.length).toBeGreaterThan(0)
        for (const call of gradleCalls) {
            expect(call).toMatch(/Release|assembleDebug/)
        }
        expect(workflow).toContain(
            'app/build/outputs/bundle/release/app-release.aab',
        )
    })

    it('only the guard workflow and its script mention devproof, and no workflow with an android-v tag trigger does', () => {
        const mentioning = fs
            .readdirSync(WORKFLOWS, { withFileTypes: true })
            .filter(entry => entry.isFile() && /\.ya?ml$/.test(entry.name))
            .filter(entry =>
                /devproof/i.test(read('.github/workflows', entry.name)),
            )
            .map(entry => entry.name)
        expect(mentioning).toEqual(['android-devproof-guard.yml'])
    })
})

describe('the guard workflow can only run on a pull request, with no secrets and no upload', () => {
    const guard = read('.github/workflows/android-devproof-guard.yml')
    const triggers = guard.match(/^on:\n([\s\S]*?)\n\S/m)?.[1] ?? ''

    it('triggers on pull_request alone: no push, tag, dispatch or schedule', () => {
        expect(triggers).toMatch(/^\s*pull_request:/m)
        expect(triggers).not.toMatch(
            /\b(push|tags|workflow_dispatch|schedule|workflow_call)\b/,
        )
    })

    it('uses no secret, signs nothing, and uploads nothing', () => {
        expect(guard).not.toMatch(/secrets\./)
        expect(guard).not.toMatch(
            /KEYSTORE|upload-google-play|artifact\/upload|upload-artifact|bundle(Release|Devproof)/,
        )
    })
})

describe('app/build.gradle.kts keeps devproof a build type that cannot be mistaken for the store build', () => {
    const gradle = fs.readFileSync(
        path.join(ANDROID_APP, 'build.gradle.kts'),
        'utf8',
    )

    it('is a build type, not a flavor: the release task names and output paths stay unchanged', () => {
        expect(gradle).not.toMatch(/productFlavors|flavorDimensions/)
        expect(gradle).toContain('create("devproof")')
    })

    it('release carries no suffix, no debug key and no dev-proof switch', () => {
        const release = block(gradle, 'release {')
        expect(release).not.toMatch(/applicationIdSuffix/)
        expect(release).not.toMatch(/getByName\("debug"\)/)
        expect(release).not.toMatch(/buildConfigField/)
        expect(release).toMatch(/isMinifyEnabled = true/)
        expect(release).toMatch(/isShrinkResources = true/)
    })

    it('defaults every build type to production with the switch off', () => {
        const defaultConfig = block(gradle, 'defaultConfig {')
        expect(defaultConfig).toContain(
            'buildConfigField("String", "API_BASE_URL", "\\"https://grabcaramel.com\\"")',
        )
        expect(defaultConfig).toContain(
            'buildConfigField("boolean", "DEV_PROOF", "false")',
        )
    })

    it('devproof is a release clone with its own id, the debug key and the dev origin', () => {
        const devproof = block(gradle, 'create("devproof")')
        expect(devproof).toContain('initWith(getByName("release"))')
        expect(devproof).toContain('applicationIdSuffix = ".devproof"')
        expect(devproof).toContain(
            'signingConfig = signingConfigs.getByName("debug")',
        )
        expect(devproof).toContain('"\\"https://dev.grabcaramel.com\\""')
        expect(devproof).toContain(
            'buildConfigField("boolean", "DEV_PROOF", "true")',
        )
    })

    it('the upload keystore is wired to the release signing config only', () => {
        const signing = block(gradle, 'signingConfigs {')
        expect(signing).toContain('create("release")')
        expect(signing).not.toMatch(/devproof/i)
        expect(block(gradle, 'create("devproof")')).not.toMatch(
            /signingConfigs\.getByName\("release"\)|releaseKeystorePath/,
        )
    })
})

describe('every use of the dev-proof path in app code is behind BuildConfig.DEV_PROOF', () => {
    const SRC = path.join(ANDROID_APP, 'src/main/java')

    it('only the four known files reference it, and the two call sites test the constant', () => {
        const referencing = kotlinFiles(SRC)
            .filter(file =>
                /DevProofSession|adoptDevProofBearer|devproof_session/.test(
                    fs.readFileSync(file, 'utf8'),
                ),
            )
            .map(file => path.basename(file))
        expect(new Set(referencing)).toEqual(
            new Set([
                'CaramelApp.kt',
                'DevProofSession.kt',
                'MainActivity.kt',
                'SessionStore.kt',
            ]),
        )
        for (const callSite of ['CaramelApp.kt', 'MainActivity.kt']) {
            const file = kotlinFiles(SRC).find(f => f.endsWith(callSite))!
            expect(fs.readFileSync(file, 'utf8')).toContain(
                'BuildConfig.DEV_PROOF',
            )
        }
    })

    it('the dev origin appears in no app source (only in the devproof build type)', () => {
        for (const file of kotlinFiles(SRC)) {
            expect(
                fs
                    .readFileSync(file, 'utf8')
                    .split('\n')
                    .filter(line => !/^\s*(\*|\/\/|\/\*)/.test(line))
                    .join('\n'),
            ).not.toContain('dev.grabcaramel.com')
        }
    })
})
