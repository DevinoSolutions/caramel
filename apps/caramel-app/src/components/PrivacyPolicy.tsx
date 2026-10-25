import { motion } from 'framer-motion'
import Link from 'next/link'
import type { ReactNode } from 'react'
import {
    FaBan,
    FaChartLine,
    FaDatabase,
    FaEdit,
    FaEnvelope,
    FaLock,
    FaMobileAlt,
    FaShareAlt,
    FaShieldAlt,
    FaUserShield,
} from 'react-icons/fa'

// The Chrome Web Store reviews this page against the extension (rejected
// 2026-09-22, "Purple Nickel": the policy must cover collection, use, storage
// and sharing of ALL user data the extension touches, naming every party).
// Every item below maps to a real data flow; when the extension or the server
// starts touching new data, this page changes in the same PR. Wording is the
// owner's (DESIGN.md §2(l′)): edits need owner sign-off.
//
// DRAFT 2026-10-24 (T-7842, T-7505), awaiting owner sign-off: the "Our Mobile
// Apps" section, the extension analytics sentence, the promo-box suggestion
// bullets and the in-app deletion bullet came with the iOS and Android apps.
// Each maps to code; the PR body lists the file:line evidence per sentence.

// Class strings that mix custom colours (caramel, darkBg) with standard ones sort differently under the repo-root prettier (husky) and apps/caramel-app (CI). Held in constants, which prettier-plugin-tailwindcss does not sort, so both agree.
const BULLET_DOT_CLASS = 'bg-caramel mt-2 h-2 w-2 shrink-0 rounded-full'

const SUB_HEADING_CLASS =
    'mb-3 mt-2 text-lg font-semibold text-gray-900 dark:text-white'

const INLINE_LINK_CLASS =
    'text-caramel font-semibold underline hover:no-underline'

const EFFECTIVE_DATE_BADGE_CLASS =
    'bg-caramel/10 text-caramel mb-6 inline-flex items-center gap-3 rounded-full px-6 py-3 text-sm font-semibold'

const BRAND_NAME_CLASS = 'text-caramel font-semibold'

const SECTION_CARD_CLASS =
    'border-caramel/20 from-caramel/5 to-caramel/5 dark:border-caramel/30 dark:from-caramel/10 dark:to-caramel/10 relative overflow-hidden rounded-3xl border bg-gradient-to-br via-orange-50/30 p-8 dark:via-orange-900/20'

const SECTION_ICON_CLASS =
    'bg-caramel/10 text-caramel dark:bg-caramel/20 flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-xl'

const SECTION_TITLE_CLASS =
    'mb-4 text-2xl font-bold text-gray-900 lg:text-xl dark:text-white'

const CONTACT_CARD_CLASS =
    'border-caramel/20 from-caramel/5 to-caramel/5 dark:border-caramel/30 dark:from-caramel/10 dark:to-caramel/10 rounded-3xl border bg-gradient-to-br via-orange-50/30 p-8 dark:via-orange-900/20'

const CONTACT_ICON_CLASS =
    'bg-caramel/10 text-caramel dark:bg-caramel/20 flex h-12 w-12 items-center justify-center rounded-2xl text-xl'

const MAILTO_LINK_CLASS =
    'text-caramel focus-visible:ring-caramel dark:focus-visible:ring-offset-darkBg inline-flex items-center gap-2 rounded-md font-semibold transition-colors duration-200 hover:text-orange-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2'

const UPDATES_BANNER_CLASS =
    'from-caramel mx-auto mt-12 max-w-4xl rounded-3xl bg-gradient-to-r to-orange-600 p-8 text-center text-white shadow-lg'

function Bullets({ items }: { items: ReactNode[] }) {
    return (
        <ul className="mb-4 space-y-2 text-gray-600 dark:text-gray-400">
            {items.map((item, i) => (
                <li key={i} className="flex items-start gap-3">
                    <span className={BULLET_DOT_CLASS}></span>
                    <span>{item}</span>
                </li>
            ))}
        </ul>
    )
}

