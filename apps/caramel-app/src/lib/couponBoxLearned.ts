// src/lib/couponBoxLearned.ts
//
// Learned coupon box: the ONE home for the `learned_coupon_boxes` table, its
// write rule and its serving rule.
//
// When the extension finds a store's coupon box itself (rules, the server
// pick, or an earlier learned answer), types a code into it and the STORE
// ANSWERS (the total dropped, or the store showed a coupon reply), it reports
// the box here as `confirmed`; a box it was pointed at that did not work is
// reported `failed`. Once enough independent shoppers have confirmed the same
// box, POST /api/extension/coupon-box-pick answers with it straight away: no
// model call, no budget spent.
//
// This is a crowd-sourced write path, so nothing in it is trusted:
//
//   - Only selectors are stored, validated as CSS on the way in (length cap,
//     no `javascript:`, `url(`, `expression`, braces, `;`, `<`, backslash or
//     control characters, never XPath). Never page text, outline text, codes,
//     IPs or install ids.
//   - Who reported a box is kept only as two one-way hashes under
//     COUPON_BOX_LEARNED_SALT: the extension's anonymous install id, and the
//     reporter's network prefix (/24 IPv4, /48 IPv6). Both are forgeable by a
//     determined client (a script can mint install ids), which is why serving
//     needs BOTH several installs AND several networks.
//   - One install counts at most once per 24 hours per box and per outcome, so
//     a single client cannot pump the counters.
//   - A `failed` report for a box nobody confirmed creates nothing.
//   - Serving (LEARNED_BOX_RULES): at least 2 distinct installs, at least 2
//     distinct networks, confirmations > failures, and a counted confirmation
//     in the last 30 days. A failure majority or 30 quiet days stops it.
//   - A store with a served config never reads or writes this table (the
//     route checks that first, couponsRepo.hasServedStoreConfig).
//
// Off unless the coupon-box pick is on (couponBoxLlmEnabled) AND a salt is
// configured; RUNBOOK.md "learned coupon box" has the switch, the wipe and the
// privacy statement.
import { couponBoxDomainSchema, couponBoxLlmEnabled } from '@/lib/couponBoxPick'
import { env } from '@/lib/env'
import { INSTALL_ID_PATTERN } from '@/lib/extensionInstall'
import prisma from '@/lib/prisma'
import { Prisma, type LearnedCouponBox } from '@prisma/client'
import { createHmac } from 'node:crypto'
import { isIP } from 'node:net'
import { z } from 'zod'

export const LEARNED_BOX_RULES = {
    /** Distinct install hashes that must have reported the box. */
    minInstalls: 2,
    /** Distinct network-prefix hashes among those reporters. */
    minNetworks: 2,
    /** A counted confirmation must be at most this old. */
    maxAgeDays: 30,
    /** Reporter rows kept per box; the least recently seen is dropped. */
    maxReportersPerBox: 50,
    /** One install counts at most once per this window, per box and outcome. */
    countWindowHours: 24,
} as const

const DAY_MS = 24 * 60 * 60 * 1000

/** On only with the pick on AND a salt to hash reporters with. */
export function couponBoxLearnedEnabled(): boolean {
    return couponBoxLlmEnabled() && Boolean(env.COUPON_BOX_LEARNED_SALT)
}

// ---------------------------------------------------------------------------
// The report body (POST /api/extension/coupon-box-learned).
// ---------------------------------------------------------------------------

