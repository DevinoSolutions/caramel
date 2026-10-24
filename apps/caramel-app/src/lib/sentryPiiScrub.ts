// src/lib/sentryPiiScrub.ts
//
// The last line of defence between this app and the self-hosted Sentry. Wired
// as beforeSend + beforeSendTransaction + beforeBreadcrumb on every init
// (sentry.common.config.ts for server and edge, instrumentation-client.ts for
// the browser). It runs on top of SENTRY_DATA_COLLECTION (below), so a future
// loosening of that baseline, a new integration or an `extra: { ... }` added at
// a call site cannot start shipping credentials without a test failing.
//
// What never leaves the process: Authorization / Cookie / Set-Cookie headers,
// Bearer tokens, OAuth `code` / `state` / `id_token` / `access_token` (and any
// other token-, secret-, session- or password-shaped param) in URLs, query
// strings and fragments, URL userinfo, bare JWTs, e-mail addresses and raw IPs
// (v4 and v6) in any string. What stays:
// route, method, status, tags, release, the user id (set explicitly via
// Sentry.setUser, never an e-mail), trace ids and everything not matched below.
//
// Deliberately light on imports (types only) so the Sentry init files can use
// it. Mutates in place and returns the same object, which is what the Sentry
// hooks expect.
//
// Two safety rules for the walk. It only descends into plain objects and
// arrays: a live SDK object (the Scope / Client under
// `sdkProcessingMetadata`) has getter-only fields and is not ours to rewrite,
// and `sdkProcessingMetadata` is never entered at all. And a hook that fails
// inside never lets the event through unscrubbed: it logs and drops it.
import type { Breadcrumb, ErrorEvent, init } from '@sentry/nextjs'

// @sentry/nextjs re-exports ErrorEvent but not TransactionEvent; take the type
// from the hook that receives it.
type TransactionEvent = Parameters<
    NonNullable<
        NonNullable<Parameters<typeof init>[0]>['beforeSendTransaction']
    >
>[0]
type Scrubbable = ErrorEvent | TransactionEvent
type DataCollection = NonNullable<
    NonNullable<Parameters<typeof init>[0]>['dataCollection']
>

const SDK_SENSITIVE_HEADER_PARTS = [
    'forwarded',
    '-ip',
    'remote-',
    'via',
    '-user',
]

/**
 * What the SDK itself may collect, shared by every init. SDK v11 replaced
 * `sendDefaultPii` with `dataCollection` and made the unset default
 * PERMISSIVE (user IP, cookies, request/response bodies, DB queries, GenAI
 * inputs/outputs). This is the SDK's documented "keep the v10 default"
 * baseline, i.e. exactly what `sendDefaultPii: false` collected (T-5535 M5
 * turned that flag off on purpose). tests/unit/sentry-pii-scrub.test.ts pins
 * it, so leaving it out of an init or loosening a field fails a test.
 */
export const SENTRY_DATA_COLLECTION = {
    userInfo: false,
    cookies: false,
    httpHeaders: {
        request: { deny: SDK_SENSITIVE_HEADER_PARTS },
        response: { deny: SDK_SENSITIVE_HEADER_PARTS },
    },
    httpBodies: [],
    urlQueryParams: { deny: SDK_SENSITIVE_HEADER_PARTS },
    genAI: { inputs: false, outputs: false },
    databaseQueryData: false,
    queues: false,
    graphQL: { document: false, variables: false },
} satisfies DataCollection

export const FILTERED = '[Filtered]'
const FILTERED_EMAIL = '[Filtered email]'
const FILTERED_JWT = '[Filtered jwt]'
const FILTERED_IP = '[Filtered ip]'

/** Deeper than any real event; a guard against cycles, not a feature. */
const MAX_DEPTH = 20

/** Query/fragment/body param names that are credentials or identify a person.
 * Matched exactly (case-insensitive) because the words are too common as
 * substrings (`state` in `estate`, `sid` in `inside`). */
const SENSITIVE_PARAM_EXACT: ReadonlySet<string> = new Set([
    'code',
    'state',
    'nonce',
    'code_verifier',
    'code_challenge',
    'key',
    'apikey',
    'api_key',
    'sid',
    'email',
    'login_hint',
    'hint',
    'user',
    'username',
])

/** Substrings that make a param or header name sensitive (`id_token`,
 * `x-auth-token`, `session_id`, `client_secret`, `Set-Cookie`, ...). */
const SENSITIVE_NAME_SUBSTRINGS: readonly string[] = [
    'token',
    'secret',
    'password',
    'passwd',
    'auth',
    'cookie',
    'session',
    'credential',
    'signature',
    'api-key',
    'jwt',
    'bearer',
    'csrf',
    'xsrf',
]

