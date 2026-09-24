import AgentSetupPill from '@/components/growth/AgentSetupPill'
import {
    AGENT_GUIDES,
    AGENT_SETUP_COPY_TEXT,
    AGENT_SETUP_PATH,
    API,
    APP_NAME,
    PROMPT_MD_URL,
    RESOURCES,
} from '@/lib/agentSetup/agentSetup.config'
import { BASE_URL } from '@/lib/env.client'
import type { Metadata } from 'next'
import Link from 'next/link'
import InlineCode from './InlineCode'

// The human index for "Onboard your agent to Caramel" (fleet agent-onboarding
// spec §3): the pill, one card per agent, what you get, the verify step.
// Everything here renders from agentSetup.config.ts — the same manifest the
// raw prompt.md is generated from.

const origin = BASE_URL.replace(/\/+$/, '')
const title = `Set up ${APP_NAME} for your AI coding agent`
const description = `Paste one sentence into Claude Code, Codex, Cursor, OpenCode or GitHub Copilot and it installs the ${APP_NAME} coupon skill and verifies the public coupon API — no API key needed.`

export const metadata: Metadata = {
    title,
    description,
    alternates: { canonical: `${origin}${AGENT_SETUP_PATH}` },
    openGraph: {
        type: 'website',
        url: `${origin}${AGENT_SETUP_PATH}`,
        title,
        description,
        siteName: APP_NAME,
        images: ['/caramel_banner.png'],
    },
}

export default function AgentSetupPage() {
    return (
        <main className="flex min-h-screen w-full flex-col items-center px-6 pb-20 pt-32 dark:bg-darkBg">
            <div className="flex w-full max-w-4xl flex-col gap-8">
                <header className="flex flex-col gap-4">
                    <h1 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white">
                        Onboard your agent to {APP_NAME}
                    </h1>
                    <p className="max-w-3xl text-gray-600 dark:text-gray-300">
                        Copy the sentence below and paste it into any AI coding
                        agent. The agent fetches{' '}
                        <a
                            href={PROMPT_MD_URL}
                            className="font-mono text-caramel underline hover:no-underline"
                        >
                            {PROMPT_MD_URL.replace(`${origin}`, '')}
                        </a>{' '}
                        and installs everything itself: the {APP_NAME} coupon
                        skill, which looks up live promo codes for any store
                        through our public API. No API key, no account.
                    </p>
                    <AgentSetupPill surface="agent-setup" className="w-fit" />
                    <pre className="whitespace-pre-wrap break-all rounded-xl bg-darkBg px-4 py-3 text-sm text-gray-100 ring-1 ring-white/10">
                        <code>{AGENT_SETUP_COPY_TEXT}</code>
                    </pre>
                </header>

                <section aria-labelledby="agent-setup-agents">
                    <h2
                        id="agent-setup-agents"
                        className="mb-4 text-xl font-semibold text-gray-900 dark:text-white"
                    >
                        Or follow the guide for your agent
                    </h2>
                    <ul className="grid grid-cols-2 gap-4 md:grid-cols-1">
                        {AGENT_GUIDES.map(guide => (
                            <li key={guide.id}>
                                <Link
                                    href={`${AGENT_SETUP_PATH}/${guide.id}`}
                                    className="flex h-full flex-col gap-2 rounded-2xl border border-gray-200 bg-white p-5 transition-shadow hover:shadow-caramel-lg dark:border-white/10 dark:bg-darkSurface"
                                >
                                    <span className="text-lg font-semibold text-gray-900 dark:text-white">
                                        {guide.name}
                                    </span>
                                    <span className="text-sm text-gray-600 dark:text-gray-300">
                                        {guide.summary}
                                    </span>
                                </Link>
                            </li>
                        ))}
                    </ul>
                </section>

                <section
                    aria-labelledby="agent-setup-what"
                    className="border-t border-gray-200 pt-6 dark:border-white/10"
                >
                    <h2
                        id="agent-setup-what"
                        className="mb-2 text-xl font-semibold text-gray-900 dark:text-white"
                    >
                        What your agent gets
                    </h2>
                    <ul className="list-disc space-y-1 pl-5 text-sm text-gray-600 dark:text-gray-300">
                        <li>
                            The <code>caramel-coupons</code> skill: when you are
                            about to buy something, it fetches live codes for
                            that store, with each code's latest verification
                            status.
                        </li>
                        <li>
                            The public coupon API:{' '}
                            <code className="break-all">{API.coupons}</code> (by
                            store or search) and{' '}
                            <code className="break-all">{API.stores}</code>{' '}
                            (store lookup).
                        </li>
                        <li>
                            Nothing that needs a key. There is no {APP_NAME} MCP
                            server or SDK; the browser extension itself is yours
                            to install from{' '}
                            <Link
                                href="/apps"
                                className="text-caramel underline hover:no-underline"
                            >
                                the download page
                            </Link>
                            .
                        </li>
                    </ul>
                </section>

                <section
                    aria-labelledby="agent-setup-verify"
                    className="border-t border-gray-200 pt-6 dark:border-white/10"
                >
                    <h2
                        id="agent-setup-verify"
                        className="mb-2 text-xl font-semibold text-gray-900 dark:text-white"
                    >
                        Verify
                    </h2>
                    <pre className="overflow-x-auto rounded-xl bg-darkBg px-4 py-3 text-sm text-gray-100 ring-1 ring-white/10">
                        <code>{`curl -s "${API.verifyUrl}"`}</code>
                    </pre>
                    <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
                        Success: <InlineCode text={API.verifyExpectation} />
                    </p>
                </section>

                <nav
                    aria-label="Related pages"
                    className="border-t border-gray-200 pt-6 dark:border-white/10"
                >
                    <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
                        <li>
                            <Link
                                href="/faq"
                                className="text-caramel underline hover:no-underline"
                            >
                                FAQ
                            </Link>
                        </li>
                        <li>
                            <a
                                href={RESOURCES.llms}
                                className="text-caramel underline hover:no-underline"
                            >
                                llms.txt
                            </a>
                        </li>
                        <li>
                            <a
                                href={RESOURCES.repo}
                                className="text-caramel underline hover:no-underline"
                            >
                                Source on GitHub
                            </a>
                        </li>
                        <li>
                            <Link
                                href="/support"
                                className="text-caramel underline hover:no-underline"
                            >
                                Support
                            </Link>
                        </li>
                    </ul>
                </nav>
            </div>
        </main>
    )
}
