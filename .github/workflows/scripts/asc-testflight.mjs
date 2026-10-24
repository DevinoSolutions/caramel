#!/usr/bin/env node
// App Store Connect helper for release-apple-app.yml (T-4904). TestFlight only:
// this script never creates, edits or submits an App Store VERSION, and it only
// ever touches the one build it is told to by (marketing version, build number).
// Apps 1.4.15 / 1.4.16 and their builds are structurally out of reach: the
// attach step refuses any build whose pre-release version is not the expected one.
//
// Usage:
//   node asc-testflight.mjs next-build-number
//       Prints the next iOS CFBundleVersion: strictly greater than every iOS
//       build already on the app (the same "highest + 1" rule release-extension.yml
//       applies, so both workflows keep one monotonic number line).
//   node asc-testflight.mjs attach-build <marketing-version> <build-number> <group-name>
//       Waits for the uploaded build to finish processing, adds it to the named
//       INTERNAL TestFlight group, and verifies membership + IN_BETA_TESTING.
//   node asc-testflight.mjs version-state <marketing-version>
//       Read-only train guard for internal_preview builds: exits non-zero when an iOS
//       App Store version with that versionString exists in any state other than a closed
//       one (being prepared, in review, awaiting release...), so a preview build can never
//       land in a train someone is shipping. Fails CLOSED on any API error or unknown state.
// Env: ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH (path to AuthKey_<id>.p8),
//      ASC_BUNDLE_ID (com.devino.Caramel).
import { createPrivateKey, sign } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const API = 'https://api.appstoreconnect.apple.com/v1'
// The one existing Caramel app record. A bundle-id lookup that resolves to
// anything else is a misconfiguration, not something to upload against.
const EXPECTED_APP_ID = '6741873881'
const PROCESSING_TIMEOUT_MS = 45 * 60 * 1000
const BETA_STATE_TIMEOUT_MS = 5 * 60 * 1000
const POLL_MS = 30 * 1000

function requireEnv(name) {
    const value = process.env[name]
    if (!value) throw new Error(`Environment variable ${name} is not set.`)
    return value
}

function token() {
    const keyId = requireEnv('ASC_KEY_ID')
    const issuerId = requireEnv('ASC_ISSUER_ID')
    const b64url = value => Buffer.from(value).toString('base64url')
    const now = Math.floor(Date.now() / 1000)
    const unsigned = `${b64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }))}.${b64url(
        JSON.stringify({
            iss: issuerId,
            iat: now,
            exp: now + 600,
            aud: 'appstoreconnect-v1',
        }),
    )}`
    const signature = sign('sha256', Buffer.from(unsigned), {
        key: createPrivateKey(readFileSync(requireEnv('ASC_KEY_PATH'))),
        dsaEncoding: 'ieee-p1363',
    })
    return `${unsigned}.${signature.toString('base64url')}`
}

