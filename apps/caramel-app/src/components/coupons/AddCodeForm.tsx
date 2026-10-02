'use client'

import { useSession } from '@/lib/auth/client'
import { reportUserVisibleFailure } from '@/lib/feedback/reportUserVisibleFailure'
import {
    SHOPPER_DAILY_SUBMISSION_CAP,
    normalizeShopperCode,
} from '@/lib/shopperCoupons'
import Link from 'next/link'
import { useEffect, useId, useState } from 'react'

// The "Add a code" form on /coupons/[store]: a signed-in shopper shares a coupon
// code they know, and it joins the catalog as UNVERIFIED (POST
// /api/coupons/submit, source 'manual'). The page only renders this for a KNOWN
// store (isKnownStore), because the API answers 422 'not-a-store' for any other.
//
// RENDERS NOTHING UNTIL MOUNTED AND THE SESSION IS KNOWN, then the form (signed
// in) or a sign-in link (signed out). Same hydration hazard StoreFavoriteStar
// documents: the session is a cookie the CLIENT reads, so the server cannot know
// it; rendering nothing until mounted makes the hydrating render match the
// server. The server HTML (what crawlers and the AEO prose depend on) therefore
// gains nothing from this component.
//
// NO router.refresh() AFTER A SUCCESSFUL ADD, deliberately. The store page is
// dynamic (Cache-Control: no-store, not in the prerender manifest), so a reload
// always shows the new row, but CouponsSection seeds its list into client state
// from `initialCoupons`, which a refresh() does not reset: calling it would
// re-render the server parts (the count in the prose) and leave the visible
// list unchanged. So the success message promises only what is true.
//
// Client-side the code is checked with the SAME normalizeShopperCode the route
// and the repo use (shopperCoupons.ts is pure, no server-only imports), so an
// obviously invalid code never costs a round trip. The server stays the
// authority: it re-validates and its 422 'invalid-code' gets the same message.
//
// TODO: /login has no return-path support (it always lands on `/` after sign-in,
// LoginPageClient.tsx), so the sign-in link is a plain /login. Adding a vetted
// `next` param is its own change (open-redirect surface).

type Feedback = { kind: 'success' | 'info' | 'error'; text: string }

const INVALID_CODE_MESSAGE = "That doesn't look like a coupon code."
const NOT_A_STORE_MESSAGE = "We can't add codes for this store yet."
const GENERIC_FAILURE_MESSAGE = "Couldn't add that code. Try again."
const DAILY_LIMIT_MESSAGE = `You've shared ${SHOPPER_DAILY_SUBMISSION_CAP} codes today. Try again tomorrow.`
const RATE_LIMITED_MESSAGE = 'Too many attempts. Wait a moment and try again.'

const ADDED_MESSAGE =
    "Thanks! Added as Unverified. It's now in this store's list for other shoppers."
const ALREADY_LISTED_MESSAGE =
    'That code is already listed for this store. Thanks for checking!'

const FEEDBACK_CLS: Record<Feedback['kind'], string> = {
    success: 'text-green-700 dark:text-green-300',
    info: 'text-gray-700 dark:text-gray-300',
    error: 'text-red-700 dark:text-red-300',
}

type SubmitOutcome =
    | { kind: 'added' | 'already-listed' }
    | { kind: 'signed-out' }
    | { kind: 'refused'; message: string }
    | { kind: 'failed'; error: Error }

async function readErrorCode(res: Response): Promise<string | null> {
    try {
        const body: unknown = await res.json()
        if (
            typeof body === 'object' &&
            body !== null &&
            'error' in body &&
            typeof body.error === 'string'
        ) {
            return body.error
        }
        return null
    } catch {
        // An unreadable error body is not an expected refusal: the caller maps
        // a null code to the generic failure, which IS reported.
        return null
    }
}

async function submitCode(
    store: string,
    shopperCode: string,
): Promise<SubmitOutcome> {
    let res: Response
    try {
        res = await fetch('/api/coupons/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                site: store,
                code: shopperCode,
                source: 'manual',
            }),
        })
    } catch (error) {
        return {
            kind: 'failed',
            error: error instanceof Error ? error : new Error(String(error)),
        }
    }

    if (res.ok) {
        const body: unknown = await res.json().catch(() => null)
        if (
            typeof body === 'object' &&
            body !== null &&
            'created' in body &&
            typeof body.created === 'boolean'
        ) {
            return { kind: body.created ? 'added' : 'already-listed' }
        }
        return {
            kind: 'failed',
            error: new Error('coupons/submit 200 with an unrecognised body'),
        }
    }

    if (res.status === 401) return { kind: 'signed-out' }

    const code = await readErrorCode(res)
    if (res.status === 422 && code === 'invalid-code') {
        return { kind: 'refused', message: INVALID_CODE_MESSAGE }
    }
    if (res.status === 422 && code === 'not-a-store') {
        return { kind: 'refused', message: NOT_A_STORE_MESSAGE }
    }
    if (res.status === 429) {
        return {
            kind: 'refused',
            message:
                code === 'daily-limit'
                    ? DAILY_LIMIT_MESSAGE
                    : RATE_LIMITED_MESSAGE,
        }
    }
    return {
        kind: 'failed',
        error: new Error(
            `coupons/submit ${res.status}${code ? ` ${code}` : ''}`,
        ),
    }
}

