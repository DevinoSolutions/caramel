'use client'

import Doodles from '@/components/Doodles'
import { motion } from 'framer-motion'
import Link from 'next/link'
import type { ReactNode } from 'react'
import {
    FaBalanceScale,
    FaBan,
    FaCodeBranch,
    FaEnvelope,
    FaExclamationTriangle,
    FaFileContract,
    FaPowerOff,
    FaShoppingCart,
    FaTags,
    FaUserCheck,
} from 'react-icons/fa'

// Client body of /terms (same hero, cards and contact block as /privacy).
//
// The wording follows the Devino fleet's terms (nowgetitdone.com/terms) and
// adds only what is specific to Caramel. Each Caramel claim is checked against
// the product, so change the code and this page together:
// - free, no paid tier: /pricing ("free forever: no premium tier");
// - AGPL-3.0: the repository's LICENSE (the Claude plugin under plugins/ is
//   MIT, hence "unless a file or folder says otherwise");
// - works without an account: the extension runs signed out; an account holds
//   favorite stores and, with savings sync on, savings history. Settings live
//   in browser storage, not the account (/privacy "Where Is It Stored");
// - sharing a code needs an account, and the extension shares only a code the
//   shopper typed that the store accepted (/privacy "Coupon codes you choose
//   to share"); account deletion leaves shared codes up without the name
//   (DataPrivacySection);
// - no affiliate code: faqItems.ts, store-listing.mjs;
// - built never to place an order: dom-utils caramelIsForbiddenControl
//   refuses order-completing controls;
// - account deletion: /profile > Data & privacy (T-7505);
// - Apple clauses: the app in apps/caramel-apple; App Store Connect has no
//   custom EULA for it (checked 2026-11-07), so Apple's standard EULA applies;
// - contact address: /privacy.
// TODO(T-8425): legal wording waits for the owner's approval before this ships.
const EFFECTIVE_DATE = 'November 10, 2026'

type Section = {
    id: string
    title: string
    icon: ReactNode
    content: { subtitle: string; text: string }[]
}