function Para({ children }: { children: ReactNode }) {
    return <p className="mb-4 text-gray-600 dark:text-gray-400">{children}</p>
}

function Sub({ children }: { children: ReactNode }) {
    return <h3 className={SUB_HEADING_CLASS}>{children}</h3>
}

const PrivacyPolicy = () => {
    const sections = [
        {
            id: 'info-collect',
            title: 'What Information Do We Collect?',
            icon: <FaUserShield />,
            content: (
                <>
                    <Para>
                        The Caramel extension talks only to Caramel&apos;s own
                        server (grabcaramel.com). The extension itself contains
                        no ads, no third-party trackers and no third-party
                        analytics code. The only analytics it starts itself are
                        the optional anonymous usage diagnostics described
                        below, which go to Caramel&apos;s own server and are off
                        unless you opt in. Two other flows are described below
                        and are not diagnostics: the outcome event our server
                        records for a promo-code box lookup, and the install ID
                        and first-touch record sent when you sign in.
                    </Para>
                    <Sub>Whether or not you are signed in</Sub>
                    <Bullets
                        items={[
                            <>
                                <strong>The website you are on.</strong>{' '}
                                Whenever you load a web page (http or https) or
                                switch to a tab, the extension sends that
                                page&apos;s hostname (for example,
                                &quot;amazon.com&quot;) to our server to check
                                whether we have coupons for it, show the number
                                on the toolbar icon, and load the store&apos;s
                                codes. Only the hostname is sent for this, never
                                the full page address or the page&apos;s
                                contents, and the toolbar-icon check is sent
                                without your sign-in token.
                            </>,
                            <>
                                <strong>Cart page details.</strong> When some of
                                a store&apos;s codes only apply to certain
                                products, the extension sends a short summary of
                                the cart page so we can tell which codes fit:
                                the store&apos;s hostname, the page path, the
                                page title and description, the store name, and
                                the names of up to 6 items in your cart. It
                                never sends payment card details, your address,
                                your order number or order history, or passwords
                                you type into a store.
                            </>,
                            // This wording is final. Its claims are pinned by
                            // tests/unit/privacy-policy-coverage.test.tsx;
                            // anyone changing the coupon-box pick
                            // (api/extension/coupon-box-pick, couponBoxPick.ts)
                            // or coupon-box-outline.js must update both this
                            // text and that test.
                            <>
                                <strong>
                                    Finding the promo-code box on a cart page.
                                </strong>{' '}
                                When a store&apos;s known rules do not locate
                                its promo-code box, the extension looks for it
                                on the page, on your device. Nothing new is sent
                                to Caramel for that, except that the extension
                                reads Caramel&apos;s feature switches from our
                                server. If that also fails, and only after you
                                tap to apply codes, the extension sends one
                                request to our server (at most once per store in
                                a browser tab). The request contains the
                                store&apos;s hostname and a trimmed outline of
                                the cart page&apos;s buttons, links, headings
                                and form-control labels. Each name in the
                                outline is cut to at most 100 characters, every
                                digit is replaced with &quot;#&quot;,
                                email-shaped text is replaced with a
                                placeholder, and every word that is not on a
                                fixed list of common interface and coupon words
                                is dropped. The request never contains text you
                                typed into fields, the page text outside that
                                outline, or the page&apos;s address path or
                                query. Its contents are the same whether or not
                                you are signed in; the extension attaches its
                                usual sign-in token as it does on other
                                requests, but our server does not use it to
                                identify you for this request. Our server asks
                                an AI model which control on the page is the
                                code box (see &quot;Who Do We Share It
                                With?&quot; below), and records the outcome, the
                                timings, the store&apos;s hostname and the
                                model&apos;s name as an event in our self-hosted
                                analytics, not tied to you or your account.
                            </>,
                            <>
                                <strong>Coupon results.</strong> Which codes
                                worked or failed at a store, and the
                                store&apos;s error message when a code is
                                rejected (for example, &quot;This code has
                                expired&quot;).
                            </>,
                            <>
                                <strong>Your settings.</strong> Whether
                                auto-apply is on, the sites where you paused
                                Caramel, and your savings-sync and
                                checkout-sharing choices.
                            </>,
                            <>
                                <strong>
                                    Anonymous usage diagnostics, only if you opt
                                    in.
                                </strong>{' '}
                                If you press Allow on the extension&apos;s
                                &quot;Help improve Caramel?&quot; card, or
                                switch on &quot;Send anonymous usage
                                diagnostics&quot; in its settings (it is off by
                                default; Firefox also asks for its own
                                permission), the extension sends anonymous
                                diagnostics when you are at checkout on a
                                supported store: which store, whether the
                                code-sharing offer appeared, and why a code
                                wasn&apos;t shared, along with the extension
                                version and your browser. These events go to our
                                self-hosted analytics under a random ID created
                                on this device when you opt in, not linked to
                                your account or install ID. They never include
                                your codes, your cart, the other pages you
                                visit, or anything that identifies you. You can
                                change this anytime in the extension&apos;s
                                settings. Switching it off deletes this
                                device&apos;s random diagnostics ID; anything
                                already sent can&apos;t be linked back to you.
                            </>,
                        ]}
                    />
                    <Sub>If you create an account or sign in</Sub>
                    <Bullets
                        items={[
                            <>
                                <strong>Account details.</strong> Your email
                                address, name and profile picture. If you sign
                                in with email, your password is sent to our
                                server to sign you in and is stored only as a
                                one-way hash. If you sign in with Google or
                                Apple, we receive your name, email address and
                                profile picture from that provider.
                            </>,
                            <>
                                <strong>Sign-in session.</strong> A session
                                token kept in the extension so you stay signed
                                in. Our server records the session along with
                                the IP address and browser type it was created
                                from.
                            </>,
                            <>
                                <strong>How you first found Caramel.</strong>{' '}
                                Our website keeps a small first-party record of
                                the campaign, link or site that first sent you
                                to it, and the first page you landed on, and
                                links it to your account when you sign up. If
                                you sign in from the extension, it sends us the
                                same record, which it reads only from
                                grabcaramel.com, together with a random install
                                ID, so your account is attributed the same way.
                            </>,
                            <>
                                <strong>Favorite stores</strong> you mark in the
                                extension or on the website.
                            </>,
                            <>
                                <strong>
                                    Coupon results linked to your account
                                </strong>
                                , at most once per code per day, to keep results
                                honest and stop abuse.
                            </>,
                            <>
                                <strong>Savings history</strong>, only if you
                                turn on savings sync (it is off by default): the
                                store, the code, the amount saved, the currency
                                and the date.
                            </>,
                            <>
                                <strong>
                                    Coupon codes you choose to share.
                                </strong>{' '}
                                If you&apos;re signed in, you can add a code on
                                a store page, and, if the extension&apos;s
                                &quot;Share codes I enter at checkout&quot;
                                setting is on, the extension sends a code you
                                typed yourself once the store accepts it. We
                                store only the code, the store, and your account
                                (to limit abuse); never your cart, order or
                                payment details. Shared codes are shown publicly
                                to other shoppers without your name. You can
                                turn checkout sharing off at any time in the
                                extension&apos;s settings.
                            </>,
                            <>
                                <strong>
                                    Promo-box suggestions, only while Caramel
                                    has this feature switched on.
                                </strong>{' '}
                                If you&apos;re signed in and the extension finds
                                a promo-code box on a store we have no saved
                                rules for, and a code applied there takes money
                                off the total, the extension sends our server
                                the store&apos;s hostname and up to four CSS
                                selectors (page-element identifiers) that locate
                                that box: the code field, the apply button, a
                                button that opens the box, and the order total.
                                It sends this at most once per store in a
                                browser session. It never sends the code, the
                                price, your cart or anything you typed. We store
                                the suggestion with your account to limit abuse,
                                and a store&apos;s saved rules change only after
                                several different signed-in shoppers suggest the
                                same box.
                            </>,
                        ]}
                    />
                    <Sub>On our website</Sub>
                    <Para>
                        When you visit grabcaramel.com we collect usage
                        analytics and error reports as described under
                        &quot;Website Analytics &amp; Cookies&quot; below.
                    </Para>
                    <Para>
                        If you type in a store search box on the website or in
                        our apps, the text you type is sent to our server (to
                        /api/coupons/stores, /api/coupons or the
                        supported-stores search) so we can return matching
                        stores. We do not write it to our application logs, and
                        the access log of our own proxy is switched off.
                        Cloudflare, our network provider, passes the request to
                        our servers in transit. Since October 25, 2026 we also
                        remove search text from error reports (including session
                        replays) before they are stored. Error reports captured
                        before that date may still contain it until they expire,
                        90 days after capture (by January 23, 2027 at the
                        latest).
                    </Para>
                    <Para>
                        If you use our store-request form we collect the store
                        address you enter, your browser type, and your email if
                        you give one (or your account email if you are signed
                        in), and keep it so we can add the store and tell you
                        when it is supported. If you contact support we collect
                        your message, the page you were on and, if you want a
                        reply, your email; it is emailed to our support inbox
                        and logged in our self-hosted analytics. If you add a
                        coupon code on a store page, we store the code and the
                        store linked to your account, as described above.
                    </Para>
                </>
            ),
        },
        {
            id: 'mobile-apps',
            title: 'Our Mobile Apps',
            icon: <FaMobileAlt />,
            content: (
                <>
                    <Para>
                        Caramel also has an iOS app and an Android app. The
                        apps&apos; own code sends requests only to
                        Caramel&apos;s server (grabcaramel.com); the one
                        addition is the Android web view&apos;s Safe Browsing
                        check, described below. Each app shows pages from
                        grabcaramel.com, so what this policy says about our
                        website applies to those pages inside the apps.
                    </Para>
                    <Sub>The iOS app</Sub>
                    <Bullets
                        items={[
                            'The app has five tabs. Deals, Search and Saved show grabcaramel.com pages in a web view; Get started and Account are native screens.',
                            'The Caramel Safari extension is bundled with the app. It is the extension described in this policy.',
                            'You can sign in with Apple or Google. The sign-in opens in a system sign-in sheet, so the app does not see your Google or Apple password. The sign-in token is kept in the Keychain on your device.',
                            'A copy of your saved stores is kept on your device so alerts can run. When you sign in, it is merged with your account’s favorite stores; signing out clears it from the device.',
                            'New-code alerts are optional and run on your device: the app asks our server for the number of codes for each saved store, and shows a notification on your device only if you allow notifications. We do not send push notifications.',
                        ]}
                    />
                    <Sub>The Android app</Sub>
                    <Bullets
                        items={[
                            'The app shows grabcaramel.com in a web view. The only Android permission it asks for is Internet access: no location, contacts, storage or advertising ID.',
                            'You can sign in with Apple or Google. The sign-in opens in your browser, so the app does not see your Google or Apple password. The sign-in token is stored encrypted with a key held in the Android Keystore, and is excluded from Android backups.',
                            'The app has four tabs: Deals, Search, Saved and Account. They show grabcaramel.com pages; the Account tab shows your Profile page on the website.',
                            'The Account and privacy icon in the top bar offers Sign in or Sign out, Delete my account (once you are signed in) and a link to this policy.',
                            'On devices with Google Play services, Android’s web view uses Google Safe Browsing: Google checks the addresses the web view opens, to warn about unsafe pages. That check is part of Android and is covered by Google’s policies, not ours.',
                        ]}
                    />
                    <Sub>In both apps</Sub>
                    <Bullets
                        items={[
                            'When you are signed in, the app trades its sign-in for a website session so the pages inside the app know who you are: it asks our server for a one-time code that works for 60 seconds, and opens the website with it. The website session is a sign-in session like the ones described under “If you create an account or sign in”.',
                            'The apps contain no advertising or analytics tools of their own. The website pages they show do run the website analytics and error tools described under “Website Analytics & Cookies” below (Google Analytics, self-hosted PostHog with masked session recordings, and self-hosted Sentry with session replay).',
                            <>
                                You can delete your account inside either app:
                                Account → Delete my account on iOS, or on
                                Android the Account and privacy icon → Delete my
                                account (or the Account tab → Data &amp; privacy
                                → Delete my account). It takes effect
                                immediately, ends every sign-in, and, if you
                                signed in with Apple, asks Apple to revoke the
                                Sign in with Apple tokens. What is deleted and
                                what is kept is listed on our{' '}
                                <Link
                                    href="/delete-account"
                                    className={INLINE_LINK_CLASS}
                                >
                                    Delete your account
                                </Link>{' '}
                                page.
                            </>,
                        ]}
                    />
                </>
            ),
        },
        {
            id: 'info-use',
            title: 'How Do We Use Your Information?',
            icon: <FaLock />,
            content: (
                <>
                    <Para>We use the information above only to:</Para>
                    <Bullets
                        items={[
                            'Find coupon codes for the store you are on, show how many we have, and apply them at checkout.',
                            'Rank codes by whether they actually work, and retire codes that have expired.',
                            'Work out which codes fit the items in your cart (an AI model reads the cart page summary described above).',
                            'Run your account: sign-in, favorite stores and, if you turn it on, your savings history.',
                            'Publish codes you choose to share so other shoppers can use them.',
                            'Keep Caramel secure and working: limit abuse, and find and fix errors.',
                            'Find the promo-code box on a cart page when a store’s known rules cannot (an AI model reads the cart-page outline described above).',
                            'Learn a store’s promo-code box from the suggestions of several signed-in shoppers, where we have no saved rules for it (while that feature is switched on).',
                        ]}
                    />
                    <Para>
                        We do not use your information for advertising, we do
                        not sell it, and we do not use it to decide
                        creditworthiness or for lending. The use of information
                        received from Chrome APIs adheres to the Chrome Web
                        Store User Data Policy, including the Limited Use
                        requirements.
                    </Para>
                </>
            ),
        },
        {
            id: 'info-storage',
            title: 'Where Is It Stored, and for How Long?',
            icon: <FaDatabase />,
            content: (
                <>
                    <Sub>In your browser</Sub>
                    <Bullets
                        items={[
                            'Your settings, kept in your browser’s extension storage. If you use your browser’s sync feature, your browser syncs them to your other devices.',
                            'Your sign-in session token, your account name, email and profile picture (cached for the popup), a short log of your recent savings, a cached list of supported stores, and recent diagnostic timings, kept in the extension’s local storage on this device.',
                            'While Caramel tries codes on a store page, the codes tried and the result are kept in that tab’s session storage, which your browser clears when you close the tab.',
                            'Uninstalling the extension removes everything it stored in your browser.',
                        ]}
                    />
                    <Sub>On our servers</Sub>
                    <Bullets
                        items={[
                            'Caramel’s servers are operated by Devino. Data travels to them encrypted over HTTPS.',
                            'Account details, favorite stores, savings history and account-linked coupon results are kept until you delete them or ask us to delete your account.',
                            'Sign-in sessions expire after 7 days (website sessions are extended while you stay active); signing out ends the session and deletes its record immediately. Records of sessions that expire without signing out, including their IP address and browser type, are kept until you delete your account.',
                            'Cart page summaries are not stored in our database. They are processed to classify your cart, and the result is kept in temporary memory for up to 24 hours so the same cart is not processed twice.',
                            'Cart-page outlines (see “Finding the promo-code box” above) are not stored in our database. The model’s answer, which control is the code box, is kept in temporary memory for up to 24 hours for that store and page shape so the same page is not processed twice, looked up by a one-way hash of the store and outline rather than by the outline itself. Your IP address is used to rate-limit these requests. The outcome event described above is kept in our self-hosted analytics.',
                            'Coupon results are kept as per-code totals (when a code last worked or failed, and the store’s last error message). To stop fake reports from hiding or reviving a code, each “worked” or “didn’t work” report also keeps a one-way keyed hash of your IP address, or of your account if you are signed in. It is not stored with your account or your IP address, and it is deleted after 30 days.',
                            'Shared codes stay published while they are valid; deleting your account removes the link between a shared code and you.',
                            'Promo-box suggestions (the store’s hostname and the selectors described above) are kept with your account. A suggestion older than 30 days no longer counts toward a store’s saved rules but is not deleted automatically; it is removed when you delete your account.',
                            'Server logs, which can include IP addresses and browser type, are kept for up to 90 days for security and troubleshooting. The text of store searches is not written to them.',
                            'Error reports (Sentry) are kept for 90 days. Since October 25, 2026 they are stored without store-search text; reports captured before then may contain it until they expire (by January 23, 2027 at the latest).',
                        ]}
                    />
                </>
            ),
        },
        {
            id: 'info-sharing',
            title: 'Who Do We Share It With?',
            icon: <FaShareAlt />,
            content: (
                <>
                    <Para>
                        We never sell your information. We share it only with
                        the service providers we need to run Caramel, each for
                        the purpose listed:
                    </Para>
                    <Bullets
                        items={[
                            <>
                                <strong>OpenRouter</strong>, and the AI model
                                provider it routes the request to (currently
                                Anthropic&apos;s Claude model, which OpenRouter
                                may serve through Anthropic or another hosting
                                provider it uses): the store name and hostname,
                                page title and description, and up to 6 cart
                                item names, to work out which codes fit your
                                cart. It is sent without your name, email
                                address or account.
                            </>,
                            <>
                                <strong>
                                    Devino&apos;s own AI model proxy
                                </strong>
                                , which currently passes the request to
                                NVIDIA&apos;s hosted model service (NIM): the
                                store&apos;s hostname and the trimmed cart-page
                                outline described above, to work out which
                                control is the promo-code box. It is sent
                                without your name, email address or account.
                            </>,
                            <>
                                <strong>Google and Apple</strong>: only if you
                                choose &quot;Sign in with Google&quot; or
                                &quot;Sign in with Apple&quot;, to sign you in.
                            </>,
                            <>
                                <strong>
                                    Sendly (operated by Devino) and Amazon Web
                                    Services (Amazon SES)
                                </strong>
                                : your email address, to deliver account emails
                                such as sign-up verification and password
                                resets, and replies to messages you send us.
                            </>,
                            <>
                                <strong>Cloudflare</strong>: our network
                                provider, which passes requests (including your
                                IP address) to our servers and protects them
                                from attacks.
                            </>,
                            <>
                                <strong>Google Analytics</strong>: usage
                                analytics on our website, including its pages
                                shown inside our apps, never from the extension.
                            </>,
                            <>
                                <strong>Other Caramel shoppers</strong>: coupon
                                codes you choose to share are shown publicly,
                                without your name.
                            </>,
                        ]}
                    />
                    <Para>
                        Our error monitoring (Sentry) and product analytics
                        (PostHog) are self-hosted by Devino on our own servers,
                        so the data they receive is not shared with those
                        companies. We may also disclose information if the law
                        requires it, or to protect Caramel and its users from
                        fraud or abuse.
                    </Para>
                </>
            ),
        },
        {
            id: 'never',
            title: 'What Caramel Never Does',
            icon: <FaBan />,
            content: (
                <Bullets
                    items={[
                        'Sell or rent your personal information.',
                        'Use it for advertising, or for creditworthiness or lending decisions.',
                        'Read or collect payment card details, your address, your order number or order history, or passwords you type into stores.',
                        'Send full page addresses or page contents of the sites you visit: for each page you load, the extension sends only its hostname (see above), and the cart summary only when described above.',
                        'The only other page content the extension sends is the trimmed cart-page outline described under “Finding the promo-code box on a cart page”, and only as described there.',
                        'Run code downloaded from the internet: everything the extension runs ships inside the extension package.',
                    ]}
                />
            ),
        },
        {
            id: 'third-party-services',
            title: 'Website Analytics & Cookies',
            icon: <FaChartLine />,
            content: (
                <>
                    <Para>
                        On grabcaramel.com, including its pages shown inside our
                        iOS and Android apps (but not in the extension), we use:
                    </Para>
                    <Bullets
                        items={[
                            'Google Analytics: usage analytics.',
                            'PostHog (self-hosted): usage analytics, linked to your account when you are signed in, including session recordings with every form field masked.',
                            'Sentry (self-hosted): error monitoring, which includes session replay on a sample of sessions and on every session where an error occurs (form fields are masked).',
                        ]}
                    />
                    <Para>
                        Neither PostHog nor Sentry records a session replay when
                        your browser sends a Global Privacy Control or Do Not
                        Track signal.
                    </Para>
                    <Para>
                        The website uses cookies to keep you signed in and for
                        the analytics above. You can block or delete cookies in
                        your browser settings; you will then need to sign in
                        again.
                    </Para>
                </>
            ),
        },
        {
            id: 'data-security',
            title: 'Data Security',
            icon: <FaLock />,
            content: (
                <Para>
                    Data is encrypted in transit with HTTPS, passwords are
                    stored only as one-way hashes, and access to our servers is
                    restricted to the Devino team. No method of storage or
                    transmission is perfectly secure, but we work to protect
                    your information from unauthorized access, loss or misuse.
                </Para>
            ),
        },
        {
            id: 'your-choices',
            title: 'Your Choices',
            icon: <FaEdit />,
            content: (
                <Bullets
                    items={[
                        'Pause Caramel on any site, or turn auto-apply off, from the extension.',
                        'Turn checkout sharing and savings sync on or off at any time in the extension’s settings.',
                        'Download your data, or delete your saved Caramel data (savings, favorite stores and coupon results), from Profile → Data & privacy on grabcaramel.com.',
                        'Delete your account yourself: on grabcaramel.com at Profile → Data & privacy → Delete my account (also reachable from the Android app’s Account tab), in the iOS app (Account → Delete my account), or in the Android app (Account and privacy icon → Delete my account). Our Delete your account page lists what is deleted and what is kept.',
                        'Ask us to access, correct or delete your account and everything linked to it by emailing hello@devino.ca from the address on your account (if you signed in with Apple and hid your email, delete your account yourself as above instead). We act on deletion requests within 30 days; deleting your account removes your login, sign-in sessions, favorite stores, savings history and coupon results, and unlinks you from codes you shared. We also ask our self-hosted analytics (PostHog) to delete the profile linked to your account, with its events and session recordings; PostHog queues that request and finishes it in the background. Error records (Sentry), Google Analytics data, and analytics events that were never linked to your account are not removed by this.',
                        'Uninstall the extension at any time; this stops all collection and removes what it stored in your browser.',
                    ]}
                />
            ),
        },
    ]

    return (
        <div className="py-16">
            {/* Introduction */}
            <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6 }}
                className="mb-16 text-center"
            >
                <div className={EFFECTIVE_DATE_BADGE_CLASS}>
                    <FaShieldAlt className="h-4 w-4" />
                    Effective Date: October 25, 2026
                </div>
                <p className="mx-auto max-w-4xl text-lg leading-relaxed text-gray-600 dark:text-gray-300">
                    Welcome to{' '}
                    <span className={BRAND_NAME_CLASS}>Caramel!</span> Caramel
                    is made by Devino. This Privacy Policy explains what
                    information the Caramel browser extension, the Caramel iOS
                    and Android apps and the grabcaramel.com website collect,
                    how we use it, where it is stored and for how long, and who
                    it is shared with.
                </p>
            </motion.div>

            {/* Privacy Sections */}
            <div className="mx-auto max-w-4xl space-y-8">
                {sections.map((section, index) => (
                    <motion.div
                        key={section.id}
                        id={section.id}
                        initial={{ opacity: 0, x: index % 2 === 0 ? -30 : 30 }}
                        whileInView={{ opacity: 1, x: 0 }}
                        viewport={{ once: true }}
                        transition={{ duration: 0.6, delay: index * 0.1 }}
                        className={SECTION_CARD_CLASS}
                    >
                        {/* Background Pattern */}
                        <div className="absolute inset-0 opacity-5">
                            <motion.div
                                className="h-full w-full"
                                style={{
                                    backgroundImage: `
                                        linear-gradient(90deg, #ea6925 1px, transparent 1px),
                                        linear-gradient(#ea6925 1px, transparent 1px)
                                    `,
                                    backgroundSize: '20px 20px',
                                }}
                                animate={{
                                    backgroundPosition: [
                                        '0px 0px',
                                        '20px 20px',
                                        '0px 0px',
                                    ],
                                }}
                                transition={{
                                    duration: 8,
                                    repeat: Infinity,
                                    ease: 'linear',
                                    repeatType: 'loop',
                                }}
                            />
                        </div>

                        <div className="relative z-10">
                            <div className="mb-6 flex items-start gap-4">
                                <div className={SECTION_ICON_CLASS}>
                                    {section.icon}
                                </div>
                                <div className="flex-1">
                                    <h2 className={SECTION_TITLE_CLASS}>
                                        {section.title}
                                    </h2>
                                    <div className="text-base leading-relaxed">
                                        {section.content}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </motion.div>
                ))}
            </div>

            {/* Contact and Updates */}
            <div className="mx-auto mt-16 grid max-w-4xl grid-cols-2 gap-8 md:grid-cols-1">
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.6 }}
                    className={CONTACT_CARD_CLASS}
                >
                    <div className="flex items-start gap-4">
                        <div className={CONTACT_ICON_CLASS}>
                            <FaEdit />
                        </div>
                        <div>
                            <h3 className="mb-4 text-xl font-bold text-gray-900 dark:text-white">
                                Access and Updates
                            </h3>
                            <p className="mb-4 text-gray-600 dark:text-gray-400">
                                You can request to access, update, or delete
                                your personal information by contacting us at:
                            </p>
                            <a
                                href="mailto:hello@devino.ca"
                                className={MAILTO_LINK_CLASS}
                            >
                                <FaEnvelope className="h-4 w-4" />
                                hello@devino.ca
                            </a>
                        </div>
                    </div>
                </motion.div>

                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.6, delay: 0.1 }}
                    className={CONTACT_CARD_CLASS}
                >
                    <div className="flex items-start gap-4">
                        <div className={CONTACT_ICON_CLASS}>
                            <FaEnvelope />
                        </div>
                        <div>
                            <h3 className="mb-4 text-xl font-bold text-gray-900 dark:text-white">
                                Contact Us
                            </h3>
                            <p className="mb-4 text-gray-600 dark:text-gray-400">
                                If you have any questions or concerns about this
                                Privacy Policy, feel free to contact us at:
                            </p>
                            <a
                                href="mailto:hello@devino.ca"
                                className={MAILTO_LINK_CLASS}
                            >
                                <FaEnvelope className="h-4 w-4" />
                                hello@devino.ca
                            </a>
                        </div>
                    </div>
                </motion.div>
            </div>

            {/* Policy Updates Notice */}
            <motion.div
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.6 }}
                className={UPDATES_BANNER_CLASS}
            >
                <h3 className="mb-4 text-xl font-semibold">
                    Changes to This Privacy Policy
                </h3>
                <p className="mx-auto max-w-3xl opacity-90">
                    This Privacy Policy may be updated periodically to reflect
                    changes in our practices or legal requirements. Any updates
                    will be posted here, and the revised policy will take effect
                    immediately upon posting.
                </p>
            </motion.div>
        </div>
    )
}

export default PrivacyPolicy
