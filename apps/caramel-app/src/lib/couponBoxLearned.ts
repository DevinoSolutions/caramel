// src/lib/couponBoxLearned.ts
//
// Learned coupon box: the ONE home for the `learned_coupon_boxes` tables,
// their write rule, their serving rule and their retention.
//
// When the extension finds a store's coupon box itself (rules, the server
// pick, or an earlier learned answer), types a code into it and the STORE
// ANSWERS (the total dropped, or the store showed a coupon reply), it reports
// the box here as `confirmed`; a box it was pointed at that did not work is
// reported `failed`. Once enough independent shoppers have confirmed the same
// box, POST /api/extension/coupon-box-pick answers with it straight away: no
// model call, no budget spent.
//
// This is a crowd-sourced write path, so nothing in it is trusted. The
// attacker this is built against can mint install ids for free and owns a
// few IP addresses, so a NETWORK (/24 IPv4, /48 IPv6) is the unit of
// independence, and every rule counts networks, not reports:
//
//   - Selectors only, inside the grammar in couponBoxSelector.ts. Never page
//     text, outline text, codes, IPs or install ids.
//   - A STORE is the registrable domain a host belongs to
//     (learnedStoreDomain): `r1.shop.com` and `www.shop.com` are one store.
//     A box is filed under the host it was found on (the pick is asked with
//     the host), but every cap, the lock, the reporter hashes and the
//     hand-over are keyed by the store, so inventing hosts under one store
//     buys nothing. Hosts on a shared hosting suffix (vercel.app, github.io,
//     ...) are refused; `<shop>.myshopify.com` is the one exception, and is
//     its own store.
//   - Who reported a box is kept only as two salted hashes, PER STORE: the
//     extension's install id and the reporter's network prefix, each hashed
//     together with the store's domain, so rows cannot be joined across
//     stores into one install's store history. A reporter's network is the
//     one it FIRST reported from and never changes, so moving an install to
//     another network cannot free a slot on the first.
//   - One install counts at most once per 24 hours per box and per outcome.
//     At most 2 NEW reporters per network per box per 7 days (more are
//     ignored). At most 50 reporters per box: room is made by deleting the
//     longest-unseen reporter whose removal changes nothing the serving rule
//     reads (a second voice of a network already heard), else the
//     longest-unseen reporter that is not failing the box or whose failure is
//     over 30 days old; a network's only fresh failing voice is kept.
//   - At most 5 boxes per store, and one network may report on at most 3 of
//     them. A new box replaces the weakest box that is not servable (fewest
//     confirming networks, then oldest confirmation); a servable box is never
//     replaced.
//   - A `failed` report for a box nobody confirmed creates nothing.
//   - Serving: assessLearnedBox below.
//   - Retention: a box with no confirmation for 60 days, and a reporter not
//     seen for 60 days, are deleted (at every report for its store, and by
//     the pruner instrumentation.ts starts).
//   - Every write for a store runs under one per-store transaction lock, so
//     the caps and the 24-hour window hold under concurrent reports.
//   - A store with a served config never reads or writes these tables (the
//     routes check that first, couponsRepo.hasServedStoreConfig).
//
// Off unless COUPON_BOX_LEARNED_ENABLED is on AND the coupon-box pick is on
// (couponBoxLlmEnabled); env.ts refuses to boot with the switch on and no
// salt. RUNBOOK.md "Learned coupon box" has the switch, the wipe and the
// privacy statement.
import { couponBoxDomainSchema, couponBoxLlmEnabled } from '@/lib/couponBoxPick'
import { isLearnedBoxSelector } from '@/lib/couponBoxSelector'
import { env } from '@/lib/env'
import { INSTALL_ID_PATTERN } from '@/lib/extensionInstall'
import prisma from '@/lib/prisma'
import {
    AUTO_DETECT_SUGGESTION_SOURCE,
    normalizeSuggestedDomain,
} from '@/lib/siteSuggestions'
import { resolveStoreDomain } from '@/lib/storeDomain'
import { Prisma } from '@prisma/client'
import * as Sentry from '@sentry/nextjs'
import { createHmac } from 'node:crypto'
import { isIP } from 'node:net'
import { domainToASCII, domainToUnicode } from 'node:url'
import { parse as parseHost } from 'tldts'
import { z } from 'zod'

