# Chrome Web Store: Privacy practices tab (dashboard-only fields)

Covers extension 1.4.12 plus the coupon-box pick client (#342, main 1650087), as of 2026-10-14

`apps/caramel-extension/scripts/store-listing.mjs` holds the listing text (name, summary, detailed description). This file holds the privacy tab, which exists only on the Chrome Web Store dashboard. When the extension's data flows change, this file, the dashboard and `apps/caramel-app/src/components/PrivacyPolicy.tsx` change together.

## Status of this disclosure: PROPOSED (not saved as written)

On 2026-10-14 the dashboard showed "Status: Pending review" (1.4.11, submitted 2026-10-13) and the whole Privacy tab was locked: every field disabled, "Save draft" and "Submit for review" disabled, and "Why can't I submit?" answered "You may not edit or publish an item that is in review." Nothing was changed on the dashboard. The review was not cancelled.

What the dashboard held at that moment: the nine data-usage boxes were already ticked exactly as below (Yes for the seven listed, No for health and personal communications), and all three certifications were ticked. The dashboard has no per-category justification field, so the justification column below is not entered anywhere in the dashboard. It is the wording of record that the ticks rest on, and it must stay consistent with the privacy policy. Apply any difference when the review resolves.

## Single purpose (dashboard text, unchanged)

> Caramel finds coupon codes for the online store you're on and applies them at checkout.

## Data usage: what user data is collected

| CWS category                        | Tick | Justification                                                                                                                                                                                                                                                                            |
| ----------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Personally identifiable information | Yes  | Only if you sign in: email, name and profile picture (from Google or Apple sign-in), used to run your account.                                                                                                                                                                           |
| Health information                  | No   |                                                                                                                                                                                                                                                                                          |
| Financial and payment information   | Yes  | Only if you turn on savings sync (off by default): store, code, amount saved, currency and date. Never card numbers, addresses or order details.                                                                                                                                         |
| Authentication information          | Yes  | Only when you sign in: your email and password go to grabcaramel.com (stored there only as a one-way hash), and a session token is sent with API requests.                                                                                                                               |
| Personal communications             | No   |                                                                                                                                                                                                                                                                                          |
| Location                            | Yes  | Our server receives your IP address with each request; it's used for rate limiting and recorded with sign-in sessions. The extension never reads GPS or geolocation.                                                                                                                     |
| Web history                         | Yes  | The hostname of each page you load, to look up coupons and show the badge count. Never the full address or page contents.                                                                                                                                                                |
| User activity                       | Yes  | Which codes worked or failed at a store, with the store's error message, linked to your account when signed in; favorite stores; shared codes only if you opt in. Not clicks, scrolling or keystrokes.                                                                                   |
| Website content                     | Yes  | Cart summary (title, description, store name, up to 6 item names) to work out which codes fit; a trimmed outline of the cart page's control names (digits masked, emails removed, only a fixed list of interface words kept) to find the promo-code box; and the store's rejection text. |

## Certifications (all three ticked)

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

Privacy policy URL: https://grabcaramel.com/privacy