/** Object keys redacted wherever they appear in an event (extras, contexts,
 * headers, breadcrumb data, span data). Normalized: lowercase, no `-` or `_`,
 * so `userEmail`, `user_email` and `User-Email` are one entry. Exact, not
 * substring, because an extra named `maxKeys` or `tokenCount` is triage data. */
const SENSITIVE_OBJECT_KEYS: ReadonlySet<string> = new Set([
    'authorization',
    'proxyauthorization',
    'cookie',
    'setcookie',
    'xapikey',
    'xauthtoken',
    'xcsrftoken',
    'password',
    'secret',
    'clientsecret',
    'token',
    'accesstoken',
    'refreshtoken',
    'idtoken',
    'sessiontoken',
    'bearer',
    'clientaddress',
    'networkpeeraddress',
    'xclientip',
    'trueclientip',
    'xclusterclientip',
    'fastlyclientip',
    'email',
    'useremail',
    'ip',
    'ipaddress',
    'remoteaddr',
    'clientip',
    'xforwardedfor',
    'xrealip',
    'cfconnectingip',
    'forwarded',
])

function normalizeKey(key: string): string {
    return key.toLowerCase().replace(/[-_.]/g, '')
}

/** Span attributes are dotted (`http.request.header.cookie`), so the last
 * segment is checked as well as the whole key. */
function lastSegment(key: string): string {
    return key.slice(key.lastIndexOf('.') + 1)
}

function safeDecode(value: string): string {
    try {
        return decodeURIComponent(value)
    } catch {
        // Not valid percent-encoding: judge the raw text.
        return value
    }
}

/** True when a query/fragment/form/header NAME must have its value removed. */
function isSensitiveParamName(rawName: string): boolean {
    const name = safeDecode(rawName).toLowerCase()
    if (SENSITIVE_PARAM_EXACT.has(name)) return true
    return SENSITIVE_NAME_SUBSTRINGS.some(part => name.includes(part))
}

function isSensitiveObjectKey(key: string): boolean {
    return (
        SENSITIVE_OBJECT_KEYS.has(normalizeKey(key)) ||
        SENSITIVE_OBJECT_KEYS.has(normalizeKey(lastSegment(key)))
    )
}