export const LEARNED_BOX_RULES = {
    /** Distinct installs, and distinct networks, whose latest word on the
     * box is a confirmation from the last `freshDays`. */
    minConfirmingInstalls: 3,
    minConfirmingNetworks: 3,
    /** Confirmations and failures older than this no longer count. */
    freshDays: 30,
    /** Failing reporters from this many networks suppress the box... */
    suppressAtFailingNetworks: 2,
    /** ...until confirmations from this many OTHER networks arrive after the
     * last failure. */
    recoveryNetworks: 2,
    /** New reporters one network may add to one box per window. */
    newReportersPerNetwork: 2,
    newReporterWindowDays: 7,
    /** Reporter rows kept per box. */
    maxReportersPerBox: 50,
    /** Boxes kept per store. */
    maxBoxesPerDomain: 5,
    /** Boxes of one store a single network may report on. */
    maxBoxesPerNetwork: 3,
    /** One install counts at most once per this window, per box and outcome. */
    countWindowHours: 24,
    /** A box with no confirmation, or a reporter not seen, for this long is
     * deleted. */
    pruneAfterDays: 60,
    /** Stores handed to the store pipeline per rolling 24 hours, overall. */
    handoverDailyCap: 50,
} as const

const DAY_MS = 24 * 60 * 60 * 1000
const daysBefore = (now: Date, days: number) =>
    new Date(now.getTime() - days * DAY_MS)

/** On only with its own switch on, the pick on, and a salt to hash reporters
 * with (env.ts already fails boot on the switch without a salt; the salt
 * check here keeps a test env from hashing with nothing). */
export function couponBoxLearnedEnabled(): boolean {
    return (
        env.COUPON_BOX_LEARNED_ENABLED &&
        couponBoxLlmEnabled() &&
        Boolean(env.COUPON_BOX_LEARNED_SALT)
    )
}

// ---------------------------------------------------------------------------
// The report body (POST /api/extension/coupon-box-learned).
// ---------------------------------------------------------------------------

// The unique key spans three selectors plus the domain; a btree entry must
// stay under ~2.7 kB, so bytes are capped as well as characters.
const SELECTOR_MAX_BYTES = 512

const selectorSchema = z
    .string()
    .trim()
    .min(1)
    .refine(s => Buffer.byteLength(s, 'utf8') <= SELECTOR_MAX_BYTES, {
        error: 'selector too long',
    })
    .refine(isLearnedBoxSelector, {
        error: 'not an accepted coupon box selector',
    })

// Shared hosting suffixes (the private section of the Public Suffix List)
// where the label in front IS a separate store we may learn about. Only
// Shopify's: a store's own checkout can live on `<shop>.myshopify.com`, and
// the extension and served configs already treat that host as the store
// (store-detect.js, couponsRepo.hasServedStoreConfig). Every other private
// suffix (vercel.app, github.io, netlify.app, herokuapp.com, ...) is anyone's
// free hosting, not a store's checkout, so its hosts are refused.
const STORE_PLATFORM_SUFFIXES: ReadonlySet<string> = new Set(['myshopify.com'])

/**
 * The store a host belongs to, or null when the host may not have learned
 * boxes. For an ordinary host, the registrable domain on the Public Suffix
 * List (`r1.walmart.com` -> `walmart.com`; no single label, no IP, no
 * localhost or other unknown TLD, not a bare suffix like `co.uk`). For a
 * host on a shared hosting suffix: `<shop>.myshopify.com` itself, and null
 * for every other one. Every punycode label must decode and re-encode to
 * itself.
 */
export function learnedStoreDomain(host: string): string | null {
    const store = resolveStoreDomain(host)
    if (!store) return null
    const punycodeOk = host.split('.').every(label => {
        if (!label.startsWith('xn--')) return true
        const unicode = domainToUnicode(label)
        return unicode !== label && domainToASCII(unicode) === label
    })
    if (!punycodeOk) return null
    const parsed = parseHost(host, { allowPrivateDomains: true })
    if (!parsed.isPrivate) return store
    // On a shared suffix only `<shop>.<suffix>` itself names a store.
    return parsed.publicSuffix &&
        STORE_PLATFORM_SUFFIXES.has(parsed.publicSuffix) &&
        parsed.domain === host
        ? host
        : null
}

