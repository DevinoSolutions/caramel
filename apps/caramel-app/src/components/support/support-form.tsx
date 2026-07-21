'use client'
// src/components/support/support-form.tsx
//
// The user support/feedback form. Reused verbatim by the public /support page
// AND the error-prompt SupportDialog. Visual language mirrors
// supported-site/suggestion-form.tsx (caramel palette, rounded-3xl card,
// rounded-full inputs, framer-motion whileTap, sonner toasts, dark mode).
import { isPosthogActive } from '@/lib/analytics/identity'
import { motion } from 'framer-motion'
import posthog from 'posthog-js'
import { useRef, useState } from 'react'
import { toast } from 'sonner'

export type SupportFeedbackType =
    | 'problem'
    | 'feature_request'
    | 'question'
    | 'other'

const TYPE_OPTIONS: { value: SupportFeedbackType; label: string }[] = [
    { value: 'problem', label: 'Problem' },
    { value: 'feature_request', label: 'Feature request' },
    { value: 'question', label: 'Question' },
    { value: 'other', label: 'Other' },
]

const MESSAGE_MAX = 4000
const EXPECTED_MAX = 2000

export interface SupportFormProps {
    /** Signed-in account email — when present the reply address is read-only. */
    accountEmail?: string | null
    /** Route the user was on (error-prompt passes the original page). */
    fromRoute?: string
    /** Sentry event id, when opened from an error prompt. */
    initialSentryEventId?: string
    /** Pre-selected type — 'problem' from a failure prompt. */
    defaultType?: SupportFeedbackType
    /** Fired after a successful submit (dialog uses it to close). */
    onSubmitted?: () => void
}