const sections: Section[] = [
    {
        id: 'acceptance',
        title: 'Acceptance of These Terms',
        icon: <FaFileContract />,
        content: [
            {
                subtitle: 'Agreement',
                text: 'These Terms of Service govern your use of Caramel: the Caramel browser extension, the website at grabcaramel.com, the Caramel apps, and our public coupon API. By installing the extension, creating an account or otherwise using Caramel, you agree to these Terms. If you do not agree, please do not use Caramel.',
            },
            {
                subtitle: 'Who We Are',
                text: 'Caramel is operated by Devino Solutions (14930398 Canada Inc.). In these Terms, "we", "us", and "our" refer to Devino Solutions, and "you" refers to the person using Caramel.',
            },
            {
                subtitle: 'Changes to These Terms',
                text: 'We may update these Terms as Caramel evolves. When we make a material change, we will update the effective date at the top of this page and, if you have an account, tell you by email before the change takes effect. Continuing to use Caramel after a change means you accept the updated Terms.',
            },
        ],
    },
    {
        id: 'free',
        title: 'Free to Use',
        icon: <FaTags />,
        content: [
            {
                subtitle: 'No Charge',
                text: 'Caramel is free. There is no paid plan, and we never ask for a payment card. If we ever add optional paid features, everything Caramel does for free today stays free, we will tell you before anything is offered for a fee, and nothing will be charged without your agreement.',
            },
        ],
    },
    {
        id: 'accounts',
        title: 'Your Account',
        icon: <FaUserCheck />,
        content: [
            {
                subtitle: 'Optional',
                text: 'You can use the extension without an account. An account keeps your favorite stores and, if you turn on savings sync, your savings history across the browsers and devices you use Caramel on. You need an account to share a code.',
            },
            {
                subtitle: 'Eligibility',
                text: 'You must be at least 16 years old, or the minimum age of digital consent where you live, to create a Caramel account.',
            },
            {
                subtitle: 'Account Security',
                text: 'You are responsible for keeping your sign-in details confidential and for activity under your account. Tell us promptly if you believe your account has been compromised.',
            },
        ],
    },
    {
        id: 'coupons',
        title: 'Coupon Codes and Your Purchases',
        icon: <FaShoppingCart />,
        content: [
            {
                subtitle: 'How Caramel Works',
                text: 'Caramel collects coupon codes from public sources and from other shoppers, and can try them in a store’s coupon box for you after you tap to apply them, from the prompt it shows at checkout or from the extension. It is built never to place an order or make a payment for you: you always decide whether to check out.',
            },
            {
                subtitle: 'No Guarantee a Code Works',
                text: 'Codes are offered by stores, not by us. We cannot promise that any code is valid, that it gives a particular discount, or that a store will honour it, and we do not promise that you will save money. Caramel may not work on every store, and a store changing its website can stop it working there until we update it. The price the store shows at checkout is the price you pay, so check your order before you complete it.',
            },
            {
                subtitle: 'Stores Are Third Parties',
                text: 'Stores are operated by their owners, not by us, and we are not a party to your purchase. Your purchase, including returns and refunds, is governed by the store’s own terms, prices and policies. Store names and trademarks belong to their owners. Listing a store or its codes does not mean that store endorses or partners with Caramel.',
            },
            {
                subtitle: 'No Affiliate Links',
                text: 'Caramel contains no affiliate code. The extension never adds, replaces or removes affiliate or referral links or cookies, so whoever sent you to a store keeps the credit, and we earn no affiliate commission through Caramel on what you buy.',
            },
        ],
    },
    {
        id: 'your-codes',
        title: 'Codes You Share',
        icon: <FaTags />,
        content: [
            {
                subtitle: 'Sharing Is Your Choice',
                text: 'When you are signed in, you can add a code on a store’s page on grabcaramel.com, or turn on “Share codes I enter at checkout” so the extension shares a code you typed yourself once the store accepts it. Shared codes are shown publicly to other shoppers, without your name.',
            },
            {
                subtitle: 'The Licence You Give Us',
                text: 'When you share a code, you give us a free, worldwide, non-exclusive permission to store it, check it, and show it to anyone on the website, in the extension and the apps, and through our public API, including after you delete your account (the code then stays up without any link to you). Only share codes you are free to share: not personal, single-use or employee codes, and nothing you were asked to keep private. We may remove any code, for example one that no longer works.',
            },
        ],
    },
    {
        id: 'acceptable-use',
        title: 'Acceptable Use',
        icon: <FaBan />,
        content: [
            {
                subtitle: 'Use Caramel Lawfully',
                text: 'Do not use Caramel to break the law, to infringe anyone’s rights, or to break a store’s rules about how its codes may be used.',
            },
            {
                subtitle: 'Do Not Abuse the Service',
                text: 'Do not submit false codes or false reports, do not attempt to gain unauthorized access to accounts or infrastructure, do not probe or interfere with the security of the service, and do not use automation to overload it. Our public API is there for automated access within its rate limits; do not try to get around them.',
            },
        ],
    },
    {
        id: 'open-source',
        title: 'Open Source',
        icon: <FaCodeBranch />,
        content: [
            {
                subtitle: 'The Code',
                text: 'Caramel’s source code is published under the GNU Affero General Public License v3.0, unless a file or folder states a different licence, and that licence governs your use of the code. These Terms govern the Caramel service we run: the website, the published extension, the apps and the API.',
            },
            {
                subtitle: 'Our Name and Logo',
                text: 'The open-source licence covers the code, not the Caramel name or logo. Please do not present a modified version as the official Caramel.',
            },
        ],
    },
    {
        id: 'termination',
        title: 'Stopping and Suspension',
        icon: <FaPowerOff />,
        content: [
            {
                subtitle: 'Leaving Caramel',
                text: 'You can stop using Caramel at any time by uninstalling the extension or the app. You can delete your account and the data linked to it from your profile, under Data & privacy, or by emailing us. Deletion is permanent; codes you shared stay published without your name.',
            },
            {
                subtitle: 'Changes to Caramel',
                text: 'Caramel is a free service that we keep improving, so we may add, change or remove features and supported stores, and we may stop offering Caramel altogether. You can download your data at any time from your profile, under Data & privacy.',
            },
            {
                subtitle: 'Suspension by Us',
                text: 'We may suspend or end access for an account that breaches these Terms, that puts the security or stability of the service at risk, or that we are legally required to act on. Unless a delay would cause harm or is legally prohibited, we will tell you why.',
            },
        ],
    },
    {
        id: 'disclaimers',
        title: 'Disclaimers and Liability',
        icon: <FaExclamationTriangle />,
        content: [
            {
                subtitle: 'Service Provided "As Is"',
                text: 'Caramel is provided on an "as is" and "as available" basis. To the fullest extent permitted by law, we disclaim implied warranties of merchantability, fitness for a particular purpose, and non-infringement. We do not warrant that Caramel will be uninterrupted or error-free.',
            },
            {
                subtitle: 'Automated Features',
                text: 'Some features use automated systems, including AI models, to find a store’s coupon box and to judge which codes fit your cart. They can be wrong. Treat their results as help, not as a promise.',
            },
            {
                subtitle: 'Limitation of Liability',
                text: 'To the fullest extent permitted by law, we are not liable for indirect, incidental, special, or consequential damages, or for lost profits or lost data, arising from Caramel, including a code that did not work or a discount a store did not apply. Because Caramel is free, our total liability for any claim relating to it is limited to CAD $50. Nothing in these Terms limits liability that cannot be limited by law, including your rights as a consumer.',
            },
        ],
    },
    {
        id: 'general',
        title: 'Governing Law and General Terms',
        icon: <FaBalanceScale />,
        content: [
            {
                subtitle: 'Governing Law',
                text: 'These Terms and any dispute arising out of them are governed by the laws of the Province of Ontario and the federal laws of Canada that apply there, without regard to conflict-of-law rules, and the courts of Ontario have jurisdiction. Nothing here removes the protection of mandatory consumer-protection laws that apply where you live.',
            },
            {
                subtitle: 'App and Extension Stores',
                text: 'If you got Caramel from an app store or a browser’s extension store, that store’s own terms also apply to how you download and use it there.',
            },
            {
                subtitle: 'Apple Devices',
                text: 'If you use a Caramel app from Apple’s App Store, Apple’s standard Licensed Application End User License Agreement applies to it alongside these Terms. These Terms are between you and Devino Solutions, not Apple. Apple is not responsible for the app or its content, has no obligation to provide maintenance or support for it, and is not responsible for handling any claim about it, including product liability, legal or regulatory compliance, and intellectual property claims. You must also follow the App Store’s usage rules. Apple and its subsidiaries are third-party beneficiaries of these Terms and may enforce them against you.',
            },
            {
                subtitle: 'Privacy',
                text: 'How we handle personal data is described in our Privacy Policy, which forms part of your agreement with us. Please read it alongside these Terms.',
            },
            {
                subtitle: 'Entire Agreement and Severability',
                text: 'These Terms, together with our Privacy Policy, are the entire agreement between you and us about Caramel. If any provision is found unenforceable, the rest stays in force. Our not enforcing a provision is not a waiver of it, and you may not transfer these Terms without our consent.',
            },
        ],
    },
]