/** A host a learned box may be filed under (learnedStoreDomain). */
export function isPlausibleLearnedDomain(domain: string): boolean {
    return learnedStoreDomain(domain) !== null
}

/** The store of an already-validated report. */
export function reportStoreDomain(report: { domain: string }): string {
    const store = learnedStoreDomain(report.domain)
    if (!store) {
        // learnedBoxReportSchema refuses such a host; reaching this is a
        // wiring defect, never a report to file under a guessed store.
        throw new Error(
            `learned coupon box: "${report.domain.slice(0, 64)}" names no store`,
        )
    }
    return store
}

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
        // The extension's anonymous install id. Only a per-store salted hash
        // of it is kept.
        installId: z.string().regex(INSTALL_ID_PATTERN),
        domain: couponBoxDomainSchema.refine(isPlausibleLearnedDomain, {
            error: 'not a store domain',
        }),
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
// Reporter identity: per-store salted hashes only.
// ---------------------------------------------------------------------------

function saltedHash(
    kind: 'install' | 'network',
    value: string,
    domain: string,
): string {
    const salt = env.COUPON_BOX_LEARNED_SALT
    if (!salt) {
        // Every caller checks couponBoxLearnedEnabled() first; reaching this
        // without a salt is a wiring defect, never a quiet unsalted hash.
        throw new Error(
            'COUPON_BOX_LEARNED_SALT is not set: learned coupon boxes cannot hash a reporter',
        )
    }
    // The domain is part of the hashed value, so the same install (or
    // network) hashes differently on every store: rows of two stores cannot
    // be joined on it.
    return createHmac('sha256', salt)
        .update(`${kind}\n${value}\n${domain}`)
        .digest('hex')
}

