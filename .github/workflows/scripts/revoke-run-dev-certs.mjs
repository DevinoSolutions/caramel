#!/usr/bin/env node
// Revokes the "Apple Development: Created via API" certificate(s) that Xcode
// minted on THIS runner during the Safari archive steps.
//
// Why: `xcodebuild archive -allowProvisioningUpdates` with an App Store Connect
// API key creates a fresh development certificate whenever the keychain holds
// no valid one, and its private key dies with the hosted runner. Nothing ever
// revoked them, so the team hit Apple's development-certificate cap and every
// Safari release from v1.4.13 (2026-10-14) failed at archive with "Your account
// has reached the maximum number of certificates". The certificates are useless
// the moment the runner is gone, so the run cleans up after itself.
//
// Precision: it only revokes certificates whose serial number is in THIS
// runner's keychains (a fresh VM per job) AND that App Store Connect lists as a
// DEVELOPMENT certificate named "Created via API". Other repos' or people's
// certificates on the shared team can never match.
//
// Usage: node revoke-run-dev-certs.mjs <path to AuthKey_<id>.p8> [--dry-run]
// Env:   ASC_KEY_ID, ASC_ISSUER_ID
// --dry-run lists what would be revoked and revokes nothing.
import { execFileSync } from 'node:child_process'
import { X509Certificate, createPrivateKey, sign } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'

const API = 'https://api.appstoreconnect.apple.com/v1'
const DISPLAY_NAME = 'Created via API'

const normalizeSerial = serial => serial.toUpperCase().replace(/^0+/, '')

function keychainSerials() {
    // -a: every match, -p: PEM, across the default keychain search list (the
    // login keychain Xcode writes to, plus the imported signing keychain).
    const pem = execFileSync(
        'security',
        ['find-certificate', '-a', '-c', DISPLAY_NAME, '-p'],
        { encoding: 'utf8' },
    )
    const blocks =
        pem.match(
            /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
        ) ?? []
    return new Set(
        blocks.map(block =>
            normalizeSerial(new X509Certificate(block).serialNumber),
        ),
    )
}

function token(keyPath, keyId, issuerId) {
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
        key: createPrivateKey(readFileSync(keyPath)),
        dsaEncoding: 'ieee-p1363',
    })
    return `${unsigned}.${signature.toString('base64url')}`
}

async function api(path, jwt, init = {}) {
    const url = path.startsWith('http') ? path : `${API}${path}`
    const response = await fetch(url, {
        ...init,
        headers: { Authorization: `Bearer ${jwt}` },
    })
    if (!response.ok) {
        throw new Error(
            `${init.method ?? 'GET'} ${url} -> ${response.status}: ${await response.text()}`,
        )
    }
    return response.status === 204 ? null : response.json()
}

async function main() {
    const serials = keychainSerials()
    if (serials.size === 0) {
        console.log(
            `No "${DISPLAY_NAME}" certificate in this runner's keychains: Xcode minted none, nothing to revoke.`,
        )
        return
    }

    const args = process.argv.slice(2)
    const dryRun = args.includes('--dry-run')
    const [keyPath] = args.filter(arg => arg !== '--dry-run')
    const { ASC_KEY_ID, ASC_ISSUER_ID } = process.env
    if (!keyPath || !existsSync(keyPath) || !ASC_KEY_ID || !ASC_ISSUER_ID) {
        throw new Error(
            `The runner holds ${serials.size} "${DISPLAY_NAME}" certificate(s) but the App Store Connect key is missing (path "${keyPath}", ASC_KEY_ID ${ASC_KEY_ID ? 'set' : 'unset'}, ASC_ISSUER_ID ${ASC_ISSUER_ID ? 'set' : 'unset'}), so they cannot be revoked and will count against Apple's certificate cap.`,
        )
    }
    const jwt = token(keyPath, ASC_KEY_ID, ASC_ISSUER_ID)

    const listed = []
    let next = '/certificates?filter[certificateType]=DEVELOPMENT&limit=200'
    while (next) {
        const page = await api(next, jwt)
        listed.push(...page.data)
        next = page.links?.next
    }

    const ours = listed.filter(
        cert =>
            cert.attributes.displayName === DISPLAY_NAME &&
            serials.has(normalizeSerial(cert.attributes.serialNumber)),
    )
    if (ours.length === 0) {
        // Seen when the only match is an expired imported certificate, which
        // App Store Connect no longer lists. Loud, because a cert minted this
        // run that we failed to find would refill the cap.
        console.log(
            `::warning::The runner holds ${serials.size} "${DISPLAY_NAME}" certificate(s), none of them listed by App Store Connect as an active development certificate. Nothing revoked.`,
        )
        return
    }
    for (const cert of ours) {
        if (dryRun) {
            console.log(
                `[dry run] would revoke ${cert.id} (serial ${cert.attributes.serialNumber}, expires ${cert.attributes.expirationDate}).`,
            )
            continue
        }
        await api(`/certificates/${cert.id}`, jwt, { method: 'DELETE' })
        console.log(
            `Revoked this run's development certificate ${cert.id} (serial ${cert.attributes.serialNumber}, expires ${cert.attributes.expirationDate}).`,
        )
    }
}

await main()
