# Chrome Web Store: Privacy practices tab (dashboard-only fields)

Covers extension 1.4.14 (adds the opt-in anonymous code-sharing diagnostics), as of 2026-10-15

`apps/caramel-extension/scripts/store-listing.mjs` holds the listing text (name, summary, detailed description). This file holds the privacy tab, which exists only on the Chrome Web Store dashboard. When the extension's data flows change, this file, the dashboard and `apps/caramel-app/src/components/PrivacyPolicy.tsx` change together.

## As on the dashboard (read 2026-10-15)

Read on 2026-10-15: the item was editable (status "Published - public"). The tabs and Host permission justifications below were saved as a draft and not submitted; they go live with the next submission.

### Single purpose

> Caramel finds coupon codes for the online store you're on and applies them at checkout.

### Permission justifications

**tabs**

> Reads the address of the current tab to show the toolbar badge and the popup for the store you are on, and opens the sign-in tab. On every tab switch and page load (http or https pages), the extension sends only that page's hostname to grabcaramel.com, without the sign-in token, to check whether the store has coupons for the toolbar badge. This check never sends the full page address or any page content.

**storage**

> Stores on the user's device: their settings, their sign-in session token, their account name, email and profile picture (cached for the popup), and a short log of their recent savings. This lets the popup show the signed-in account and savings without asking the server each time.

**identity**

> Used for Google and Apple sign-in through chrome.identity.launchWebAuthFlow, so the user can sign in to their Caramel account from the extension. Caramel receives only its own session token from that flow, never the user's Google or Apple password.

**alarms**

> Keeps the background worker running so the toolbar badge and checkout flow stay responsive.

**Host permission**

> Caramel must run on any store's checkout, because it supports thousands of online stores and new ones are added continually. The content script finds the coupon field and the order total on the checkout page, applies codes, and keeps the one that saves the most. On a cart page where it cannot locate the promo-code box, and only after the shopper taps apply, it sends a trimmed outline of the page's control labels (no typed values and no other page text) to grabcaramel.com to find the box. When a box it found that way works, it reports the box's location (the hostname and CSS selectors, never codes or page text) so other shoppers on that store can be shown it.

### Remote code

> No, I am not using remote code

### Data usage ticks

Ticked: Personally identifiable information, Financial and payment information, Authentication information, Location, Web history, User activity, Website content.

Not ticked: Health information, Personal communications.

### Certifications (all three ticked)

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

### Privacy policy URL

https://grabcaramel.com/privacy

## Per-category justification (repo-only rationale, the dashboard has no field for it)

| CWS category                        | Tick | Justification                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Personally identifiable information | Yes  | Only if you sign in: email, name and profile picture (from Google or Apple sign-in), used to run your account.                                                                                                                                                                                                                                                                                    |
| Health information                  | No   |                                                                                                                                                                                                                                                                                                                                                                                                   |
| Financial and payment information   | Yes  | Only if you turn on savings sync (off by default): store, code, amount saved, currency and date. Never card numbers, addresses or order details.                                                                                                                                                                                                                                                  |
| Authentication information          | Yes  | Only when you sign in: your email and password go to grabcaramel.com (stored there only as a one-way hash), and a session token is sent with API requests.                                                                                                                                                                                                                                        |
| Personal communications             | No   |                                                                                                                                                                                                                                                                                                                                                                                                   |
| Location                            | Yes  | Our server receives your IP address with each request; it's used for rate limiting and recorded with sign-in sessions. The extension never reads GPS or geolocation.                                                                                                                                                                                                                              |
| Web history                         | Yes  | The hostname of each page you load, to look up coupons and show the badge count. Never the full address or page contents.                                                                                                                                                                                                                                                                         |
| User activity                       | Yes  | Which codes worked or failed at a store, with the store's error message, linked to your account when signed in; favorite stores; shared codes only if you opt in; and, only if you opt in, anonymous diagnostics of which step of the code-sharing offer was reached and why it stopped (the store, extension version and browser; never a code or account). Not clicks, scrolling or keystrokes. |
| Website content                     | Yes  | Cart summary (title, description, store name, up to 6 item names) to work out which codes fit; a trimmed outline of the cart page's control names (digits masked, emails removed, only a fixed list of interface words kept) to find the promo-code box; the location (CSS selectors) of a promo-code box that worked on that store, with no codes or page text; and the store's rejection text.  |