export function hashInstallId(installId: string, domain: string): string {
    return saltedHash('install', installId.toLowerCase(), domain)
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

export function hashNetwork(ip: string, domain: string): string {
    return saltedHash('network', networkPrefix(ip), domain)
}

// ---------------------------------------------------------------------------
// Serving rule.
// ---------------------------------------------------------------------------

/** What the serving rule reads of one reporter row. */
export interface ReporterEvidence {
    installHash: string
    networkHash: string
    lastConfirmedAt: Date | null
    lastFailedAt: Date | null
}

/** The reporter's latest counted word on the box is "failed" (a tie reads as
 * failed). */
function latestIsFailure(r: ReporterEvidence): boolean {
    return (
        r.lastFailedAt !== null &&
        (r.lastConfirmedAt === null || r.lastFailedAt >= r.lastConfirmedAt)
    )
}

export interface LearnedBoxAssessment {
    servable: boolean
    confirmingInstalls: number
    confirmingNetworks: number
    failingNetworks: number
    /** Failing reporters on enough networks, not yet outvoted by new ones. */
    suppressed: boolean
}

/**
 * The serving rule, over a box's reporter rows. Served only when ALL hold:
 *
 *   1. at least 3 installs AND at least 3 networks whose latest word on the
 *      box is a confirmation from the last 30 days (a reporter that has since
 *      failed it no longer counts);
 *   2. more confirming networks than failing networks (failing = latest word
 *      a failure from the last 30 days; failures from one network count once);
 *   3. if failing reporters sit on 2 or more networks, confirmations from at
 *      least 2 OTHER networks arrived after the most recent failure.
 */
export function assessLearnedBox(
    reporters: readonly ReporterEvidence[],
    now: Date,
): LearnedBoxAssessment {
    const fresh = daysBefore(now, LEARNED_BOX_RULES.freshDays)
    const confirming = reporters.filter(
        r =>
            !latestIsFailure(r) &&
            r.lastConfirmedAt !== null &&
            r.lastConfirmedAt >= fresh,
    )
    const failing = reporters.filter(
        r =>
            latestIsFailure(r) &&
            r.lastFailedAt !== null &&
            r.lastFailedAt >= fresh,
    )
    const confirmingNetworks = new Set(confirming.map(r => r.networkHash))
    const confirmingInstalls = new Set(confirming.map(r => r.installHash))
    const failingNetworks = new Set(failing.map(r => r.networkHash))

    let suppressed = false
    if (failingNetworks.size >= LEARNED_BOX_RULES.suppressAtFailingNetworks) {
        const lastFailure = Math.max(
            ...failing.map(r => (r.lastFailedAt as Date).getTime()),
        )
        const recovered = new Set(
            confirming
                .filter(
                    r =>
                        (r.lastConfirmedAt as Date).getTime() > lastFailure &&
                        !failingNetworks.has(r.networkHash),
                )
                .map(r => r.networkHash),
        )
        suppressed = recovered.size < LEARNED_BOX_RULES.recoveryNetworks
    }

    return {
        servable:
            confirmingInstalls.size >=
                LEARNED_BOX_RULES.minConfirmingInstalls &&
            confirmingNetworks.size >=
                LEARNED_BOX_RULES.minConfirmingNetworks &&
            confirmingNetworks.size > failingNetworks.size &&
            !suppressed,
        confirmingInstalls: confirmingInstalls.size,
        confirmingNetworks: confirmingNetworks.size,
        failingNetworks: failingNetworks.size,
        suppressed,
    }
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

const REPORTER_EVIDENCE_SELECT = {
    installHash: true,
    networkHash: true,
    lastConfirmedAt: true,
    lastFailedAt: true,
} as const

/** The best servable learned box for `domain` (most confirming networks,
 * then most recently confirmed), or null. The caller has already ruled out a
 * store with a served config. At most 5 boxes of at most 50 reporters each
 * are read. */
export async function findServableLearnedBox(
    domain: string,
    now: Date = new Date(),
): Promise<ServedLearnedBox | null> {
    const boxes = await prisma.learnedCouponBox.findMany({
        where: {
            domain,
            lastConfirmedAt: {
                gte: daysBefore(now, LEARNED_BOX_RULES.freshDays),
            },
        },
        include: { reporters: { select: REPORTER_EVIDENCE_SELECT } },
    })
    const best = boxes
        .map(box => ({ box, assessment: assessLearnedBox(box.reporters, now) }))
        .filter(({ assessment }) => assessment.servable)
        .sort(
            (a, b) =>
                b.assessment.confirmingNetworks -
                    a.assessment.confirmingNetworks ||
                b.box.lastConfirmedAt.getTime() -
                    a.box.lastConfirmedAt.getTime(),
        )[0]
    if (!best) return null
    return {
        input: best.box.inputSelector,
        apply: best.box.applySelector || null,
        toggle: best.box.toggleSelector || null,
        enterOnly: best.box.enterOnly,
    }
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
           * then hands the store to the pipeline, once per domain ever). */
          servable: boolean
      }
    | {
          recorded: false
          /** unknown_box: a failure for a box nobody confirmed.
           * ignored: a cap refused it (reporters per network, reporters per
           * box, boxes per store, boxes per network). Neither is an error. */
          reason: 'unknown_box' | 'ignored'
      }

interface RecordInput {
    report: LearnedBoxReport
    installHash: string
    networkHash: string
    now?: Date
}

/** The per-store transaction lock every write for one store queues behind. */
async function lockStore(
    tx: Prisma.TransactionClient,
    storeDomain: string,
): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`learned-coupon-box:${storeDomain}`}, 0))`
}

/** Retention for one store. Call it holding the store's lock. */
async function pruneStore(
    tx: Prisma.TransactionClient,
    storeDomain: string,
    cutoff: Date,
): Promise<{ boxes: number; reporters: number }> {
    const boxes = await tx.learnedCouponBox.deleteMany({
        where: { storeDomain, lastConfirmedAt: { lt: cutoff } },
    })
    const reporters = await tx.learnedCouponBoxReporter.deleteMany({
        where: { box: { storeDomain }, lastSeenAt: { lt: cutoff } },
    })
    return { boxes: boxes.count, reporters: reporters.count }
}

/**
 * Record one report. Runs in one transaction holding a per-store advisory
 * lock, so concurrent reports for a store run one after another and every
 * cap and count below is read and written atomically. Retried once when two
 * first reports race on the same unique key. Throws on any other database
 * error: the route turns that into a reported 500, never a quiet "recorded".
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
    const storeDomain = reportStoreDomain(report)
    const key = {
        domain: report.domain,
        inputSelector: report.box.input,
        applySelector: report.box.apply ?? '',
        toggleSelector: report.box.toggle ?? '',
        enterOnly: report.box.enterOnly,
    }
    const confirmed = report.outcome === 'confirmed'
    const pruneCutoff = daysBefore(now, LEARNED_BOX_RULES.pruneAfterDays)
    const ignored = { recorded: false, reason: 'ignored' } as const

    return prisma.$transaction(
        async (tx): Promise<LearnedReportResult> => {
            // Every write for this store, on any of its hosts, queues behind
            // this lock until the transaction ends.
            await lockStore(tx, storeDomain)
            // Retention for this store, before anything is counted.
            await pruneStore(tx, storeDomain, pruneCutoff)

            let box = await tx.learnedCouponBox.findUnique({
                where: {
                    domain_inputSelector_applySelector_toggleSelector_enterOnly:
                        key,
                },
            })
            let reporter = box
                ? await tx.learnedCouponBoxReporter.findUnique({
                      where: {
                          boxId_installHash: { boxId: box.id, installHash },
                      },
                  })
                : null

            if (!reporter) {
                // Only a confirmation can introduce a box.
                if (!box && !confirmed) {
                    return { recorded: false, reason: 'unknown_box' }
                }
                if (
                    box &&
                    !(await networkMayAddReporter(tx, box.id, networkHash, now))
                ) {
                    return ignored
                }
                if (
                    !(await networkMayJoinBox(
                        tx,
                        storeDomain,
                        box?.id ?? null,
                        networkHash,
                    ))
                ) {
                    return ignored
                }
                if (!box) {
                    if (!(await makeRoomForBox(tx, storeDomain, now))) {
                        return ignored
                    }
                    box = await tx.learnedCouponBox.create({
                        data: {
                            ...key,
                            storeDomain,
                            firstSource: report.source,
                            firstSeenAt: now,
                            lastConfirmedAt: now,
                        },
                    })
                } else if (!(await makeRoomForReporter(tx, box.id, now))) {
                    return ignored
                }
                reporter = await tx.learnedCouponBoxReporter.create({
                    data: {
                        boxId: box.id,
                        installHash,
                        // Fixed for the life of the row: see the update below.
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
            const outcomeUpdate = counted
                ? confirmed
                    ? { confirmations: { increment: 1 }, lastConfirmedAt: now }
                    : { failures: { increment: 1 }, lastFailedAt: now }
                : {}

            // The reporter's network is NOT rewritten: it stays the network
            // the install first reported from. Rewriting it would let one
            // network mint installs, move them to another network and mint
            // again, past the per-network caps without end.
            await tx.learnedCouponBoxReporter.update({
                where: { id: reporter.id },
                data: { lastSeenAt: now, ...outcomeUpdate },
            })
            await tx.learnedCouponBox.update({
                where: { id: reporter.boxId },
                data: outcomeUpdate,
            })

            const reporters = await tx.learnedCouponBoxReporter.findMany({
                where: { boxId: reporter.boxId },
                select: REPORTER_EVIDENCE_SELECT,
            })
            return {
                recorded: true,
                counted,
                servable: assessLearnedBox(reporters, now).servable,
            }
        },
        // Reports for one store wait for each other on the lock above.
        { timeout: 15_000 },
    )
}

/** At most newReportersPerNetwork new reporters per network per box per
 * newReporterWindowDays. */
async function networkMayAddReporter(
    tx: Prisma.TransactionClient,
    boxId: string,
    networkHash: string,
    now: Date,
): Promise<boolean> {
    const recentOnNetwork = await tx.learnedCouponBoxReporter.count({
        where: {
            boxId,
            networkHash,
            firstSeenAt: {
                gte: daysBefore(now, LEARNED_BOX_RULES.newReporterWindowDays),
            },
        },
    })
    return recentOnNetwork < LEARNED_BOX_RULES.newReportersPerNetwork
}

/**
 * One network reports on at most maxBoxesPerNetwork of a store's boxes (a
 * network already heard on this box is not joining a new one). Without this,
 * two networks could back every one of the store's boxes and keep a real box
 * from ever holding a slot.
 */
async function networkMayJoinBox(
    tx: Prisma.TransactionClient,
    storeDomain: string,
    boxId: string | null,
    networkHash: string,
): Promise<boolean> {
    const boxesOnNetwork = await tx.learnedCouponBox.findMany({
        where: { storeDomain, reporters: { some: { networkHash } } },
        select: { id: true },
    })
    if (boxId && boxesOnNetwork.some(b => b.id === boxId)) return true
    return boxesOnNetwork.length < LEARNED_BOX_RULES.maxBoxesPerNetwork
}

/** What a reporter's removal must leave unchanged for it to be a spare
 * voice. */
function assessmentKey(a: LearnedBoxAssessment): string {
    return [
        a.servable,
        a.confirmingNetworks,
        a.failingNetworks,
        a.suppressed,
    ].join('|')
}

/**
 * At most maxReportersPerBox reporter rows per box. When full, delete, in
 * this order of preference and longest-unseen first within each:
 *
 *   1. a SPARE voice: a reporter whose removal leaves what the serving rule
 *      reads unchanged (servable, confirming and failing networks,
 *      suppression), typically a second install of a network already heard.
 *      So filling a box with installs from a few networks only ever displaces
 *      those networks' own extra installs;
 *   2. a reporter whose latest word is not a failure, or whose failure is
 *      older than freshDays.
 *
 * A network's only fresh failing voice is never deleted to make room: that
 * failure is evidence, and deleting it would let a flood of new confirming
 * installs erase it. Returns false when nothing may go.
 */
async function makeRoomForReporter(
    tx: Prisma.TransactionClient,
    boxId: string,
    now: Date,
): Promise<boolean> {
    const rows = await tx.learnedCouponBoxReporter.findMany({
        where: { boxId },
        select: { id: true, lastSeenAt: true, ...REPORTER_EVIDENCE_SELECT },
        orderBy: { lastSeenAt: 'asc' },
    })
    if (rows.length < LEARNED_BOX_RULES.maxReportersPerBox) return true

    const whole = assessmentKey(assessLearnedBox(rows, now))
    const spare = rows.find(
        row =>
            assessmentKey(
                assessLearnedBox(
                    rows.filter(r => r.id !== row.id),
                    now,
                ),
            ) === whole,
    )
    const fresh = daysBefore(now, LEARNED_BOX_RULES.freshDays)
    const victim =
        spare ??
        rows.find(
            r =>
                !latestIsFailure(r) ||
                (r.lastFailedAt !== null && r.lastFailedAt < fresh),
        )
    if (!victim) return false
    await tx.learnedCouponBoxReporter.delete({ where: { id: victim.id } })
    return true
}

/**
 * At most maxBoxesPerDomain boxes per store (across all its hosts). When
 * full, the weakest box that is NOT servable (fewest confirming networks,
 * then the oldest last confirmation) is deleted to make room; a store whose
 * boxes are all servable takes no new box. A servable box needs 3 networks
 * and one network backs at most maxBoxesPerNetwork boxes, so a reporter on a
 * few networks can neither hold every slot nor push out a box the crowd
 * already proved.
 */
async function makeRoomForBox(
    tx: Prisma.TransactionClient,
    storeDomain: string,
    now: Date,
): Promise<boolean> {
    const boxes = await tx.learnedCouponBox.findMany({
        where: { storeDomain },
        include: { reporters: { select: REPORTER_EVIDENCE_SELECT } },
    })
    if (boxes.length < LEARNED_BOX_RULES.maxBoxesPerDomain) return true
    const weakest = boxes
        .map(box => ({ box, assessment: assessLearnedBox(box.reporters, now) }))
        .filter(({ assessment }) => !assessment.servable)
        .sort(
            (a, b) =>
                a.assessment.confirmingNetworks -
                    b.assessment.confirmingNetworks ||
                a.box.lastConfirmedAt.getTime() -
                    b.box.lastConfirmedAt.getTime(),
        )[0]
    if (!weakest) return false
    await tx.learnedCouponBox.delete({ where: { id: weakest.box.id } })
    return true
}

// ---------------------------------------------------------------------------
// Retention, store-wide (the per-store part runs inside every report).
// ---------------------------------------------------------------------------

/** Delete every box with no confirmation, and every reporter not seen, for
 * pruneAfterDays. Each store is pruned under its own lock, like a report, so
 * a delete never races a report adding a reporter to the same box. Returns
 * what it deleted. */
export async function pruneLearnedCouponBoxes(
    now: Date = new Date(),
): Promise<{ boxes: number; reporters: number }> {
    const cutoff = daysBefore(now, LEARNED_BOX_RULES.pruneAfterDays)
    const stores = await prisma.learnedCouponBox.findMany({
        where: {
            OR: [
                { lastConfirmedAt: { lt: cutoff } },
                { reporters: { some: { lastSeenAt: { lt: cutoff } } } },
            ],
        },
        select: { storeDomain: true },
        distinct: ['storeDomain'],
    })
    const total = { boxes: 0, reporters: 0 }
    for (const { storeDomain } of stores) {
        const deleted = await prisma.$transaction(async tx => {
            await lockStore(tx, storeDomain)
            return pruneStore(tx, storeDomain, cutoff)
        })
        total.boxes += deleted.boxes
        total.reporters += deleted.reporters
    }
    return total
}

const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000
let pruneTimer: ReturnType<typeof setInterval> | null = null

async function pruneAndReport(): Promise<void> {
    try {
        const deleted = await pruneLearnedCouponBoxes()
        if (deleted.boxes || deleted.reporters) {
            console.log('[learned-coupon-box] retention prune', deleted)
        }
    } catch (error) {
        console.error('[learned-coupon-box] retention prune failed', error)
        Sentry.captureException(error, {
            tags: { area: 'learned_coupon_box', operation: 'prune' },
        })
    }
}

/**
 * Run the store-wide retention prune now and every 6 hours, whatever the
 * switch says (rows written while it was on still age out after it is
 * turned off). Idempotent and unref'd. Started once from instrumentation.ts.
 */
export function startLearnedCouponBoxPruner(): void {
    if (pruneTimer) return
    void pruneAndReport()
    pruneTimer = setInterval(() => void pruneAndReport(), PRUNE_INTERVAL_MS)
    if (typeof pruneTimer.unref === 'function') pruneTimer.unref()
}

// ---------------------------------------------------------------------------
// Hand-over to the store pipeline.
// ---------------------------------------------------------------------------

export type HandoverResult =
    | { created: true }
    | { created: false; reason: 'already' | 'daily_cap' | 'not_a_store' }

/**
 * Hand a store (its registrable domain, reportStoreDomain: never one of its
 * hosts, so inventing hosts cannot hand one store over many times or spend
 * the daily cap) whose box just became servable to the store pipeline, as one
 * site-suggestions row with no user and no requester email (so nothing the
 * pipeline later does to it can mail a shopper). At most ONCE per store ever
 * (learned_coupon_box_handovers is never pruned, and a wiped box does not
 * reopen it), and at most handoverDailyCap stores per rolling 24 hours
 * overall; a store refused by the cap is handed over on a later servable
 * report. Serialised by its own advisory lock.
 */
export async function handOverLearnedStore(
    domain: string,
    now: Date = new Date(),
): Promise<HandoverResult> {
    const suggested = normalizeSuggestedDomain(domain)
    if (!suggested) return { created: false, reason: 'not_a_store' }
    return prisma.$transaction(async (tx): Promise<HandoverResult> => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'learned-coupon-box:handover'}, 0))`
        const existing = await tx.learnedCouponBoxHandover.findUnique({
            where: { domain },
            select: { domain: true },
        })
        if (existing) return { created: false, reason: 'already' }
        const today = await tx.learnedCouponBoxHandover.count({
            where: { handedOverAt: { gte: daysBefore(now, 1) } },
        })
        if (today >= LEARNED_BOX_RULES.handoverDailyCap) {
            return { created: false, reason: 'daily_cap' }
        }
        await tx.learnedCouponBoxHandover.create({
            data: { domain, handedOverAt: now },
        })
        await tx.siteSuggestion.create({
            data: {
                domain: suggested,
                rawUrl: `https://${suggested}/`,
                userId: null,
                requesterEmail: null,
                source: AUTO_DETECT_SUGGESTION_SOURCE,
                userAgent: null,
            },
            select: { id: true },
        })
        return { created: true }
    })
}
