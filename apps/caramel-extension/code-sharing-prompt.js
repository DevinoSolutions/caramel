// Split out of UI-helpers.js (T-5446), moved verbatim: no behavior change.
import { CARAMEL_ENV } from './caramel-env.js'
import {
    CARAMEL_X_ICON,
    caramelShopperOnly,
    createCaramelShadowHost,
} from './ui-shell.js'

/* -------------------------------------------------- code-sharing consent card
 *
 * The in-extension ask behind checkout code sharing (code-capture.js shows it
 * the first time a code the shopper typed was accepted by the store, sharing
 * could actually happen, and no consent record exists). Owner rule 2026-10-06:
 * explicit opt-in, a clear prompt, off until the shopper accepts.
 *
 * Resolves 'accepted' | 'declined' | 'dismissed'. It RECORDS NOTHING itself —
 * the caller persists the choice, and 'dismissed' (the ×, Esc, or a newer code
 * replacing this card) is deliberately not a choice: it asks again next time.
 * A page navigation destroys the content script, which is the same thing.
 *
 * "Share codes" and "No thanks" share one class and one rule: same size, same
 * weight, same look, neither focused or pre-selected, so declining is exactly
 * as easy as accepting. The code and store come from the page, so they are
 * written with textContent, never into markup. */
const CARAMEL_SHARE_PROMPT_ID = 'caramel-share-prompt'
export async function showCodeSharingPrompt({ site, code }) {
    const { host, root } = await createCaramelShadowHost(
        CARAMEL_SHARE_PROMPT_ID,
    )
    // One card at a time: a newer code replaces an unanswered one (the old
    // caller gets 'dismissed'). Done AFTER the await so two near-simultaneous
    // calls cannot both slip past a check made before it.
    document
        .getElementById(CARAMEL_SHARE_PROMPT_ID)
        ?.__caramelSettle?.('dismissed')

    const card = document.createElement('div')
    card.className = 'caramel-share-card'
    card.setAttribute('role', 'dialog')
    card.setAttribute('aria-modal', 'false')
    card.setAttribute('aria-labelledby', 'caramel-share-title')
    card.innerHTML = `
<button id="caramel-share-close" class="cm-close-fab" type="button" aria-label="Dismiss" title="Ask me later">${CARAMEL_X_ICON}</button>
<h2 id="caramel-share-title" class="caramel-share-title">Share this code with other Caramel shoppers?</h2>
<p class="caramel-share-code"><span id="caramel-share-code-text"></span> <span class="caramel-share-at">at <span id="caramel-share-site-text"></span></span></p>
<p class="caramel-share-body">Caramel would send only the code and the store, linked to your account to prevent abuse — never your cart, order or payment details. Shared codes are shown publicly without your name. Choosing Share codes also turns this on for codes you enter at checkout later. You can change this anytime in Caramel’s settings.</p>
<a id="caramel-share-privacy" class="caramel-share-privacy" target="_blank" rel="noopener noreferrer">Privacy policy</a>
<div class="caramel-share-actions">
<button id="caramel-share-yes" class="caramel-share-btn" type="button">Share codes</button>
<button id="caramel-share-no" class="caramel-share-btn" type="button">No thanks</button>
</div>`
    card.querySelector('#caramel-share-code-text').textContent = code
    card.querySelector('#caramel-share-site-text').textContent = site
    card.querySelector('#caramel-share-privacy').href =
        `${CARAMEL_ENV.baseUrl}/privacy`
    root.appendChild(card)

    return new Promise(resolve => {
        let settled = false
        const onKey = caramelShopperOnly(e => {
            if (e.key === 'Escape') settle('dismissed')
        })
        const settle = choice => {
            if (settled) return
            settled = true
            document.removeEventListener('keydown', onKey, true)
            host.remove()
            resolve(choice)
        }
        host.__caramelSettle = settle
        card.querySelector('#caramel-share-yes').addEventListener(
            'click',
            caramelShopperOnly(() => settle('accepted')),
        )
        card.querySelector('#caramel-share-no').addEventListener(
            'click',
            caramelShopperOnly(() => settle('declined')),
        )
        card.querySelector('#caramel-share-close').addEventListener(
            'click',
            caramelShopperOnly(() => settle('dismissed')),
        )
        // Capture phase and never stopped: Esc must still reach the store's own
        // handlers, we only listen.
        document.addEventListener('keydown', onKey, true)
        document.body.appendChild(host)
    })
}