async function api(path, init = {}) {
    const url = path.startsWith('http') ? path : `${API}${path}`
    const method = init.method ?? 'GET'
    const response = await fetch(url, {
        method,
        headers: {
            Authorization: `Bearer ${token()}`,
            ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
    })
    if (!response.ok) {
        throw new Error(
            `${method} ${url} -> ${response.status}: ${await response.text()}`,
        )
    }
    return response.status === 204 ? null : response.json()
}

async function listAll(path) {
    const rows = []
    let next = path
    while (next) {
        const page = await api(next)
        rows.push(...page.data)
        next = page.links?.next
    }
    return rows
}

async function resolveAppId() {
    const bundleId = requireEnv('ASC_BUNDLE_ID')
    const apps = await listAll(
        `/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=200`,
    )
    if (apps.length !== 1 || apps[0].id !== EXPECTED_APP_ID) {
        throw new Error(
            `Bundle id ${bundleId} resolved to [${apps.map(app => app.id).join(', ')}], expected exactly the Caramel app ${EXPECTED_APP_ID}.`,
        )
    }
    return apps[0].id
}

function summary(markdown) {
    console.log(markdown)
    if (process.env.GITHUB_STEP_SUMMARY) {
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`)
    }
}

async function nextBuildNumber() {
    const appId = await resolveAppId()
    const builds = await listAll(
        `/builds?filter[app]=${appId}&filter[preReleaseVersion.platform]=IOS&limit=200&fields[builds]=version`,
    )
    if (builds.length === 0) {
        throw new Error(
            `App ${appId} lists no iOS builds, which cannot be right for a live app: refusing to guess a build number.`,
        )
    }
    const numbers = builds.map(build => {
        const value = Number(build.attributes.version)
        if (!Number.isSafeInteger(value) || value < 1) {
            throw new Error(
                `Existing build ${build.id} has a non-integer CFBundleVersion "${build.attributes.version}": the +1 scheme cannot continue from it.`,
            )
        }
        return value
    })
    const highest = Math.max(...numbers)
    console.error(
        `${builds.length} existing iOS build(s); highest CFBundleVersion ${highest}.`,
    )
    process.stdout.write(String(highest + 1))
}

// App Store version states in which the train is over: the version is live or was live and has
// since been replaced or pulled. Source: Apple's AppVersionState (READY_FOR_DISTRIBUTION is the
// current name of READY_FOR_SALE) and the deprecated AppStoreVersionState. Anything else
// (PREPARE_FOR_SUBMISSION, WAITING_FOR_REVIEW, IN_REVIEW, REJECTED, PENDING_DEVELOPER_RELEASE,
// ... or a state this list has never heard of) means the train is still being prepared or reviewed.
const CLOSED_TRAIN_STATES = new Set([
    'READY_FOR_SALE',
    'READY_FOR_DISTRIBUTION',
    'REPLACED_WITH_NEW_VERSION',
    'REMOVED_FROM_SALE',
    'DEVELOPER_REMOVED_FROM_SALE',
])

// Pure: given ALL of the app's iOS appStoreVersions rows, returns the rows of the train
// `marketingVersion` that keep it open as "<id>: <state>" strings (empty = the preview build may
// proceed). Nothing is silently skipped: a row with no versionString cannot be ruled out of the
// train, so it counts as open; a row with no state attribute counts as open (fail closed). Both
// state attributes are read because Apple is moving appStoreState -> appVersionState; if either is
// non-closed the train is open. The platform is filtered server-side; a row that EXPLICITLY names
// another platform is ignored, a row that names none is trusted to be iOS.
function openTrainVersions(rows, marketingVersion) {
    return rows.flatMap(row => {
        const { versionString, platform } = row.attributes ?? {}
        if (typeof versionString !== 'string' || versionString === '') {
            return [`${row.id}: <no versionString>`]
        }
        if (versionString !== marketingVersion) return []
        if (typeof platform === 'string' && platform !== 'IOS') return []
        const states = [
            row.attributes?.appVersionState,
            row.attributes?.appStoreState,
        ].filter(state => typeof state === 'string' && state !== '')
        if (states.length === 0) return [`${row.id}: <no state attribute>`]
        return states.every(state => CLOSED_TRAIN_STATES.has(state))
            ? []
            : [`${row.id}: ${states.join('/')}`]
    })
}

async function assertTrainClosed(marketingVersion) {
    const appId = await resolveAppId()
    // No versionString filter and no fields[] filter: the whole iOS list with every attribute, so an
    // empty answer can be told apart from "this version does not exist" and an unknown field name
    // can never 400 the guard.
    const rows = await listAll(
        `/apps/${appId}/appStoreVersions?filter[platform]=IOS&limit=200`,
    )
    if (rows.length === 0) {
        throw new Error(
            `App ${appId} lists no iOS App Store versions, which cannot be right for a shipped app: refusing to guess that the ${marketingVersion} train is closed.`,
        )
    }
    const open = openTrainVersions(rows, marketingVersion)
    if (open.length > 0) {
        throw new Error(
            `App Store version ${marketingVersion} (iOS) is still open on app ${appId} [${open.join(', ')}]: refusing an internal preview build into that TestFlight train.`,
        )
    }
    const sameTrain = rows.filter(
        row => row.attributes?.versionString === marketingVersion,
    ).length
    summary(
        `### Train guard\n\niOS version \`${marketingVersion}\`: ${sameTrain} App Store version row(s) of ${rows.length} iOS rows, none open. The internal preview build may use this train.`,
    )
}

async function findBuild(appId, marketingVersion, buildNumber) {
    const found = await api(
        `/builds?filter[app]=${appId}&filter[version]=${encodeURIComponent(buildNumber)}&filter[preReleaseVersion.platform]=IOS&include=preReleaseVersion&fields[builds]=version,processingState,expired,preReleaseVersion&fields[preReleaseVersions]=version,platform&limit=50`,
    )
    const trains = new Map(
        (found.included ?? []).map(item => [item.id, item.attributes.version]),
    )
    return found.data.filter(
        build =>
            trains.get(build.relationships.preReleaseVersion.data.id) ===
            marketingVersion,
    )
}

async function attachBuild(marketingVersion, buildNumber, groupName) {
    const appId = await resolveAppId()

    const deadline = Date.now() + PROCESSING_TIMEOUT_MS
    let build
    for (;;) {
        const matches = await findBuild(appId, marketingVersion, buildNumber)
        if (matches.length > 1) {
            throw new Error(
                `Build ${marketingVersion} (${buildNumber}) matched ${matches.length} builds; refusing to pick one.`,
            )
        }
        build = matches[0]
        const state = build?.attributes.processingState ?? 'NOT_YET_LISTED'
        console.log(`Build ${marketingVersion} (${buildNumber}): ${state}`)
        if (state === 'VALID') break
        if (state === 'FAILED' || state === 'INVALID') {
            throw new Error(
                `Build ${marketingVersion} (${buildNumber}) finished processing as ${state}.`,
            )
        }
        if (Date.now() > deadline) {
            throw new Error(
                `Build ${marketingVersion} (${buildNumber}) was not VALID within ${PROCESSING_TIMEOUT_MS / 60000} minutes (last state ${state}).`,
            )
        }
        await sleep(POLL_MS)
    }
    if (build.attributes.expired) {
        throw new Error(
            `Build ${marketingVersion} (${buildNumber}) is already expired.`,
        )
    }

    const groups = await listAll(
        `/betaGroups?filter[app]=${appId}&filter[name]=${encodeURIComponent(groupName)}&limit=200`,
    )
    const group = groups.filter(g => g.attributes.name === groupName)
    if (group.length !== 1) {
        throw new Error(
            `Expected exactly one TestFlight group named "${groupName}", found ${group.length}.`,
        )
    }
    const [{ id: groupId, attributes }] = group
    if (!attributes.isInternalGroup) {
        throw new Error(
            `TestFlight group "${groupName}" is external: this workflow attaches to INTERNAL groups only (external groups need Beta App Review).`,
        )
    }

    // GET /builds/{id}/betaGroups is not allowed (the relationship is
    // create/delete only), so membership is read from the group's side.
    const inGroup = async () =>
        (
            await listAll(
                `/betaGroups/${groupId}/builds?fields[builds]=version&limit=200`,
            )
        ).some(member => member.id === build.id)

    // An internal group with "access to all builds" receives every processed
    // build by itself and App Store Connect refuses a manual add (422 "Cannot
    // add internal group to a build"). Devino is such a group, so there the
    // attach is a wait-and-verify; a group without it gets an explicit add.
    if (attributes.hasAccessToAllBuilds) {
        console.log(
            `"${groupName}" has access to all builds: waiting for it to pick the build up.`,
        )
        const memberDeadline = Date.now() + BETA_STATE_TIMEOUT_MS
        while (!(await inGroup())) {
            if (Date.now() > memberDeadline) {
                throw new Error(
                    `Build ${build.id} did not appear in "${groupName}" within ${BETA_STATE_TIMEOUT_MS / 60000} minutes although the group has access to all builds.`,
                )
            }
            await sleep(15 * 1000)
        }
    } else if (!(await inGroup())) {
        await api(`/betaGroups/${groupId}/relationships/builds`, {
            method: 'POST',
            body: { data: [{ type: 'builds', id: build.id }] },
        })
        console.log(`Added build ${build.id} to "${groupName}" (${groupId}).`)
    }

    if (!(await inGroup())) {
        throw new Error(
            `Build ${build.id} is not in "${groupName}" after the attach step.`,
        )
    }
    console.log(`Build ${build.id} is in "${groupName}".`)

    const betaDeadline = Date.now() + BETA_STATE_TIMEOUT_MS
    let internalState
    for (;;) {
        const detail = await api(`/builds/${build.id}/buildBetaDetail`)
        internalState = detail.data.attributes.internalBuildState
        console.log(`internalBuildState: ${internalState}`)
        if (internalState === 'IN_BETA_TESTING') break
        if (Date.now() > betaDeadline) {
            throw new Error(
                `Build ${build.id} is in "${groupName}" but its internalBuildState is ${internalState}, not IN_BETA_TESTING (MISSING_EXPORT_COMPLIANCE would mean the ITSAppUsesNonExemptEncryption key did not reach the app bundle).`,
            )
        }
        await sleep(15 * 1000)
    }

    summary(
        `### TestFlight\n\nBuild \`${marketingVersion} (${buildNumber})\` (\`${build.id}\`) is **IN_BETA_TESTING** in internal group "${groupName}". Not submitted for App Review.`,
    )
}

const [command, ...args] = process.argv.slice(2)
if (command === 'next-build-number') {
    await nextBuildNumber()
} else if (command === 'attach-build' && args.length === 3) {
    await attachBuild(...args)
} else if (command === 'version-state' && args.length === 1) {
    await assertTrainClosed(args[0])
} else {
    throw new Error(
        'Usage: asc-testflight.mjs next-build-number | attach-build <marketing-version> <build-number> <group-name> | version-state <marketing-version>',
    )
}
