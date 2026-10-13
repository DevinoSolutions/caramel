// owns: the checkout-code-sharing CONSENT record (checkoutCodeSharingConsent in
// chrome.storage.sync) — its shape, its strict parser, and the one read/write
// pair every realm uses (content script, popup, service worker).
//
// WHY THIS IS ITS OWN RECORD. Sharing a code the shopper typed is allowed ONLY
// after the shopper said yes to a clear in-extension prompt (or switched the
// popup setting on, which is the same explicit yes). Owner rule 2026-10-06,
// the Honey-lawsuit lesson: a privacy-policy sentence is not consent. So the
// record carries WHAT was chosen, WHEN, and WHICH prompt text version, and it
// is deliberately NOT a key inside `caramel_settings`: the retired legacy
// setting `shareCheckoutCodes` defaulted ON, and any stale `true` it left in
// storage must never be mistaken for consent. Nothing reads that key any more.
//
// Shape: { choice: 'accepted' | 'declined', at: ISO-8601 string, promptVersion: 1 }
// Anything else — absent, wrong type, unknown choice, unparsable date, another
// prompt version — parses to null, and null means NOT allowed. Bumping
// CODE_SHARING_PROMPT_VERSION when the prompt's meaning changes therefore
// re-asks every shopper, by construction.
//
// Pure: callers pass the browser handle, so this module is safe to import into
// the service worker (it touches no DOM and has no top-level effects).
export const CODE_SHARING_CONSENT_KEY = 'checkoutCodeSharingConsent'
const CODE_SHARING_PROMPT_VERSION = 1

// Stored value -> the record, or null when it is not exactly a valid record.
export function parseCodeSharingConsent(raw) {
    if (!raw || typeof raw !== 'object') return null
    if (raw.choice !== 'accepted' && raw.choice !== 'declined') return null
    if (raw.promptVersion !== CODE_SHARING_PROMPT_VERSION) return null
    if (typeof raw.at !== 'string' || Number.isNaN(Date.parse(raw.at)))
        return null
    return { choice: raw.choice, at: raw.at, promptVersion: raw.promptVersion }
}

// The ONE gate: capture may send a code only for an explicit, current "yes".
export function codeSharingAccepted(record) {
    return record?.choice === 'accepted'
}

// Resolves the parsed record (null when none). REJECTS when storage itself
// fails, so a broken read is loud; every caller treats a rejection as "no
// consent" (fail closed) after reporting it.
export function readCodeSharingConsent(browser) {
    return new Promise((resolve, reject) => {
        try {
            browser.storage.sync.get([CODE_SHARING_CONSENT_KEY], res => {
                const err = browser.runtime.lastError
                if (err) {
                    reject(
                        new Error(
                            `code-sharing consent read failed: ${err.message}`,
                        ),
                    )
                    return
                }
                resolve(
                    parseCodeSharingConsent(res?.[CODE_SHARING_CONSENT_KEY]),
                )
            })
        } catch (err) {
            reject(err)
        }
    })
}

// Records the shopper's choice. Resolves the stored record; REJECTS if it could
// not be persisted — a "yes" that was never saved must not be acted on.
export function writeCodeSharingConsent(browser, choice) {
    if (choice !== 'accepted' && choice !== 'declined')
        return Promise.reject(
            new Error(`code-sharing consent: unknown choice "${choice}"`),
        )
    const record = {
        choice,
        at: new Date().toISOString(),
        promptVersion: CODE_SHARING_PROMPT_VERSION,
    }
    return new Promise((resolve, reject) => {
        try {
            browser.storage.sync.set(
                { [CODE_SHARING_CONSENT_KEY]: record },
                () => {
                    const err = browser.runtime.lastError
                    if (err) {
                        reject(
                            new Error(
                                `code-sharing consent write failed: ${err.message}`,
                            ),
                        )
                        return
                    }
                    resolve(record)
                },
            )
        } catch (err) {
            reject(err)
        }
    })
}
