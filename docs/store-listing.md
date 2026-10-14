# Chrome Web Store: Privacy practices tab (dashboard-only fields)

Covers extension 1.4.12 plus the coupon-box pick client (#342, main 1650087), as of 2026-10-14

`apps/caramel-extension/scripts/store-listing.mjs` holds the listing text (name, summary, detailed description). This file holds the privacy tab, which exists only on the Chrome Web Store dashboard. When the extension's data flows change, this file, the dashboard and `apps/caramel-app/src/components/PrivacyPolicy.tsx` change together.

## As on the dashboard (read 2026-10-14)

Read while the item (1.4.11, submitted 2026-10-13) showed "Status: Pending review". The Privacy tab was locked: every field disabled, and the "Unable to publish" dialog said "Address the issues below to publish your item. Remember to Save Draft when you are done." / "You may not edit or publish an item that is in review." Nothing was changed on the dashboard and the review was not cancelled.

### Single purpose

> Caramel finds coupon codes for the online store you're on and applies them at checkout.

### Permission justifications

**tabs**

> Reads the address of the current tab to show the toolbar badge and the popup for the store you are on, and opens the sign-in tab. On every tab switch and page load (http or https pages), the extension sends only that page's hostname to grabcaramel.com, without the sign-in token, to check whether the store has coupons for the toolbar badge. Full page addresses and page contents are never sent.

**storage**

> Stores on the user's device: their settings, their sign-in session token, their account name, email and profile picture (cached for the popup), and a short log of their recent savings. This lets the popup show the signed-in account and savings without asking the server each time.

**identity**

> Used for Google and Apple sign-in through chrome.identity.launchWebAuthFlow, so the user can sign in to their Caramel account from the extension. Caramel receives only its own session token from that flow, never the user's Google or Apple password.

**alarms**

> Keeps the background worker running so the toolbar badge and checkout flow stay responsive.

**Host permission**

> Caramel must run on any store's checkout, because it supports thousands of online stores and new ones are added continually. The content script finds the coupon field and the order total on the checkout page, applies codes, and keeps the one that saves the most.

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

## Pending change, to apply when the item is no longer in review

The coupon-box pick (#342) sends a trimmed cart-page outline, so two permission justifications change. The limit is 1,000 characters each. Nothing below is on the dashboard yet.

### tabs

Before (395 characters):

> Reads the address of the current tab to show the toolbar badge and the popup for the store you are on, and opens the sign-in tab. On every tab switch and page load (http or https pages), the extension sends only that page's hostname to grabcaramel.com, without the sign-in token, to check whether the store has coupons for the toolbar badge. Full page addresses and page contents are never sent.

After (407 characters):

> Reads the address of the current tab to show the toolbar badge and the popup for the store you are on, and opens the sign-in tab. On every tab switch and page load (http or https pages), the extension sends only that page's hostname to grabcaramel.com, without the sign-in token, to check whether the store has coupons for the toolbar badge. This check never sends the full page address or any page content.

### Host permission

Before (262 characters):

> Caramel must run on any store's checkout, because it supports thousands of online stores and new ones are added continually. The content script finds the coupon field and the order total on the checkout page, applies codes, and keeps the one that saves the most.

After (492 characters):

> Caramel must run on any store's checkout, because it supports thousands of online stores and new ones are added continually. The content script finds the coupon field and the order total on the checkout page, applies codes, and keeps the one that saves the most. On a cart page where it cannot locate the promo-code box, and only after the shopper taps apply, it sends a trimmed outline of the page's control labels (no typed values and no other page text) to grabcaramel.com to find the box.

## Per-category justification (repo-only rationale, the dashboard has no field for it)

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
