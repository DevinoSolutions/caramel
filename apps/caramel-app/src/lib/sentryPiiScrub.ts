// src/lib/sentryPiiScrub.ts
//
// The last line of defence between this app and the self-hosted Sentry. Wired
// as beforeSend + beforeSendTransaction + beforeBreadcrumb on every init
// (sentry.common.config.ts for server and edge, instrumentation-client.ts for
// the browser). It runs on top of `sendDefaultPii: false`, so a future flip of
// that flag, a new integration or an `extra: { ... }` added at a call site
// cannot start shipping credentials without a test failing.
//
// What never leaves the process: Authorization / Cookie / Set-Cookie headers,
// Bearer tokens, OAuth `code` / `state` / `id_token` / `access_token` (and any
// other token-, secret-, session- or password-shaped param) in URLs, query
// strings and fragments, URL userinfo, e-mail addresses and raw IPs. What stays:
// route, method, status, tags, release, the user id (set explicitly via
// Sentry.setUser, never an e-mail), trace ids and everything not matched below.
//
// Deliberately light on imports (types only) so the Sentry init files can use
// it. Mutates in place and returns the same object, which is what the Sentry
// hooks expect.
import type { Breadcrumb, ErrorEvent, init } from '@sentry/nextjs'

// @sentry/nextjs re-exports ErrorEvent but not TransactionEvent; take the type
// from the hook that receives it.
type TransactionEvent = Parameters<
    NonNullable<
        NonNullable<Parameters<typeof init>[0]>['beforeSendTransaction']
    >
>[0]
type Scrubbable = ErrorEvent | TransactionEvent

export const FILTERED = '[Filtered]'
const FILTERED_EMAIL = '[Filtered email]'

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
    return key.toLowerCase().replace(/[-_]/g, '')
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
    return SENSITIVE_OBJECT_KEYS.has(normalizeKey(key))
}

const PARAM_PAIR = /(^|[?&#])([\w.%[\]-]+)=([^&#\s"'<>]*)/g
const BEARER_TOKEN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@?#]+@/gi
const EMAIL =
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g

/** Redact credentials and e-mail addresses inside free text: a URL, a query
 * string, an error message, a breadcrumb line. Text without any of them is
 * returned unchanged. */
export function redactSensitiveText(text: string): string {
    return text
        .replace(URL_USERINFO, `$1${FILTERED}@`)
        .replace(PARAM_PAIR, (match, lead: string, name: string) =>
            isSensitiveParamName(name) ? `${lead}${name}=${FILTERED}` : match,
        )
        .replace(BEARER_TOKEN, `$1 ${FILTERED}`)
        .replace(EMAIL, FILTERED_EMAIL)
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
    const record = node as Record<string, unknown>
    for (const key of Object.keys(record)) {
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

/** Scrub one error or transaction event. Everything below `event` is walked, so
 * request, extra, contexts, breadcrumbs, exception values and spans (`http.url`,
 * `url.query`, span descriptions) are all covered. */
export function scrubSentryEvent<T extends Scrubbable>(event: T): T {
    if (event.request) scrubRequest(event.request)
    if (event.user) scrubUser(event.user)
    scrubNode(event, 0)
    return event
}

/** beforeBreadcrumb: fetch / xhr / navigation URLs and console lines. */
export function scrubSentryBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
    scrubNode(breadcrumb, 0)
    return breadcrumb
}