const SELECTOR_MAX_CHARS = 256
// The unique key spans three selectors plus the domain; a btree entry must
// stay under ~2.7 kB, so bytes are capped as well as characters.
const SELECTOR_MAX_BYTES = 512
// Built with the constructor: this project's compile target rejects a literal
// `u` flag. \p{Cc} = every control character, not only ASCII ones.
const SELECTOR_FORBIDDEN = new RegExp(
    'javascript:|url\\s*\\(|expression|[{};<\\\\]|\\p{Cc}',
    'iu',
)
// XPath (what store configs use) is not accepted here: these are CSS only.
const XPATH_SHAPED = /^(?:\/|\(|\.\/)/

const selectorSchema = z
    .string()
    .trim()
    .min(1)
    .max(SELECTOR_MAX_CHARS)
    .refine(s => Buffer.byteLength(s, 'utf8') <= SELECTOR_MAX_BYTES, {
        error: 'selector too long',
    })
    .refine(s => !SELECTOR_FORBIDDEN.test(s) && !XPATH_SHAPED.test(s), {
        error: 'not an accepted CSS selector',
    })

const learnedBoxSchema = z
    .object({
        input: selectorSchema,
        apply: selectorSchema.nullable(),
        toggle: selectorSchema.nullable(),
        // Applied with Enter: the box has no apply button.
        enterOnly: z.boolean(),
    })
    .strict()
    .refine(b => (b.apply === null) === b.enterOnly, {
        error: 'enterOnly must be true exactly when apply is null',
    })
    .refine(b => b.input !== b.apply && b.input !== b.toggle, {
        error: 'input must differ from apply and toggle',
    })

const LEARNED_BOX_SOURCES = ['rules', 'llm', 'server_learned'] as const
const LEARNED_BOX_EVIDENCE = ['total_dropped', 'store_answered'] as const

export const learnedBoxReportSchema = z
    .object({
        // The extension's anonymous install id (install-attribution.js). Only
        // its salted hash is kept.
        installId: z.string().regex(INSTALL_ID_PATTERN),
        domain: couponBoxDomainSchema,
        box: learnedBoxSchema,
        source: z.enum(LEARNED_BOX_SOURCES),
        // What proved the store answered. Required for a confirmation; a
        // failure has none to give.
        evidence: z.enum(LEARNED_BOX_EVIDENCE).nullish(),
        outcome: z.enum(['confirmed', 'failed']),
    })
    .strict()
    .refine(r => r.outcome === 'failed' || Boolean(r.evidence), {
        error: 'a confirmed report needs evidence',
        path: ['evidence'],
    })

export type LearnedBoxReport = z.infer<typeof learnedBoxReportSchema>

// ---------------------------------------------------------------------------
// Reporter identity: salted one-way hashes only.
// ---------------------------------------------------------------------------

function saltedHash(kind: 'install' | 'network', value: string): string {
    const salt = env.COUPON_BOX_LEARNED_SALT
    if (!salt) {
        // Every caller checks couponBoxLearnedEnabled() first; reaching this
        // without a salt is a wiring defect, never a quiet unsalted hash.
        throw new Error(
            'COUPON_BOX_LEARNED_SALT is not set: learned coupon boxes cannot hash a reporter',
        )
    }
    return createHmac('sha256', salt).update(`${kind}:${value}`).digest('hex')
}

export function hashInstallId(installId: string): string {
    return saltedHash('install', installId.toLowerCase())
}

/** The network a request came from, coarse on purpose: the first three
 * octets of an IPv4 address, the first three groups of an IPv6 one. Anything
 * unreadable (no client IP) is one shared bucket, so it can count as one
 * network at most. */
export function networkPrefix(ip: string): string {
    const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/i.exec(
        ip,
    )
    if (v4 && isIP(ip.replace(/^::ffff:/i, '')) === 4) {
        return `v4:${v4[1]}.${v4[2]}.${v4[3]}`
    }
    if (isIP(ip) === 6) {
        const [head = '', tail = ''] = ip.toLowerCase().split('::')
        const headGroups = head ? head.split(':') : []
        const tailGroups = tail ? tail.split(':') : []
        const missing = 8 - headGroups.length - tailGroups.length
        const groups = ip.includes('::')
            ? [...headGroups, ...Array(missing).fill('0'), ...tailGroups]
            : headGroups
        return `v6:${groups
            .slice(0, 3)
            .map(g => g.replace(/^0+(?=.)/, ''))
            .join(':')}`
    }
    return 'unknown'
}

export function hashNetwork(ip: string): string {
    return saltedHash('network', networkPrefix(ip))
}

// ---------------------------------------------------------------------------
// Serving rule.
// ---------------------------------------------------------------------------

type ServingFields = Pick<
    LearnedCouponBox,
    | 'distinctInstalls'
    | 'distinctNetworks'
    | 'confirmations'
    | 'failures'
    | 'lastConfirmedAt'
>

function freshnessCutoff(now: Date): Date {
    return new Date(now.getTime() - LEARNED_BOX_RULES.maxAgeDays * DAY_MS)
}

/** The serving rule as a predicate. findServableLearnedBox's query is the
 * same rule in SQL; tests/integration/coupon-box-learned.itest.ts holds the
 * two together. */
export function isServableLearnedBox(box: ServingFields, now: Date): boolean {
    return (
        box.distinctInstalls >= LEARNED_BOX_RULES.minInstalls &&
        box.distinctNetworks >= LEARNED_BOX_RULES.minNetworks &&
        box.confirmations > box.failures &&
        box.lastConfirmedAt !== null &&
        box.lastConfirmedAt >= freshnessCutoff(now)
    )
}

/** What the pick serves: the same four fields the report carried. */
export interface ServedLearnedBox {
    input: string
    apply: string | null
    toggle: string | null
    enterOnly: boolean
}

/**
 * The pick's learned answer. `source: 'learned'` is how a build that sent
 * `acceptsLearned: true` tells it apart from a model answer; the selectors
 * ride under `box`, and the index fields a model answer carries are null so a
 * reader that ignores `source` finds nothing to act on.
 */
export interface CouponBoxLearnedAnswer {
    outcome: 'box'
    source: 'learned'
    input: null
    button: null
    toggle: null
    box: ServedLearnedBox
}

function toServed(row: LearnedCouponBox): ServedLearnedBox {
    return {
        input: row.inputSelector,
        apply: row.applySelector || null,
        toggle: row.toggleSelector || null,
        enterOnly: row.enterOnly,
    }
}

/** The best servable learned box for `domain`, or null. The caller has
 * already ruled out a store with a served config. */
export async function findServableLearnedBox(
    domain: string,
    now: Date = new Date(),
): Promise<ServedLearnedBox | null> {
    const row = await prisma.learnedCouponBox.findFirst({
        where: {
            domain,
            distinctInstalls: { gte: LEARNED_BOX_RULES.minInstalls },
            distinctNetworks: { gte: LEARNED_BOX_RULES.minNetworks },
            confirmations: { gt: prisma.learnedCouponBox.fields.failures },
            lastConfirmedAt: { gte: freshnessCutoff(now) },
        },
        orderBy: [{ confirmations: 'desc' }, { lastConfirmedAt: 'desc' }],
    })
    return row ? toServed(row) : null
}

// ---------------------------------------------------------------------------
// Write rule.
// ---------------------------------------------------------------------------

export type LearnedReportResult =
    | {
          recorded: true
          /** This report changed the box's counters (not inside the
           * install's 24h window). */
          counted: boolean
          /** The box meets the serving rule after this report (the route
           * then hands the store to the pipeline, once per domain). */
          servable: boolean
      }
    | { recorded: false; reason: 'unknown_box' }

interface RecordInput {
    report: LearnedBoxReport
    installHash: string
    networkHash: string
    now?: Date
}

/**
 * Record one report. Runs in a transaction; retried once when two concurrent
 * first reports race on the same unique key (the loser sees the winner's
 * row on the retry). Throws on any other database error: the route turns
 * that into a reported 500, never a quiet "recorded".
 */
export async function recordLearnedBoxReport(
    input: RecordInput,
): Promise<LearnedReportResult> {
    try {
        return await recordOnce(input)
    } catch (error) {
        if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002'
        ) {
            return recordOnce(input)
        }
        throw error
    }
}