const cardClasses =
    'border-caramel/20 from-caramel/5 to-caramel/5 dark:border-caramel/30 dark:from-caramel/10 dark:to-caramel/10 relative overflow-hidden rounded-3xl border bg-gradient-to-br via-orange-50/30 p-8 dark:via-orange-900/20'

export default function TermsPageClient() {
    return (
        <main className="dark:bg-darkBg relative -mt-[6.7rem] w-full overflow-x-clip">
            <Doodles />
            <div className="scroll-smooth">
                <section className="relative mt-[5rem] flex min-h-[50vh] flex-col justify-center overflow-hidden px-6 py-16 text-gray-800 dark:text-white">
                    <div className="mx-auto max-w-6xl text-center">
                        <motion.div
                            initial={{ opacity: 0, y: 30 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.6, ease: 'easeOut' }}
                            className="mb-8"
                        >
                            <h1 className="from-caramel mb-6 bg-gradient-to-r to-orange-600 bg-clip-text pb-2 text-5xl font-extrabold leading-[1.15] tracking-tight text-transparent md:text-3xl lg:text-4xl">
                                Terms of Service
                            </h1>
                            <p className="mx-auto max-w-3xl text-xl leading-relaxed text-gray-600 lg:text-lg dark:text-gray-300">
                                The rules for using Caramel, written to be read
                            </p>
                        </motion.div>
                    </div>
                </section>
                <div className="relative h-px">
                    <div className="h-px bg-gradient-to-r from-transparent via-orange-500/40 to-transparent"></div>
                </div>
                <div className="mx-auto max-w-6xl px-6 pb-16 lg:px-8">
                    <div className="py-16">
                        <div className="mb-16 text-center">
                            <div className="bg-caramel/10 text-caramel mb-6 inline-flex items-center gap-3 rounded-full px-6 py-3 text-sm font-semibold">
                                <FaFileContract className="h-4 w-4" />
                                Effective Date: {EFFECTIVE_DATE}
                            </div>
                            <p className="mx-auto max-w-4xl text-lg leading-relaxed text-gray-600 dark:text-gray-300">
                                Caramel is made by Devino. These Terms explain
                                what you can expect from Caramel and what we ask
                                of you in return. Our{' '}
                                <Link
                                    href="/privacy"
                                    className="text-caramel font-semibold underline-offset-2 hover:underline"
                                >
                                    Privacy Policy
                                </Link>{' '}
                                explains what data Caramel collects and why.
                            </p>
                        </div>

                        <div className="mx-auto max-w-4xl space-y-8">
                            {sections.map(section => (
                                <section
                                    key={section.id}
                                    id={section.id}
                                    className={cardClasses}
                                >
                                    <div className="flex items-start gap-4">
                                        <div className="bg-caramel/10 text-caramel dark:bg-caramel/20 flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-xl">
                                            {section.icon}
                                        </div>
                                        <div className="flex-1">
                                            <h2 className="mb-4 text-2xl font-bold text-gray-900 lg:text-xl dark:text-white">
                                                {section.title}
                                            </h2>
                                            <div className="space-y-4 text-base leading-relaxed text-gray-700 dark:text-gray-300">
                                                {section.content.map(item => (
                                                    <div key={item.subtitle}>
                                                        <h3 className="mb-1 font-semibold text-gray-900 dark:text-white">
                                                            {item.subtitle}
                                                        </h3>
                                                        <p>{item.text}</p>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    </div>
                                </section>
                            ))}
                        </div>

                        <div
                            className={`mx-auto mt-16 max-w-4xl ${cardClasses}`}
                        >
                            <div className="flex items-start gap-4">
                                <div className="bg-caramel/10 text-caramel dark:bg-caramel/20 flex h-12 w-12 items-center justify-center rounded-2xl text-xl">
                                    <FaEnvelope />
                                </div>
                                <div>
                                    <h2 className="mb-4 text-xl font-bold text-gray-900 dark:text-white">
                                        Contact Us
                                    </h2>
                                    <p className="mb-4 text-gray-600 dark:text-gray-400">
                                        Questions about these Terms? Write to us
                                        at:
                                    </p>
                                    <a
                                        href="mailto:hello@devino.ca"
                                        className="text-caramel focus-visible:ring-caramel dark:focus-visible:ring-offset-darkBg inline-flex items-center gap-2 rounded-md font-semibold transition-colors duration-200 hover:text-orange-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
                                    >
                                        <FaEnvelope className="h-4 w-4" />
                                        hello@devino.ca
                                    </a>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </main>
    )
}
