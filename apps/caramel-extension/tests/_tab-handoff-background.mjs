import { caramelTabHandoffs } from '../tab-handoff.js'

/* The background's side of the per-tab handoffs (tab-handoff.js), for the
 * harnesses that stub runtime.sendMessage. A content script's pending submit,
 * applied win and run now live in the background, so a harness that answered
 * every message with {} would lose them across its simulated reload. This
 * answers the 'tabHandoff' messages the way background.js does, for one tab on
 * this page's origin, over the real store.
 *
 *   const handoffs = tabHandoffBackground()
 *   // in the sendMessage stub:
 *   if (handoffs.answers(message, cb)) return
 *   // or, in a caramelSendMessage mock:
 *   if (message?.action === 'tabHandoff') return handoffs.reply(message)
 *   // in beforeEach:
 *   handoffs.reset()
 */
export function tabHandoffBackground(tabId = 1) {
    let store = caramelTabHandoffs(null)
    const origin = () => location.origin
    async function reply({ op, key, value, expected }) {
        if (op === 'set')
            return { saved: await store.set(tabId, origin(), key, value) }
        if (op === 'replace')
            return {
                saved: await store.replace(
                    tabId,
                    origin(),
                    key,
                    value,
                    expected,
                ),
            }
        if (op === 'get')
            return { value: await store.get(tabId, origin(), key) }
        if (op === 'take')
            return { value: await store.take(tabId, origin(), key) }
        if (op === 'clear') {
            await store.clear(tabId, origin(), key)
            return { cleared: true }
        }
        return { error: 'unknown op' }
    }
    return {
        // True when the message was a handoff and cb will be answered.
        answers(message, cb) {
            if (message?.action !== 'tabHandoff') return false
            reply(message).then(r => {
                if (typeof cb === 'function') cb(r)
            })
            return true
        },
        // The reply itself, for a harness that mocks caramelSendMessage.
        reply,
        // What the background holds for this tab, read without consuming it.
        peek: key => store.get(tabId, origin(), key),
        // Written as the content script would, through the background.
        put: (key, value) => store.set(tabId, origin(), key, value),
        reset() {
            store = caramelTabHandoffs(null)
        },
    }
}