async function recordOnce({
    report,
    installHash,
    networkHash,
    now = new Date(),
}: RecordInput): Promise<LearnedReportResult> {
    const key = {
        domain: report.domain,
        inputSelector: report.box.input,
        applySelector: report.box.apply ?? '',
        toggleSelector: report.box.toggle ?? '',
        enterOnly: report.box.enterOnly,
    }
    const confirmed = report.outcome === 'confirmed'

    return prisma.$transaction(async (tx): Promise<LearnedReportResult> => {
        let box = await tx.learnedCouponBox.findUnique({
            where: {
                domain_inputSelector_applySelector_toggleSelector_enterOnly:
                    key,
            },
        })
        if (!box) {
            // Only a confirmation can introduce a box.
            if (!confirmed) return { recorded: false, reason: 'unknown_box' }
            box = await tx.learnedCouponBox.create({
                data: { ...key, firstSource: report.source, firstSeenAt: now },
            })
        }

        let reporter = await tx.learnedCouponBoxReporter.findUnique({
            where: { boxId_installHash: { boxId: box.id, installHash } },
        })
        if (!reporter) {
            const kept = await tx.learnedCouponBoxReporter.findMany({
                where: { boxId: box.id },
                orderBy: { lastSeenAt: 'asc' },
                select: { id: true },
            })
            const overflow =
                kept.length - LEARNED_BOX_RULES.maxReportersPerBox + 1
            if (overflow > 0) {
                await tx.learnedCouponBoxReporter.deleteMany({
                    where: {
                        id: { in: kept.slice(0, overflow).map(r => r.id) },
                    },
                })
            }
            reporter = await tx.learnedCouponBoxReporter.create({
                data: {
                    boxId: box.id,
                    installHash,
                    networkHash,
                    firstSeenAt: now,
                    lastSeenAt: now,
                },
            })
        }

        // Counted at most once per window per install, box and outcome.
        const lastCounted = confirmed
            ? reporter.lastConfirmedAt
            : reporter.lastFailedAt
        const counted =
            lastCounted === null ||
            now.getTime() - lastCounted.getTime() >=
                LEARNED_BOX_RULES.countWindowHours * 60 * 60 * 1000

        await tx.learnedCouponBoxReporter.update({
            where: { id: reporter.id },
            data: {
                networkHash,
                lastSeenAt: now,
                ...(counted
                    ? confirmed
                        ? {
                              confirmations: { increment: 1 },
                              lastConfirmedAt: now,
                          }
                        : { failures: { increment: 1 }, lastFailedAt: now }
                    : {}),
            },
        })

        const distinctInstalls = await tx.learnedCouponBoxReporter.count({
            where: { boxId: box.id },
        })
        const networks = await tx.learnedCouponBoxReporter.findMany({
            where: { boxId: box.id },
            distinct: ['networkHash'],
            select: { networkHash: true },
        })
        const updated = await tx.learnedCouponBox.update({
            where: { id: box.id },
            data: {
                distinctInstalls,
                distinctNetworks: networks.length,
                ...(counted
                    ? confirmed
                        ? {
                              confirmations: { increment: 1 },
                              lastConfirmedAt: now,
                          }
                        : { failures: { increment: 1 }, lastFailedAt: now }
                    : {}),
            },
        })
        return {
            recorded: true,
            counted,
            servable: isServableLearnedBox(updated, now),
        }
    })
}
