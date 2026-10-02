import { motion } from 'framer-motion'
import type { ReactNode } from 'react'
import {
    FaBan,
    FaChartLine,
    FaDatabase,
    FaEdit,
    FaEnvelope,
    FaLock,
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

function Bullets({ items }: { items: ReactNode[] }) {
    return (
        <ul className="mb-4 space-y-2 text-gray-600 dark:text-gray-400">
            {items.map((item, i) => (
                <li key={i} className="flex items-start gap-3">
                    <span className="mt-2 h-2 w-2 flex-shrink-0 rounded-full bg-caramel"></span>
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
    return (
        <h3 className="mb-3 mt-2 text-lg font-semibold text-gray-900 dark:text-white">
            {children}
        </h3>
    )
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
                        no ads, no analytics and no third-party trackers.
                    </Para>
                    <Sub>Whether or not you are signed in</Sub>
                    <Bullets
                        items={[
                            <>
                                <strong>The website you are on.</strong> When
                                you open or switch to a secure (https) page, the
                                extension sends that page&apos;s hostname (for
                                example, &quot;amazon.com&quot;) to our server
                                to check whether we have coupons for it, show
                                the number on the toolbar icon, and load the
                                store&apos;s codes. Only the hostname is sent
                                for this, never the full page address or the
                                page&apos;s contents.
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
                                your order details, or passwords you type into a
                                store.
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
                        ]}
                    />
                    <Sub>On our website</Sub>
                    <Para>
                        When you visit grabcaramel.com we collect usage
                        analytics and error reports as described under
                        &quot;Website Analytics &amp; Cookies&quot; below.
                    </Para>
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
                            'Your sign-in session token, a short log of your recent savings, a cached list of supported stores, and recent diagnostic timings, kept in the extension’s local storage on this device.',
                            'While Caramel tries codes on a store page, the codes tried and the result are kept in that tab’s session storage, which your browser clears when you close the tab.',
                            'Uninstalling the extension removes everything it stored in your browser.',
                        ]}
                    />
                    <Sub>On our servers</Sub>
                    <Bullets
                        items={[
                            'Caramel’s servers are operated by Devino. Data travels to them encrypted over HTTPS.',
                            'Account details, favorite stores, savings history and account-linked coupon results are kept until you delete them or ask us to delete your account.',
                            'Sign-in sessions expire after 7 days; signing out ends the session immediately.',
                            'Cart page summaries are not stored in our database. They are processed to classify your cart, and the result is kept in temporary memory for up to 24 hours so the same cart is not processed twice.',
                            'Coupon results without an account are kept only as anonymous per-code totals (when a code last worked or failed, and the store’s last error message).',
                            'Shared codes stay published while they are valid; deleting your account removes the link between a shared code and you.',
                            'Server logs, which can include IP addresses and browser type, are kept for a limited time for security and troubleshooting.',
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
                                Anthropic): the cart page summary described
                                above, to work out which codes fit your cart. It
                                is sent without your name, email address or
                                account.
                            </>,
                            <>
                                <strong>Google and Apple</strong>: only if you
                                choose &quot;Sign in with Google&quot; or
                                &quot;Sign in with Apple&quot;, to sign you in.
                            </>,
                            <>
                                <strong>UseSend</strong>: your email address, to
                                deliver account emails such as sign-up
                                verification and password resets.
                            </>,
                            <>
                                <strong>Cloudflare</strong>: our network
                                provider, which passes requests (including your
                                IP address) to our servers and protects them
                                from attacks.
                            </>,
                            <>
                                <strong>Google Analytics</strong>: usage
                                analytics on our website only, never from the
                                extension.
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
                        'Read or collect payment card details, your address, your order details, or passwords you type into stores.',
                        'Send your full browsing history: the extension sends only the hostname of the page you are on.',
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
                        On grabcaramel.com (not in the extension) we use:
                    </Para>
                    <Bullets
                        items={[
                            'Google Analytics: usage analytics.',
                            'PostHog (self-hosted): usage analytics, linked to your account when you are signed in, including session recordings with every form field masked.',
                            'Sentry (self-hosted): error monitoring, which includes session replay on a sample of sessions.',
                        ]}
                    />
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
                        'Ask us to access, correct or delete your account and everything linked to it by emailing hello@devino.ca.',
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
                <div className="mb-6 inline-flex items-center gap-3 rounded-full bg-caramel/10 px-6 py-3 text-sm font-semibold text-caramel">
                    <FaShieldAlt className="h-4 w-4" />
                    Effective Date: October 2, 2026
                </div>
                <p className="mx-auto max-w-4xl text-lg leading-relaxed text-gray-600 dark:text-gray-300">
                    Welcome to{' '}
                    <span className="font-semibold text-caramel">Caramel!</span>{' '}
                    Caramel is made by Devino. This Privacy Policy explains what
                    information the Caramel browser extension and the
                    grabcaramel.com website collect, how we use it, where it is
                    stored and for how long, and who it is shared with.
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
                        className="relative overflow-hidden rounded-3xl border border-caramel/20 bg-gradient-to-br from-caramel/5 via-orange-50/30 to-caramel/5 p-8 dark:border-caramel/30 dark:from-caramel/10 dark:via-orange-900/20 dark:to-caramel/10"
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
                                <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-2xl bg-caramel/10 text-xl text-caramel dark:bg-caramel/20">
                                    {section.icon}
                                </div>
                                <div className="flex-1">
                                    <h2 className="mb-4 text-2xl font-bold text-gray-900 dark:text-white lg:text-xl">
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
                    className="rounded-3xl border border-caramel/20 bg-gradient-to-br from-caramel/5 via-orange-50/30 to-caramel/5 p-8 dark:border-caramel/30 dark:from-caramel/10 dark:via-orange-900/20 dark:to-caramel/10"
                >
                    <div className="flex items-start gap-4">
                        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-caramel/10 text-xl text-caramel dark:bg-caramel/20">
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
                                className="inline-flex items-center gap-2 rounded-md font-semibold text-caramel transition-colors duration-200 hover:text-orange-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel focus-visible:ring-offset-2 dark:focus-visible:ring-offset-darkBg"
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
                    className="rounded-3xl border border-caramel/20 bg-gradient-to-br from-caramel/5 via-orange-50/30 to-caramel/5 p-8 dark:border-caramel/30 dark:from-caramel/10 dark:via-orange-900/20 dark:to-caramel/10"
                >
                    <div className="flex items-start gap-4">
                        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-caramel/10 text-xl text-caramel dark:bg-caramel/20">
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
                                className="inline-flex items-center gap-2 rounded-md font-semibold text-caramel transition-colors duration-200 hover:text-orange-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel focus-visible:ring-offset-2 dark:focus-visible:ring-offset-darkBg"
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
                className="mx-auto mt-12 max-w-4xl rounded-3xl bg-gradient-to-r from-caramel to-orange-600 p-8 text-center text-white shadow-lg"
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