export default function SupportForm({
    accountEmail,
    fromRoute,
    initialSentryEventId,
    defaultType = 'problem',
    onSubmitted,
}: SupportFormProps) {
    const [type, setType] = useState<SupportFeedbackType>(defaultType)
    const [message, setMessage] = useState('')
    const [expectedOutcome, setExpectedOutcome] = useState('')
    const [wantsReply, setWantsReply] = useState(false)
    const [anonymousEmail, setAnonymousEmail] = useState('')
    const [honeypot, setHoneypot] = useState('')
    const [loading, setLoading] = useState(false)
    const [submitted, setSubmitted] = useState(false)

    // ONE feedback_id per logical submission: generated once, REUSED on retry
    // after a failure, regenerated only after a success (so a genuinely new
    // submission gets a fresh id). Lazy init — `useRef(crypto.randomUUID())`
    // would mint (and discard) a fresh UUID on EVERY render.
    const feedbackIdRef = useRef<string>('')
    if (!feedbackIdRef.current) {
        feedbackIdRef.current = crypto.randomUUID()
    }

    const isLoggedIn = Boolean(accountEmail)

    const resetForm = () => {
        setType(defaultType)
        setMessage('')
        setExpectedOutcome('')
        setWantsReply(false)
        setAnonymousEmail('')
        setHoneypot('')
    }

    const submit = async (e: React.FormEvent) => {
        e.preventDefault()
        if (loading) return
        if (!message.trim()) {
            toast.warning('Please tell us what happened.')
            return
        }
        if (wantsReply && !isLoggedIn && !anonymousEmail.trim()) {
            toast.warning('Please add your email so we can reply.')
            return
        }

        let posthogSessionId: string | undefined
        let posthogDistinctId: string | undefined
        if (isPosthogActive()) {
            posthogSessionId = posthog.get_session_id() ?? undefined
            posthogDistinctId = posthog.get_distinct_id() ?? undefined
        }

        // E2E-ONLY: forward the shared Playwright handshake's test_run_id so the
        // SERVER-captured support event is tagged with it (a browser super-prop
        // otherwise never reaches a server event). Present only under Playwright
        // (window.__CARAMEL_E2E__ is injected via addInitScript); undefined for
        // every real user, so real submissions carry nothing extra.
        const e2eHandshake =
            typeof window !== 'undefined' ? window.__CARAMEL_E2E__ : undefined

        const replyEmail = isLoggedIn
            ? (accountEmail ?? undefined)
            : anonymousEmail.trim() || undefined

        const payload = {
            feedback_id: feedbackIdRef.current,
            feedback_type: type,
            message: message.trim(),
            ...(expectedOutcome.trim()
                ? { expected_outcome: expectedOutcome.trim() }
                : {}),
            wants_reply: wantsReply,
            ...(wantsReply && replyEmail ? { email: replyEmail } : {}),
            ...(posthogSessionId
                ? { posthog_session_id: posthogSessionId }
                : {}),
            ...(posthogDistinctId
                ? { posthog_distinct_id: posthogDistinctId }
                : {}),
            ...(initialSentryEventId
                ? { sentry_event_id: initialSentryEventId }
                : {}),
            route:
                fromRoute ??
                (typeof window !== 'undefined'
                    ? window.location.pathname
                    : undefined),
            ...(e2eHandshake?.test_run_id
                ? {
                      test_run_id: e2eHandshake.test_run_id,
                      test_scenario: e2eHandshake.test_scenario,
                  }
                : {}),
            // Honeypot — empty for real users.
            website: honeypot,
        }

        setLoading(true)
        try {
            const res = await fetch('/api/support', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            })

            if (!res.ok) {
                // 502 both-failed (or a 4xx/429). Nothing was lost — KEEP all
                // form state and the SAME feedback_id so a retry is idempotent.
                toast.error(
                    "We couldn't send your message — nothing was lost, please retry.",
                )
                return
            }

            const data = (await res.json().catch(() => ({}))) as {
                email?: string
            }

            if (data.email === 'failed') {
                toast.warning(
                    'Your feedback was recorded, but our email notification failed — replies may be delayed.',
                )
            } else {
                toast.success(
                    wantsReply
                        ? "Thanks — we've received it. We'll get back to you soon."
                        : "Thanks — we've received it.",
                )
            }

            // Success: fresh id for the NEXT logical submission, clear + show
            // the success state.
            feedbackIdRef.current = crypto.randomUUID()
            resetForm()
            setSubmitted(true)
            onSubmitted?.()
        } catch {
            toast.error(
                "We couldn't send your message — nothing was lost, please retry.",
            )
        } finally {
            setLoading(false)
        }
    }

    if (submitted) {
        return (
            <div className="flex w-full flex-col items-center gap-4 rounded-3xl border border-caramel/20 bg-gradient-to-br from-caramel/5 via-orange-50/20 to-caramel/5 p-8 text-center shadow-md dark:border-caramel/30 dark:from-caramel/10 dark:via-orange-900/10 dark:to-caramel/10">
                <p className="text-lg font-semibold text-gray-800 dark:text-gray-100">
                    Thanks for reaching out
                </p>
                <p className="text-sm text-gray-600 dark:text-gray-300">
                    We&apos;ve received your message
                    {wantsReply ? ' and will reply soon.' : '.'}
                </p>
                <motion.button
                    type="button"
                    whileTap={{ scale: 0.95 }}
                    onClick={() => setSubmitted(false)}
                    className="rounded-full bg-gradient-to-r from-caramel to-orange-600 px-6 py-2 text-sm font-semibold text-white shadow transition-all hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900"
                >
                    Send another
                </motion.button>
            </div>
        )
    }

    return (
        <form
            onSubmit={submit}
            className="flex w-full flex-col gap-5 rounded-3xl border border-caramel/20 bg-gradient-to-br from-caramel/5 via-orange-50/20 to-caramel/5 p-8 shadow-md dark:border-caramel/30 dark:from-caramel/10 dark:via-orange-900/10 dark:to-caramel/10 sm:p-6"
        >
            {/* Type — segmented control */}
            <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-sm font-semibold text-gray-800 dark:text-gray-100">
                    What kind of feedback is this?
                </legend>
                <div className="flex flex-wrap gap-2">
                    {TYPE_OPTIONS.map(opt => {
                        const active = type === opt.value
                        return (
                            <button
                                key={opt.value}
                                type="button"
                                aria-pressed={active}
                                onClick={() => setType(opt.value)}
                                className={`rounded-full border-2 px-4 py-2 text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900 ${
                                    active
                                        ? 'border-caramel bg-gradient-to-r from-caramel to-orange-600 text-white shadow'
                                        : 'border-caramel/30 bg-white text-gray-700 hover:border-caramel dark:bg-gray-900 dark:text-gray-200 dark:hover:border-orange-400'
                                }`}
                            >
                                {opt.label}
                            </button>
                        )
                    })}
                </div>
            </fieldset>

            {/* Message */}
            <label className="flex flex-col gap-2">
                <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">
                    Your message
                </span>
                <textarea
                    value={message}
                    onChange={e =>
                        setMessage(e.target.value.slice(0, MESSAGE_MAX))
                    }
                    maxLength={MESSAGE_MAX}
                    rows={5}
                    required
                    placeholder="Tell us what happened, or what you'd like to see…"
                    aria-label="Your message"
                    className="w-full resize-y rounded-2xl border-2 border-caramel/30 bg-white px-4 py-3 placeholder-gray-400 shadow-sm outline-none transition-all focus:border-caramel dark:bg-gray-900 dark:text-white dark:placeholder-gray-500 dark:focus:border-orange-400"
                />
                <span className="text-right text-xs text-gray-500 dark:text-gray-400">
                    {message.length}/{MESSAGE_MAX}
                </span>
            </label>

            {/* Expected outcome (optional) */}
            <label className="flex flex-col gap-2">
                <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">
                    What did you expect to happen?{' '}
                    <span className="font-normal text-gray-500 dark:text-gray-400">
                        (optional)
                    </span>
                </span>
                <input
                    type="text"
                    value={expectedOutcome}
                    onChange={e =>
                        setExpectedOutcome(
                            e.target.value.slice(0, EXPECTED_MAX),
                        )
                    }
                    maxLength={EXPECTED_MAX}
                    placeholder="The coupon should have applied at checkout…"
                    aria-label="Expected outcome"
                    className="w-full rounded-full border-2 border-caramel/30 bg-white px-6 py-3 placeholder-gray-400 shadow-sm outline-none transition-all focus:border-caramel dark:bg-gray-900 dark:text-white dark:placeholder-gray-500 dark:focus:border-orange-400"
                />
            </label>

            {/* Reply opt-in */}
            <label className="flex items-center gap-3">
                <input
                    type="checkbox"
                    checked={wantsReply}
                    onChange={e => setWantsReply(e.target.checked)}
                    className="h-4 w-4 rounded border-caramel/40 text-caramel focus-visible:ring-2 focus-visible:ring-caramel"
                />
                <span className="text-sm text-gray-700 dark:text-gray-200">
                    I&apos;d like a reply
                </span>
            </label>

            {wantsReply && isLoggedIn ? (
                <p className="text-sm text-gray-600 dark:text-gray-300">
                    We&apos;ll reply to{' '}
                    <span className="font-semibold">{accountEmail}</span>
                </p>
            ) : null}

            {wantsReply && !isLoggedIn ? (
                <label className="flex flex-col gap-2">
                    <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">
                        Your email
                    </span>
                    <input
                        type="email"
                        inputMode="email"
                        value={anonymousEmail}
                        onChange={e => setAnonymousEmail(e.target.value)}
                        required
                        placeholder="you@example.com"
                        aria-label="Your email"
                        className="w-full rounded-full border-2 border-caramel/30 bg-white px-6 py-3 placeholder-gray-400 shadow-sm outline-none transition-all focus:border-caramel dark:bg-gray-900 dark:text-white dark:placeholder-gray-500 dark:focus:border-orange-400"
                    />
                </label>
            ) : null}

            {/*
              HONEYPOT: a hidden field no human ever fills. Visually removed and
              taken out of the tab order + a11y tree; a non-empty value on the
              server ⇒ a bot (the /api/support route silently 200s without
              sending anything).
            */}
            <div
                aria-hidden="true"
                className="pointer-events-none absolute left-[-9999px] h-0 w-0 overflow-hidden opacity-0"
            >
                <label>
                    Leave this field empty
                    <input
                        type="text"
                        name="website"
                        tabIndex={-1}
                        autoComplete="off"
                        value={honeypot}
                        onChange={e => setHoneypot(e.target.value)}
                    />
                </label>
            </div>

            <motion.button
                type="submit"
                disabled={loading}
                whileTap={{ scale: 0.95 }}
                className="rounded-full bg-gradient-to-r from-caramel to-orange-600 px-8 py-3 font-semibold text-white shadow transition-all hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:focus-visible:ring-offset-gray-900"
            >
                {loading ? 'Sending…' : 'Send feedback'}
            </motion.button>
        </form>
    )
}
