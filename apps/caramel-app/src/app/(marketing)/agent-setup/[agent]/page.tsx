import AgentSetupPill from '@/components/growth/AgentSetupPill'
import {
    AGENT_GUIDES,
    AGENT_SETUP_PATH,
    API,
    APP_NAME,
    PROMPT_MD_URL,
    agentGuide,
} from '@/lib/agentSetup/agentSetup.config'
import { BASE_URL } from '@/lib/env.client'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

// One human guide per agent (spec §3), rendered from the same manifest as
// prompt.md so the commands can never differ between the two.

type Params = { agent: string }

const origin = BASE_URL.replace(/\/+$/, '')

export function generateStaticParams(): Params[] {
    return AGENT_GUIDES.map(guide => ({ agent: guide.id }))
}

export async function generateMetadata({
    params,
}: {
    params: Promise<Params>
}): Promise<Metadata> {
    const guide = agentGuide((await params).agent)
    if (!guide) return {}
    const title = `Set up ${APP_NAME} in ${guide.name}`
    return {
        title,
        description: guide.summary,
        alternates: { canonical: `${origin}${AGENT_SETUP_PATH}/${guide.id}` },
    }
}

export default async function AgentGuidePage({
    params,
}: {
    params: Promise<Params>
}) {
    const guide = agentGuide((await params).agent)
    if (!guide) notFound()

    return (
        <main className="flex min-h-screen w-full flex-col items-center px-6 pb-20 pt-32 dark:bg-darkBg">
            <div className="flex w-full max-w-3xl flex-col gap-8">
                <header className="flex flex-col gap-4">
                    <p className="text-sm">
                        <Link
                            href={AGENT_SETUP_PATH}
                            className="text-caramel underline hover:no-underline"
                        >
                            ← All agents
                        </Link>
                    </p>
                    <h1 className="text-3xl font-bold tracking-tight text-gray-900 dark:text-white">
                        Set up {APP_NAME} in {guide.name}
                    </h1>
                    <p className="text-gray-600 dark:text-gray-300">
                        {guide.summary}
                    </p>
                    <p className="text-sm text-gray-600 dark:text-gray-300">
                        Fastest path: copy the prompt and let {guide.name} do
                        the steps below itself.
                    </p>
                    <AgentSetupPill surface="agent-setup" className="w-fit" />
                </header>

                <section aria-labelledby="guide-steps">
                    <h2
                        id="guide-steps"
                        className="mb-2 text-xl font-semibold text-gray-900 dark:text-white"
                    >
                        By hand
                    </h2>
                    <ol className="list-decimal space-y-3 pl-5 text-sm text-gray-600 dark:text-gray-300">
                        {guide.commands.map(command => (
                            <li key={command}>
                                <pre className="mt-1 overflow-x-auto rounded-xl bg-darkBg px-4 py-3 text-gray-100 ring-1 ring-white/10">
                                    <code>{command}</code>
                                </pre>
                            </li>
                        ))}
                        {guide.configFile && (
                            <li>
                                Write <code>{guide.configFile.path}</code>:
                                <pre className="mt-1 overflow-x-auto rounded-xl bg-darkBg px-4 py-3 text-gray-100 ring-1 ring-white/10">
                                    <code>{guide.configFile.contents}</code>
                                </pre>
                            </li>
                        )}
                        {guide.userFollowUp.map(line => (
                            <li key={line}>{line}</li>
                        ))}
                    </ol>
                </section>

                <section
                    aria-labelledby="guide-verify"
                    className="border-t border-gray-200 pt-6 dark:border-white/10"
                >
                    <h2
                        id="guide-verify"
                        className="mb-2 text-xl font-semibold text-gray-900 dark:text-white"
                    >
                        Verify
                    </h2>
                    <pre className="overflow-x-auto rounded-xl bg-darkBg px-4 py-3 text-sm text-gray-100 ring-1 ring-white/10">
                        <code>{`curl -s "${API.verifyUrl}"`}</code>
                    </pre>
                    <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
                        Success: {API.verifyExpectation}
                    </p>
                    <p className="mt-4 text-sm text-gray-600 dark:text-gray-300">
                        The machine-readable version of this page is{' '}
                        <a
                            href={PROMPT_MD_URL}
                            className="font-mono text-caramel underline hover:no-underline"
                        >
                            {PROMPT_MD_URL}
                        </a>
                        .
                    </p>
                </section>
            </div>
        </main>
    )
}
