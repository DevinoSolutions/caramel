import { motion } from 'framer-motion'
import {
    FaCookie,
    FaEdit,
    FaEnvelope,
    FaLock,
    FaShieldAlt,
    FaUserShield,
} from 'react-icons/fa'

const PrivacyPolicy = () => {
    const sections = [
        {
            id: 'info-collect',
            title: 'What Information Do We Collect?',
            icon: <FaUserShield />,
            content: (
                <>
                    <p className="mb-4 text-gray-600 dark:text-gray-400">
                        Caramel may collect the following information to improve
                        your shopping experience:
                    </p>
                    <ul className="space-y-2 text-gray-600 dark:text-gray-400">
                        <li className="flex items-start gap-3">
                            <span className="mt-2 h-2 w-2 flex-shrink-0 rounded-full bg-caramel"></span>
                            Browser tabs and active tab information for coupon
                            automation.
                        </li>
                        <li className="flex items-start gap-3">
                            <span className="mt-2 h-2 w-2 flex-shrink-0 rounded-full bg-caramel"></span>
                            Saved preferences and settings for a customized
                            experience.
                        </li>
                    </ul>
                </>
            ),
        },
        {
            id: 'info-use',
            title: 'How Do We Use Your Information?',
            icon: <FaLock />,
            content: (
                <>
                    <p className="mb-4 text-gray-600 dark:text-gray-400">
                        The information we collect is used to:
                    </p>
                    <ul className="space-y-2 text-gray-600 dark:text-gray-400">
                        <li className="flex items-start gap-3">
                            <span className="mt-2 h-2 w-2 flex-shrink-0 rounded-full bg-caramel"></span>
                            Automate coupon application and find the best deals
                            for you.
                        </li>
                        <li className="flex items-start gap-3">
                            <span className="mt-2 h-2 w-2 flex-shrink-0 rounded-full bg-caramel"></span>
                            Enhance the functionality and performance of
                            Caramel.
                        </li>
                    </ul>
                </>
            ),
        },
        {
            id: 'info-protect',
            title: 'How Do We Protect Your Information?',
            icon: <FaShieldAlt />,
            content: (
                <p className="text-gray-600 dark:text-gray-400">
                    We prioritize your privacy and security. Your personal data
                    is never shared with third parties without your explicit
                    consent. Any browsing or shopping information collected is
                    used solely to improve your experience with Caramel.
                </p>
            ),
        },
        {
            id: 'cookies',
            title: 'Do We Use Cookies?',
            icon: <FaCookie />,
            content: (
                <p className="text-gray-600 dark:text-gray-400">
                    Yes, we use cookies to optimize your shopping experience.
                    Cookies allow us to provide personalized features and
                    analyze performance to better serve you.
                </p>
            ),
        },
        {
            id: 'data-security',
            title: 'Data Security',
            icon: <FaLock />,
            content: (
                <p className="text-gray-600 dark:text-gray-400">
                    We implement industry-standard security measures to protect
                    your information from unauthorized access, breaches, or
                    misuse. Your trust is our priority.
                </p>
            ),
        },
        {
            id: 'your-choices',
            title: 'Your Choices',
            icon: <FaEdit />,
            content: (
                <>
                    <p className="mb-4 text-gray-600 dark:text-gray-400">
                        You have full control over your data:
                    </p>
                    <ul className="space-y-2 text-gray-600 dark:text-gray-400">
                        <li className="flex items-start gap-3">
                            <span className="mt-2 h-2 w-2 flex-shrink-0 rounded-full bg-caramel"></span>
                            You can uninstall Caramel at any time to stop data
                            collection.
                        </li>
                        <li className="flex items-start gap-3">
                            <span className="mt-2 h-2 w-2 flex-shrink-0 rounded-full bg-caramel"></span>
                            You can adjust browser settings to manage cookies.
                        </li>
                    </ul>
                </>
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
                    Effective Date: January 1, 2025
                </div>
                <p className="mx-auto max-w-4xl text-lg leading-relaxed text-gray-600 dark:text-gray-300">
                    Welcome to{' '}
                    <span className="font-semibold text-caramel">Caramel!</span>{' '}
                    This Privacy Policy explains how we collect, use, and
                    protect your information while using our extension. By
                    accessing and using Caramel, you agree to the terms outlined
                    in this Privacy Policy.
                </p>
            </motion.div>

            {/* Privacy Sections */}
            <div className="space-y-8">
                {sections.map((section, index) => (
                    <motion.div
                        key={section.id}
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
            <div className="mt-16 grid grid-cols-1 gap-8 md:grid-cols-2">
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
                                className="inline-flex items-center gap-2 font-semibold text-caramel transition-colors duration-200 hover:text-orange-600"
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
                                className="inline-flex items-center gap-2 font-semibold text-caramel transition-colors duration-200 hover:text-orange-600"
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
                className="mt-12 rounded-3xl bg-gradient-to-r from-caramel to-orange-600 p-8 text-center text-white"
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