export default function AddCodeForm({ store }: { store: string }) {
    const { data: session, isPending } = useSession()
    const [mounted, setMounted] = useState(false)
    const [code, setCode] = useState('')
    const [busy, setBusy] = useState(false)
    const [feedback, setFeedback] = useState<Feedback | null>(null)
    // The server said 401 although the client thought it had a session (an
    // expired cookie): fall back to the sign-in prompt.
    const [sessionRejected, setSessionRejected] = useState(false)
    const inputId = useId()
    const feedbackId = useId()

    useEffect(() => setMounted(true), [])

    if (!mounted || isPending) return null

    const signedIn = Boolean(session?.user) && !sessionRejected

    if (!signedIn) {
        return (
            <section
                aria-labelledby={`${inputId}-heading`}
                className="mx-auto max-w-4xl pb-8"
            >
                <h2
                    id={`${inputId}-heading`}
                    className="mb-2 text-2xl font-bold tracking-tight text-gray-900 dark:text-white"
                >
                    Know a code for {store}?
                </h2>
                <Link
                    href="/login"
                    className="font-semibold text-caramel underline underline-offset-2 hover:text-orange-600"
                >
                    Sign in to share a code
                </Link>
            </section>
        )
    }

    const onSubmit = async (event: React.FormEvent) => {
        event.preventDefault()
        if (busy) return
        const normalized = normalizeShopperCode(code)
        if (normalized === null) {
            setFeedback({ kind: 'error', text: INVALID_CODE_MESSAGE })
            return
        }
        setBusy(true)
        setFeedback(null)
        const outcome = await submitCode(store, normalized)
        setBusy(false)

        switch (outcome.kind) {
            case 'added':
                setCode('')
                setFeedback({ kind: 'success', text: ADDED_MESSAGE })
                return
            case 'already-listed':
                setCode('')
                setFeedback({ kind: 'info', text: ALREADY_LISTED_MESSAGE })
                return
            case 'signed-out':
                setSessionRejected(true)
                return
            case 'refused':
                setFeedback({ kind: 'error', text: outcome.message })
                return
            case 'failed':
                reportUserVisibleFailure({
                    error: outcome.error,
                    operation: 'shopper_code_submit',
                    extra: { store },
                })
                setFeedback({ kind: 'error', text: GENERIC_FAILURE_MESSAGE })
                return
        }
    }

    return (
        <section
            aria-labelledby={`${inputId}-heading`}
            className="mx-auto max-w-4xl pb-8"
        >
            <h2
                id={`${inputId}-heading`}
                className="mb-2 text-2xl font-bold tracking-tight text-gray-900 dark:text-white"
            >
                Know a code for {store}?
            </h2>
            <p className="mb-4 leading-relaxed text-gray-600 dark:text-gray-400">
                Share it with other shoppers. It shows as Unverified until
                someone uses it.
            </p>
            <form
                onSubmit={onSubmit}
                noValidate
                className="flex flex-col gap-3 sm:flex-row sm:items-end"
            >
                <div className="flex-1">
                    <label
                        htmlFor={inputId}
                        className="mb-1 block text-sm font-semibold text-gray-700 dark:text-gray-200"
                    >
                        Coupon code
                    </label>
                    <input
                        id={inputId}
                        type="text"
                        value={code}
                        onChange={e => setCode(e.target.value)}
                        autoComplete="off"
                        autoCapitalize="characters"
                        spellCheck={false}
                        maxLength={64}
                        aria-describedby={feedback ? feedbackId : undefined}
                        className="w-full rounded-full border-2 border-caramel/30 bg-white px-6 py-3 placeholder-gray-400 shadow-sm outline-none transition-all focus:border-caramel dark:bg-darkSurface dark:text-white dark:placeholder-gray-500 dark:focus:border-orange-400"
                    />
                </div>
                <button
                    type="submit"
                    disabled={busy}
                    className="min-h-[44px] rounded-full bg-gradient-to-r from-caramel to-orange-600 px-8 py-3 font-semibold text-white shadow transition-all hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-caramel focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-70 dark:focus-visible:ring-offset-darkBg"
                >
                    {busy ? 'Adding…' : 'Add code'}
                </button>
            </form>
            {feedback && (
                <p
                    id={feedbackId}
                    role={feedback.kind === 'error' ? 'alert' : 'status'}
                    className={`mt-3 text-sm font-medium ${FEEDBACK_CLS[feedback.kind]}`}
                >
                    {feedback.text}
                </p>
            )}
        </section>
    )
}