const PARAM_PAIR = /(^|[?&#])([\w.%[\]-]+)=([^&#\s"'<>]*)/g
const BEARER_TOKEN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@?#]+@/gi
/** Three base64url parts starting with the `{"` header: a JWT anywhere. */
const BARE_JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g
/** `"id_token":"..."` / `'code': '...'` inside a string (a JSON body in a message). */
const JSON_STRING_PAIR = /(["'])([\w.-]+)\1(\s*:\s*)(["'])((?:\\.|(?!\4).)*)\4/g
/** The domain must start with a letter and end in a letters-only label, so
 * `pkg@1.4.17-beta.rc` and `foo@1.2.3-rc.beta/x.js` are not e-mails. */
const EMAIL =
    /[A-Za-z0-9._%+-]+@[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
const OCTET = '(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)'
/** Dotted quad, not part of a longer number, path or version (`Chrome/120.0.0.0`,
 * `v1.2.3.4`, `1.2.3.4.5`). */
const IPV4 = new RegExp(
    `(?<![\\w./@-])(?:${OCTET}\\.){3}${OCTET}(?![\\w]|\\.\\d)`,
    'g',
)
const IPV6 =
    /(?<![\w:])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,5})?|::(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})(?![\w:])/gi

/** Redact credentials, e-mail addresses and IPs inside free text: a URL, a
 * query string, an error message, a breadcrumb line. Text without any of them
 * is returned unchanged. */
export function redactSensitiveText(text: string): string {
    return text
        .replace(URL_USERINFO, `$1${FILTERED}@`)
        .replace(
            PARAM_PAIR,
            (match, lead: string, name: string, value: string) => {
                if (isSensitiveParamName(name)) {
                    return `${lead}${name}=${FILTERED}`
                }
                // A non-credential param can still carry a whole URL
                // (`?next=%2Fcb%3Fcode%3Dabc`): if the decoded value holds a
                // credential, the value goes.
                const decoded = safeDecode(value)
                if (
                    decoded !== value &&
                    redactSensitiveText(decoded) !== decoded
                ) {
                    return `${lead}${name}=${FILTERED}`
                }
                return match
            },
        )
        .replace(
            JSON_STRING_PAIR,
            (
                match,
                keyQuote: string,
                name: string,
                colon: string,
                quote: string,
            ) =>
                isSensitiveParamName(name)
                    ? `${keyQuote}${name}${keyQuote}${colon}${quote}${FILTERED}${quote}`
                    : match,
        )
        .replace(BEARER_TOKEN, `$1 ${FILTERED}`)
        .replace(BARE_JWT, FILTERED_JWT)
        .replace(EMAIL, FILTERED_EMAIL)
        .replace(IPV4, FILTERED_IP)
        .replace(IPV6, FILTERED_IP)
}

/** Only plain data is walked and rewritten; class instances (Scope, Client,
 * Date, Error, ...) are left alone. */
function isPlainObject(value: object): value is Record<string, unknown> {
    const proto: unknown = Object.getPrototypeOf(value)
    return proto === Object.prototype || proto === null
}

function scrubNode(node: unknown, depth: number): unknown {
    if (typeof node === 'string') return redactSensitiveText(node)
    if (typeof node !== 'object' || node === null) return node
    if (depth > MAX_DEPTH) return '[Truncated]'
    if (Array.isArray(node)) {
        const list: unknown[] = node
        for (let i = 0; i < list.length; i += 1) {
            list[i] = scrubNode(list[i], depth + 1)
        }
        return list
    }
    if (!isPlainObject(node)) return node
    const record = node
    for (const key of Object.keys(record)) {
        // Live SDK state (scopes, client): not event data, never entered.
        if (key === 'sdkProcessingMetadata') continue
        const value = record[key]
        if (value === null || value === undefined) continue
        record[key] = isSensitiveObjectKey(key)
            ? FILTERED
            : scrubNode(value, depth + 1)
    }
    return record
}

type QueryString = NonNullable<ErrorEvent['request']>['query_string']

/** `request.query_string` is a string, an object or a list of [name, value]
 * pairs depending on the SDK that captured it. */
function scrubQueryString(queryString: QueryString): QueryString {
    if (typeof queryString === 'string') return redactSensitiveText(queryString)
    if (Array.isArray(queryString)) {
        return queryString.map(([name, value]): [string, string] => [
            name,
            isSensitiveParamName(name) ? FILTERED : redactSensitiveText(value),
        ])
    }
    if (queryString) {
        for (const key of Object.keys(queryString)) {
            queryString[key] = isSensitiveParamName(key)
                ? FILTERED
                : redactSensitiveText(queryString[key] ?? '')
        }
    }
    return queryString
}

/** The request block: cookies and bodies are never useful for triage and are
 * dropped; the query string keeps its non-credential params. */
function scrubRequest(request: NonNullable<ErrorEvent['request']>): void {
    delete request.cookies
    delete request.data
    if (request.env) {
        delete request.env['REMOTE_ADDR']
    }
    if (request.query_string !== undefined) {
        request.query_string = scrubQueryString(request.query_string)
    }
    if (request.headers) {
        for (const name of Object.keys(request.headers)) {
            if (isSensitiveObjectKey(name) || isSensitiveParamName(name)) {
                request.headers[name] = FILTERED
            }
        }
    }
}

function scrubUser(user: NonNullable<ErrorEvent['user']>): void {
    delete user.ip_address
    delete user.email
    delete user.username
}

function reportScrubFailure(hook: string, error: unknown): void {
    // Name and message only: the event payload is what must not be logged.
    const reason =
        error instanceof Error
            ? `${error.name}: ${error.message}`
            : 'non-Error throw'
    console.error(
        `[sentry-pii-scrub] ${hook} failed, dropping it unsent: ${reason}`,
    )
}

/** Scrub one error or transaction event. Everything below `event` is walked, so
 * request, extra, contexts, breadcrumbs, exception values and spans (`http.url`,
 * `url.query`, span descriptions) are all covered. Returns null (drops the
 * event) if scrubbing itself fails: an unscrubbed event is never sent. */
export function scrubSentryEvent<T extends Scrubbable>(event: T): T | null {
    try {
        if (event.request) scrubRequest(event.request)
        if (event.user) scrubUser(event.user)
        scrubNode(event, 0)
        return event
    } catch (error) {
        reportScrubFailure('beforeSend', error)
        return null
    }
}

/** beforeBreadcrumb: fetch / xhr / navigation URLs and console lines. Returns
 * null (drops the breadcrumb) if scrubbing fails. */
export function scrubSentryBreadcrumb(
    breadcrumb: Breadcrumb,
): Breadcrumb | null {
    try {
        scrubNode(breadcrumb, 0)
        return breadcrumb
    } catch (error) {
        reportScrubFailure('beforeBreadcrumb', error)
        return null
    }
}
