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
//     another network cannot free a slot on the first, and the install counts
//     only from that network: a report from any other counts nothing.
//   - Across all stores, per day (networkMayAddBox): at most 20 new boxes
//     from one network and 100 from its wider block (/16 IPv4, /32 IPv6);
//     at most 3 hand-overs from one network and 10 from its block
//     (handOverLearnedStore). Counted in learned_coupon_box_network_events
//     under a hash of the prefix alone, with no store and the time cut to
//     the hour (so a row's time matches no box, reporter or hand-over row),
//     deleted after a day.
//   - A store heard from ONE network is provisional (learned_coupon_box_stores,
//     establishedAt null): at most 5000 such stores exist at once, and a new
//     one pushes out the oldest (makeRoomForStore). A store is established
//     once a second network confirms one of its boxes, at most 500 stores a
//     day (establishStoreIfConfirmed); one waiting past that cap stays
//     provisional, never refused. So made-up stores from a few networks
//     cannot freeze real stores' first boxes.
//   - Selectors may hold nothing that looks like personal data, and apply or
//     toggle never names checkout, payment, an order or a delete
//     (couponBoxSelector.ts).
//   - One install counts at most once per 24 hours per box and per outcome.
//     At most 2 NEW reporters per network per box per 7 days (more are
//     ignored). At most 50 reporters per box: room is made by deleting the
//     longest-unseen reporter whose removal changes nothing the serving rule
//     reads (a second voice of a network already heard), else the
//     longest-unseen reporter that is not failing the box or whose failure is
//     over 30 days old; a network's only fresh failing voice is kept.
//   - At most 5 boxes per store (boxToReplace). A full store makes room by
//     deleting its weakest box that is not servable, ranked by EXCLUSIVE
//     confirming networks (ones that confirm no other box of the store), then
//     all confirming networks, then the oldest confirmation. A servable box is
//     never replaced, and a box some network alone stands behind gives way
//     only to a new box whose network confirms nothing else in the store.
//     There is no cap on the boxes one network reports on: a network's second
//     box makes both of its boxes the first to go.
//   - A `failed` report for a box nobody confirmed creates nothing.
//   - Serving: assessLearnedBox below.
//   - Retention: a box with no confirmation for 60 days, and a reporter not
//     seen for 60 days, are deleted (at every report for its store, and by
//     the pruner instrumentation.ts starts).
//   - Every write for a store runs under one per-store transaction lock, so
//     the caps and the 24-hour window hold under concurrent reports. A report
//     never waits for that lock: one that finds it taken is answered
//     `ignored`, so parallel reports cannot hold database connections.
//   - A store with a served config never reads or writes these tables (the
//     routes check that first, couponsRepo.hasServedStoreConfig).
//
// Off unless COUPON_BOX_LEARNED_ENABLED is on AND the coupon-box pick is on
// (couponBoxLlmEnabled); env.ts refuses to boot with the switch on and no
// salt. RUNBOOK.md "Learned coupon box" has the switch, the wipe and the
// privacy statement.
import { couponBoxDomainSchema, couponBoxLlmEnabled } from '@/lib/couponBoxPick'
import {
    isLearnedBoxSelector,
    isRiskyControlSelector,
} from '@/lib/couponBoxSelector'
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
    /** ...and those networks must sit in at least this many wider blocks
     * (/16 IPv4, /32 IPv6). One person's free IPv6 tunnels, or a few
     * proxies from one range, are several networks but one block. */
    minConfirmingBlocks: 2,
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
    /** One install counts at most once per this window, per box and outcome. */
    countWindowHours: 24,
    /** A box with no confirmation, or a reporter not seen, for this long is
     * deleted. */
    pruneAfterDays: 60,
    /** Stores handed to the store pipeline per rolling 24 hours, overall. */
    handoverDailyCap: 50,
    /** Of those, stores the reports of one network may hand over, and of its
     * wider block (/16 IPv4, /32 IPv6). */
    handoversPerNetworkPerDay: 3,
    handoversPerBlockPerDay: 10,
    /** New boxes the reports of one network may add per day across every
     * store, and of its wider block. */
    newBoxesPerNetworkPerDay: 20,
    newBoxesPerBlockPerDay: 100,
    /** Stores heard from one network only, kept at once (the oldest gives
     * way to a new one). */
    provisionalStores: 5000,
    /** Stores that may become established (a second network confirms) per
     * day, overall. */
    storesEstablishedPerDay: 500,
} as const

/** Share of a global cap at which a warning is logged. */
const NEAR_CAP_SHARE = 0.8

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
    // The extension CLICKS apply and toggle: never one that names checkout,
    // payment, an order or a delete (couponBoxSelector.isRiskyControlSelector).
    .refine(
        b =>
            !(b.apply && isRiskyControlSelector(b.apply)) &&
            !(b.toggle && isRiskyControlSelector(b.toggle)),
        {
            error: 'apply and toggle must not name a checkout, payment, order or delete control',
        },
    )

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
    kind:
        | 'install'
        | 'network'
        | 'block'
        | 'network-any-store'
        | 'block-any-store',
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

/** The reporter's wider block (networkBlock), hashed per store like its
 * network: the serving rule wants confirmations from more than one block. */
export function hashBlock(ip: string, domain: string): string {
    return saltedHash('block', networkBlock(ip), domain)
}

/** The wider block a network sits in: the first two octets of an IPv4
 * address, the first two groups of an IPv6 one. Free IPv6 /48s come from a
 * handful of /32s, so a cap on the block holds where one on the /48 does
 * not. */
export function networkBlock(ip: string): string {
    const prefix = networkPrefix(ip)
    if (prefix === 'unknown') return prefix
    // `v4:a.b.c` or `v6:x:y:z`.
    const family = prefix.slice(0, 2)
    const rest = prefix.slice(3)
    return family === 'v4'
        ? `v4:${rest.split('.').slice(0, 2).join('.')}`
        : `v6:${rest.split(':').slice(0, 2).join(':')}`
}

/** A reporter's network and its wider block, each hashed with no store, for
 * the caps kept across stores (learned_coupon_box_network_events). Their own
 * kinds, so neither ever equals a per-store hash of the same prefix. */
export interface CrossStoreNetwork {
    network: string
    block: string
}

export function hashNetworkAcrossStores(ip: string): CrossStoreNetwork {
    return {
        network: saltedHash('network-any-store', networkPrefix(ip), ''),
        block: saltedHash('block-any-store', networkBlock(ip), ''),
    }
}

// ---------------------------------------------------------------------------
// Serving rule.
// ---------------------------------------------------------------------------

/** What the serving rule reads of one reporter row. */
export interface ReporterEvidence {
    installHash: string
    networkHash: string
    /** hashBlock of the network the install first reported from. Null on a
     * row written before the block was recorded: it counts toward no block. */
    blockHash: string | null
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

/** The reporter's latest word is a confirmation from the last freshDays. */
function isConfirming(r: ReporterEvidence, fresh: Date): boolean {
    return (
        !latestIsFailure(r) &&
        r.lastConfirmedAt !== null &&
        r.lastConfirmedAt >= fresh
    )
}

/** The distinct networks that confirm a box (isConfirming). */
function confirmingNetworksOf(
    reporters: readonly ReporterEvidence[],
    now: Date,
): string[] {
    const fresh = daysBefore(now, LEARNED_BOX_RULES.freshDays)
    return Array.from(
        new Set(
            reporters
                .filter(r => isConfirming(r, fresh))
                .map(r => r.networkHash),
        ),
    )
}

export interface LearnedBoxAssessment {
    servable: boolean
    confirmingInstalls: number
    confirmingNetworks: number
    confirmingBlocks: number
    failingNetworks: number
    /** Failing reporters on enough networks, not yet outvoted by new ones. */
    suppressed: boolean
}

/**
 * The serving rule, over a box's reporter rows. Served only when ALL hold:
 *
 *   1. at least 3 installs AND at least 3 networks whose latest word on the
 *      box is a confirmation from the last 30 days (a reporter that has since
 *      failed it no longer counts), and those networks span at least 2
 *      wider blocks (/16 IPv4, /32 IPv6);
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
    const confirming = reporters.filter(r => isConfirming(r, fresh))
    const failing = reporters.filter(
        r =>
            latestIsFailure(r) &&
            r.lastFailedAt !== null &&
            r.lastFailedAt >= fresh,
    )
    const confirmingNetworks = new Set(confirming.map(r => r.networkHash))
    const confirmingInstalls = new Set(confirming.map(r => r.installHash))
    const confirmingBlocks = new Set(
        confirming.flatMap(r => (r.blockHash === null ? [] : [r.blockHash])),
    )
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
            confirmingBlocks.size >= LEARNED_BOX_RULES.minConfirmingBlocks &&
            confirmingNetworks.size > failingNetworks.size &&
            !suppressed,
        confirmingInstalls: confirmingInstalls.size,
        confirmingNetworks: confirmingNetworks.size,
        confirmingBlocks: confirmingBlocks.size,
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
    blockHash: true,
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
          /** This report changed the box's counters (from the install's
           * first network, outside its 24h window). A report that did not
           * writes nothing. */
          counted: boolean
          /** The box meets the serving rule after this report (when the
           * report also counted, the route hands the store to the pipeline,
           * once per store ever). */
          servable: boolean
      }
    | {
          recorded: false
          /** unknown_box: a failure for a box nobody confirmed.
           * ignored: a cap refused it (reporters per network, reporters per
           * box, boxes per store, new boxes per network or block, the
           * provisional-store pool), or a lock it needed was taken. Neither
           * is an error. */
          reason: 'unknown_box' | 'ignored'
      }

interface RecordInput {
    report: LearnedBoxReport
    installHash: string
    /** hashNetwork: the reporter's network, for this store. */
    networkHash: string
    /** hashBlock: that network's wider block, for this store. */
    blockHash: string
    /** hashNetworkAcrossStores: the same network and its wider block, for the
     * caps kept across stores. */
    anyStoreNetwork: CrossStoreNetwork
    now?: Date
}

const IGNORED = { recorded: false, reason: 'ignored' } as const

const storeLockKey = (storeDomain: string) =>
    `learned-coupon-box:${storeDomain}`

/** Serialises the caps shared by every store: new boxes (per network and
 * block), the provisional-store pool and the stores established per day. */
const NEW_BOXES_LOCK_KEY = 'learned-coupon-box:new-boxes'

/** How long a report adding a new box waits for NEW_BOXES_LOCK_KEY before it
 * is answered `ignored`. Short: the lock is held only for a few inserts. */
const NEW_BOXES_LOCK_TIMEOUT = '250ms'

/** Wait for the per-store transaction lock. Only the store-wide prune waits:
 * it runs one store at a time on one connection. */
async function lockStore(
    tx: Prisma.TransactionClient,
    storeDomain: string,
): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${storeLockKey(storeDomain)}, 0))`
}

/** Take a transaction lock if it is free, without waiting. */
async function tryLock(
    tx: Prisma.TransactionClient,
    key: string,
): Promise<boolean> {
    const [row] = await tx.$queryRaw<
        { locked: boolean }[]
    >`SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS locked`
    return row?.locked === true
}

/** Take the per-store transaction lock if it is free, without waiting. A
 * report that waited would hold a pooled connection for as long as the lock
 * stays taken, so a few clients sending reports for one store in parallel
 * could use up the pool. */
function tryLockStore(
    tx: Prisma.TransactionClient,
    storeDomain: string,
): Promise<boolean> {
    return tryLock(tx, storeLockKey(storeDomain))
}

/** Take NEW_BOXES_LOCK_KEY, waiting at most NEW_BOXES_LOCK_TIMEOUT. When the
 * wait runs out Postgres aborts the transaction (lock_not_available), so
 * nothing the report did is kept and recordLearnedBoxReport answers
 * `ignored`. */
async function lockNewBoxes(tx: Prisma.TransactionClient): Promise<void> {
    await tx.$executeRawUnsafe(
        `SET LOCAL lock_timeout = '${NEW_BOXES_LOCK_TIMEOUT}'`,
    )
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${NEW_BOXES_LOCK_KEY}, 0))`
    await tx.$executeRawUnsafe('SET LOCAL lock_timeout = DEFAULT')
}

/** A bounded lock wait ran out (Postgres lock_not_available, 55P03). */
function isLockTimeout(error: unknown): boolean {
    return (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.meta as { code?: unknown } | undefined)?.code === '55P03'
    )
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
    // A store with no box left is forgotten: it starts provisional again.
    if (
        boxes.count > 0 &&
        (await tx.learnedCouponBox.count({ where: { storeDomain } })) === 0
    ) {
        await tx.learnedCouponBoxStore.deleteMany({ where: { storeDomain } })
    }
    return { boxes: boxes.count, reporters: reporters.count }
}

/**
 * Record one report. Runs in one transaction holding a per-store advisory
 * lock, so every cap and count below is read and written atomically. A report
 * that finds the lock taken is answered `ignored` at once rather than waiting
 * (tryLockStore); one adding a new box waits at most NEW_BOXES_LOCK_TIMEOUT
 * for the lock shared by every store, and is answered `ignored` with nothing
 * written when that runs out. Retried once when two first reports race on the
 * same unique key. Throws on any other database error: the route turns that
 * into a reported 500, never a quiet "recorded".
 */
export async function recordLearnedBoxReport(
    input: RecordInput,
): Promise<LearnedReportResult> {
    for (let attempt = 0; ; attempt += 1) {
        try {
            return await recordOnce(input)
        } catch (error) {
            if (isLockTimeout(error)) return IGNORED
            if (
                attempt === 0 &&
                error instanceof Prisma.PrismaClientKnownRequestError &&
                error.code === 'P2002'
            ) {
                continue
            }
            throw error
        }
    }
}

async function recordOnce({
    report,
    installHash,
    networkHash,
    blockHash,
    anyStoreNetwork,
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

    return prisma.$transaction(
        async (tx): Promise<LearnedReportResult> => {
            // Every write for this store, on any of its hosts, holds this
            // lock until the transaction ends. A report that finds it taken
            // is dropped, never queued.
            if (!(await tryLockStore(tx, storeDomain))) return IGNORED
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
                    return IGNORED
                }
                if (!box) {
                    box = await addBox(tx, {
                        key,
                        storeDomain,
                        networkHash,
                        anyStoreNetwork,
                        firstSource: report.source,
                        now,
                    })
                    if (!box) return IGNORED
                } else if (!(await makeRoomForReporter(tx, box.id, now))) {
                    return IGNORED
                }
                reporter = await tx.learnedCouponBoxReporter.create({
                    data: {
                        boxId: box.id,
                        installHash,
                        // Fixed for the life of the row: see the update below.
                        networkHash,
                        blockHash,
                        firstSeenAt: now,
                        lastSeenAt: now,
                    },
                })
            }

            // Counted at most once per window per install, box and outcome,
            // and only from the network the install first reported from. A
            // report from any other network counts nothing: otherwise a few
            // networks heard once could hand their installs to one machine
            // anywhere and keep confirming, or failing, a box from there.
            const lastCounted = confirmed
                ? reporter.lastConfirmedAt
                : reporter.lastFailedAt
            const counted =
                reporter.networkHash === networkHash &&
                (lastCounted === null ||
                    now.getTime() - lastCounted.getTime() >=
                        LEARNED_BOX_RULES.countWindowHours * 60 * 60 * 1000)

            // A report that counts nothing writes nothing, lastSeenAt
            // included: lastSeenAt is the reporter's latest COUNTED report,
            // which retention and eviction read, so reports from another
            // network cannot keep a row alive. The reporter's network is
            // never rewritten either: it stays the network the install first
            // reported from, or one network could mint installs, move them
            // and mint again, past the per-network caps without end.
            if (counted) {
                const outcomeUpdate = confirmed
                    ? { confirmations: { increment: 1 }, lastConfirmedAt: now }
                    : { failures: { increment: 1 }, lastFailedAt: now }
                await tx.learnedCouponBoxReporter.update({
                    where: { id: reporter.id },
                    data: { lastSeenAt: now, ...outcomeUpdate },
                })
                await tx.learnedCouponBox.update({
                    where: { id: reporter.boxId },
                    data: outcomeUpdate,
                })
                if (confirmed) {
                    await establishStoreIfConfirmed(tx, storeDomain, now)
                }
            }

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
        // Nothing in here waits for another report for long (tryLockStore,
        // lockNewBoxes).
        { timeout: 15_000 },
    )
}

/**
 * Add a new box, or answer null (the report is ignored) when a cap refuses
 * it. In this order, so that a network over its cap never touches the lock
 * every store's new boxes share, and that lock is held only for the inserts:
 *
 *   1. the network's and its block's new boxes today (networkMayAddBox), read
 *      without the shared lock;
 *   2. the store's own 5-box cap (boxToReplace), under the store's lock;
 *   3. the shared lock (lockNewBoxes), then 1 again (exact now) and, for a
 *      store not seen before, room in the provisional pool
 *      (makeRoomForStore);
 *   4. the writes: the replaced box goes, the store row, the two network
 *      events and the box are created.
 */
async function addBox(
    tx: Prisma.TransactionClient,
    {
        key,
        storeDomain,
        networkHash,
        anyStoreNetwork,
        firstSource,
        now,
    }: {
        key: {
            domain: string
            inputSelector: string
            applySelector: string
            toggleSelector: string
            enterOnly: boolean
        }
        storeDomain: string
        networkHash: string
        anyStoreNetwork: CrossStoreNetwork
        firstSource: string
        now: Date
    },
) {
    if (!(await networkMayAddBox(tx, anyStoreNetwork, now))) return null
    const room = await boxToReplace(tx, storeDomain, networkHash, now)
    if (!room.ok) return null

    await lockNewBoxes(tx)
    // Read again under the lock: parallel reports for other stores may have
    // added boxes from the same network since.
    if (!(await networkMayAddBox(tx, anyStoreNetwork, now))) return null
    const known = await tx.learnedCouponBoxStore.findUnique({
        where: { storeDomain },
        select: { storeDomain: true },
    })
    if (!known && !(await makeRoomForStore(tx))) return null

    if (room.replace) {
        await tx.learnedCouponBox.delete({ where: { id: room.replace } })
    }
    if (!known) {
        await tx.learnedCouponBoxStore.create({
            data: { storeDomain, firstSeenAt: now },
        })
    }
    await recordNetworkEvent(tx, anyStoreNetwork, 'box', now)
    return tx.learnedCouponBox.create({
        data: {
            ...key,
            storeDomain,
            firstSource,
            firstSeenAt: now,
            lastConfirmedAt: now,
        },
    })
}

// ---------------------------------------------------------------------------
// Caps kept across stores.
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000

/** A network event's time: `now` cut to the hour, so it equals no box,
 * reporter, store or hand-over timestamp and cannot be joined to one. */
function eventHour(now: Date): Date {
    return new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS)
}

/** The oldest event hour still counted. Events are kept for at least 24
 * hours and at most 25, since their time is cut to the hour. */
function eventWindowStart(now: Date): Date {
    return new Date(eventHour(now).getTime() - DAY_MS)
}

type NetworkEventKind = 'box' | 'handover'

async function recordNetworkEvent(
    tx: Prisma.TransactionClient,
    net: CrossStoreNetwork,
    kind: NetworkEventKind,
    now: Date,
): Promise<void> {
    const createdAt = eventHour(now)
    await tx.learnedCouponBoxNetworkEvent.createMany({
        data: [
            { networkHash: net.network, kind, createdAt },
            { networkHash: net.block, kind, createdAt },
        ],
    })
}

/** The network's and its block's `kind` events still in the window. */
async function networkEventCounts(
    db: Prisma.TransactionClient,
    net: CrossStoreNetwork,
    kind: NetworkEventKind,
    now: Date,
): Promise<{ network: number; block: number }> {
    const since = eventWindowStart(now)
    const network = await db.learnedCouponBoxNetworkEvent.count({
        where: { networkHash: net.network, kind, createdAt: { gte: since } },
    })
    const block = await db.learnedCouponBoxNetworkEvent.count({
        where: { networkHash: net.block, kind, createdAt: { gte: since } },
    })
    return { network, block }
}

/** At most newBoxesPerNetworkPerDay new boxes from one network, and
 * newBoxesPerBlockPerDay from its block, across every store per day. Without
 * them one network could create boxes on every registrable domain there is,
 * and the tables would grow without bound. */
async function networkMayAddBox(
    tx: Prisma.TransactionClient,
    net: CrossStoreNetwork,
    now: Date,
): Promise<boolean> {
    const today = await networkEventCounts(tx, net, 'box', now)
    return (
        today.network < LEARNED_BOX_RULES.newBoxesPerNetworkPerDay &&
        today.block < LEARNED_BOX_RULES.newBoxesPerBlockPerDay
    )
}

/** A store's boxes have been confirmed from at least two networks. */
async function confirmedByTwoNetworks(
    tx: Prisma.TransactionClient,
    storeDomain: string,
): Promise<boolean> {
    const networks = await tx.learnedCouponBoxReporter.findMany({
        where: { box: { storeDomain }, lastConfirmedAt: { not: null } },
        select: { networkHash: true },
        distinct: ['networkHash'],
        take: 2,
    })
    return networks.length >= 2
}

/**
 * At most provisionalStores stores heard from one network only. When the pool
 * is full, a new store pushes out the oldest provisional one that is not
 * already confirmed from two networks (one waiting for the daily cap) and
 * whose lock is free: all its boxes and the store row are deleted. Answers
 * false (the report is ignored) when there is none. A provisional store is
 * never servable (that needs 3 networks), so nothing served is lost, and made-
 * up stores cannot shut real ones out: they only push each other out.
 */
async function makeRoomForStore(
    tx: Prisma.TransactionClient,
): Promise<boolean> {
    const provisional = await tx.learnedCouponBoxStore.count({
        where: { establishedAt: null },
    })
    warnNearCap(
        'provisional stores',
        provisional,
        LEARNED_BOX_RULES.provisionalStores,
    )
    if (provisional < LEARNED_BOX_RULES.provisionalStores) return true
    const oldest = await tx.learnedCouponBoxStore.findMany({
        where: { establishedAt: null },
        orderBy: { firstSeenAt: 'asc' },
        take: 20,
        select: { storeDomain: true },
    })
    for (const { storeDomain } of oldest) {
        if (await confirmedByTwoNetworks(tx, storeDomain)) continue
        if (!(await tryLockStore(tx, storeDomain))) continue
        await tx.learnedCouponBox.deleteMany({ where: { storeDomain } })
        await tx.learnedCouponBoxStore.delete({ where: { storeDomain } })
        return true
    }
    return false
}

/**
 * After a counted confirmation: a provisional store whose boxes are now
 * confirmed from two networks becomes established, at most
 * storesEstablishedPerDay stores per day overall. One past the cap, or whose
 * report finds the shared lock taken (this never waits), stays provisional
 * and is tried again on its next counted confirmation; its report is
 * recorded either way.
 */
async function establishStoreIfConfirmed(
    tx: Prisma.TransactionClient,
    storeDomain: string,
    now: Date,
): Promise<void> {
    const store = await tx.learnedCouponBoxStore.findUnique({
        where: { storeDomain },
        select: { establishedAt: true },
    })
    if (!store || store.establishedAt) return
    if (!(await confirmedByTwoNetworks(tx, storeDomain))) return
    if (!(await tryLock(tx, NEW_BOXES_LOCK_KEY))) return
    const today = await tx.learnedCouponBoxStore.count({
        where: { establishedAt: { gt: daysBefore(now, 1) } },
    })
    warnNearCap(
        'stores established today',
        today,
        LEARNED_BOX_RULES.storesEstablishedPerDay,
    )
    if (today >= LEARNED_BOX_RULES.storesEstablishedPerDay) return
    await tx.learnedCouponBoxStore.update({
        where: { storeDomain },
        data: { establishedAt: now },
    })
}

const nearCapWarnedAt = new Map<string, number>()

/** Log (at most once an hour per cap) that a cap shared by every store is
 * past NEAR_CAP_SHARE: either real growth, or someone filling it. */
function warnNearCap(what: string, used: number, cap: number): void {
    if (used < cap * NEAR_CAP_SHARE) return
    const last = nearCapWarnedAt.get(what)
    if (last !== undefined && Date.now() - last < HOUR_MS) return
    nearCapWarnedAt.set(what, Date.now())
    console.warn('[learned-coupon-box] a global cap is nearly used up', {
        what,
        used,
        cap,
    })
}

/** Test-only: forget which caps were warned about. */
export function resetNearCapWarningsForTests(): void {
    nearCapWarnedAt.clear()
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

/** What a reporter's removal must leave unchanged for it to be a spare
 * voice. */
function assessmentKey(a: LearnedBoxAssessment): string {
    return [
        a.servable,
        a.confirmingNetworks,
        a.confirmingBlocks,
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
 * At most maxBoxesPerDomain boxes per store (across all its hosts). A box's
 * strength is, in order:
 *
 *   1. its EXCLUSIVE confirming networks: networks that confirm it and no
 *      other box of the store;
 *   2. all its confirming networks.
 *
 * When the store is full, its weakest box that is NOT servable (then the
 * oldest last confirmation) gives way: this answers which (`replace`), and
 * the caller deletes it only once every other cap has passed, so a refused
 * report deletes nothing. A servable box is never
 * replaced. A box with at least one exclusive network gives way only to a new
 * box whose network confirms no box of the store yet; a new box from a network
 * that already confirms one is refused instead.
 *
 * A network stands behind one box alone at a time, so an attacker with k
 * networks has at most k boxes that resist; every other box they hold is the
 * first to go. A young real box that a shopper's own network confirmed is
 * pushed out only when every other slot holds such a box and yet another
 * network that confirms nothing in the store arrives, and it is then the
 * oldest: about one network per slot, plus a fresh one per box pushed out.
 * Two or three networks churning junk cannot do it, however many boxes they
 * create. Extra exclusive networks give no further protection, so 5 boxes
 * backed by 2 such networks each still give way to a new one and cannot hold
 * the store. The cost: two different boxes confirmed from one shared network
 * (an office or carrier /24) are both the first to go.
 */
async function boxToReplace(
    tx: Prisma.TransactionClient,
    storeDomain: string,
    networkHash: string,
    now: Date,
): Promise<{ ok: false } | { ok: true; replace: string | null }> {
    const boxes = await tx.learnedCouponBox.findMany({
        where: { storeDomain },
        include: { reporters: { select: REPORTER_EVIDENCE_SELECT } },
    })
    if (boxes.length < LEARNED_BOX_RULES.maxBoxesPerDomain) {
        return { ok: true, replace: null }
    }

    const networksOf = boxes.map(box =>
        confirmingNetworksOf(box.reporters, now),
    )
    const boxesConfirmedBy = new Map<string, number>()
    for (const networks of networksOf) {
        for (const net of networks) {
            boxesConfirmedBy.set(net, (boxesConfirmedBy.get(net) ?? 0) + 1)
        }
    }
    const newcomerExclusive = boxesConfirmedBy.has(networkHash) ? 0 : 1

    const weakest = boxes
        .map((box, i) => {
            const networks = networksOf[i] ?? []
            return {
                box,
                servable: assessLearnedBox(box.reporters, now).servable,
                networks: networks.length,
                exclusive: networks.filter(
                    net => boxesConfirmedBy.get(net) === 1,
                ).length,
            }
        })
        .filter(candidate => !candidate.servable)
        .sort(
            (a, b) =>
                a.exclusive - b.exclusive ||
                a.networks - b.networks ||
                a.box.lastConfirmedAt.getTime() -
                    b.box.lastConfirmedAt.getTime(),
        )[0]
    // A box some network stands behind alone gives way only to a new box a
    // network stands behind alone. How many such networks it has does not
    // protect it further: otherwise 5 boxes backed by 2 such networks each
    // would hold the store's every slot for as long as they keep confirming.
    if (!weakest || Math.min(weakest.exclusive, 1) > newcomerExclusive) {
        return { ok: false }
    }
    return { ok: true, replace: weakest.box.id }
}

// ---------------------------------------------------------------------------
// Retention, store-wide (the per-store part runs inside every report).
// ---------------------------------------------------------------------------

/** How long the store-wide prune waits for one store's lock before it gives
 * that store up until the next run. */
const PRUNE_LOCK_TIMEOUT = '5s'

/** After this many stores in a row fail for a reason other than a held lock
 * (the database is likely down), the prune stops until its next run. */
const PRUNE_MAX_CONSECUTIVE_ERRORS = 3

export interface LearnedPruneResult {
    boxes: number
    reporters: number
    networkEvents: number
    /** Store rows left with no box (only a hand-run wipe leaves one). */
    stores: number
    /** Stores whose prune failed (logged, then skipped until the next run;
     * each report on the store also prunes it). */
    failedStores: number
    /** The run gave up after PRUNE_MAX_CONSECUTIVE_ERRORS failures in a
     * row. */
    stopped: boolean
}

/** Delete every box with no confirmation, and every reporter not seen, for
 * pruneAfterDays, every cross-store network event out of its window, and
 * every store row with no box left. Each store is pruned under its own lock,
 * like a report, so a delete never races a report adding a reporter to the
 * same box. A store that fails (its lock held past PRUNE_LOCK_TIMEOUT, or any
 * database error) is logged and skipped, and the others are still pruned;
 * after PRUNE_MAX_CONSECUTIVE_ERRORS failures in a row that are not a held
 * lock, the run stops. Failures reach Sentry ONCE per run, not once per
 * store. Returns what it deleted. */
export async function pruneLearnedCouponBoxes(
    now: Date = new Date(),
): Promise<LearnedPruneResult> {
    const cutoff = daysBefore(now, LEARNED_BOX_RULES.pruneAfterDays)
    const events = await prisma.learnedCouponBoxNetworkEvent.deleteMany({
        where: { createdAt: { lt: eventWindowStart(now) } },
    })
    const orphans = await prisma.$executeRaw`
        DELETE FROM "learned_coupon_box_stores" s
        WHERE NOT EXISTS (
            SELECT 1 FROM "learned_coupon_boxes" b
            WHERE b."store_domain" = s."store_domain"
        )`
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
    const total: LearnedPruneResult = {
        boxes: 0,
        reporters: 0,
        networkEvents: events.count,
        stores: orphans,
        failedStores: 0,
        stopped: false,
    }
    let inARow = 0
    let firstError: unknown = null
    for (const { storeDomain } of stores) {
        try {
            const deleted = await prisma.$transaction(
                async tx => {
                    await tx.$executeRawUnsafe(
                        `SET LOCAL lock_timeout = '${PRUNE_LOCK_TIMEOUT}'`,
                    )
                    await lockStore(tx, storeDomain)
                    return pruneStore(tx, storeDomain, cutoff)
                },
                { timeout: 15_000 },
            )
            total.boxes += deleted.boxes
            total.reporters += deleted.reporters
            inARow = 0
        } catch (error) {
            total.failedStores += 1
            firstError ??= error
            console.error(
                '[learned-coupon-box] retention prune failed for one store; continuing',
                error,
                { storeDomain },
            )
            // A held lock says nothing about the database; anything else,
            // several times running, says it is down.
            if (!isLockTimeout(error)) inARow += 1
            if (inARow >= PRUNE_MAX_CONSECUTIVE_ERRORS) {
                total.stopped = true
                console.error(
                    '[learned-coupon-box] retention prune stopped: too many stores failed in a row',
                    { failedStores: total.failedStores },
                )
                break
            }
        }
    }
    if (firstError) {
        Sentry.captureException(firstError, {
            tags: { area: 'learned_coupon_box', operation: 'prune_store' },
            extra: {
                failedStores: total.failedStores,
                stopped: total.stopped,
            },
        })
    }
    return total
}

const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000
let pruneTimer: ReturnType<typeof setInterval> | null = null

async function pruneAndReport(): Promise<void> {
    try {
        const deleted = await pruneLearnedCouponBoxes()
        if (
            deleted.boxes ||
            deleted.reporters ||
            deleted.networkEvents ||
            deleted.stores ||
            deleted.failedStores
        ) {
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
    | {
          created: false
          reason:
              | 'already'
              | 'daily_cap'
              | 'network_cap'
              | 'not_a_store'
              | 'busy'
      }

const HANDOVER_LOCK_KEY = 'learned-coupon-box:handover'

type HandoverRefusal = 'already' | 'daily_cap' | 'network_cap'

/** Why `domain` may not be handed over now, or null. */
async function handoverRefusal(
    db: Prisma.TransactionClient,
    domain: string,
    net: CrossStoreNetwork,
    now: Date,
): Promise<HandoverRefusal | null> {
    const existing = await db.learnedCouponBoxHandover.findUnique({
        where: { domain },
        select: { domain: true },
    })
    if (existing) return 'already'
    const today = await db.learnedCouponBoxHandover.count({
        where: { handedOverAt: { gte: daysBefore(now, 1) } },
    })
    warnNearCap('hand-overs today', today, LEARNED_BOX_RULES.handoverDailyCap)
    if (today >= LEARNED_BOX_RULES.handoverDailyCap) return 'daily_cap'
    const fromNetwork = await networkEventCounts(db, net, 'handover', now)
    if (
        fromNetwork.network >= LEARNED_BOX_RULES.handoversPerNetworkPerDay ||
        fromNetwork.block >= LEARNED_BOX_RULES.handoversPerBlockPerDay
    ) {
        return 'network_cap'
    }
    return null
}

/**
 * Hand a store (its registrable domain, reportStoreDomain: never one of its
 * hosts, so inventing hosts cannot hand one store over many times or spend
 * the daily cap) whose box a COUNTED report just found servable to the store
 * pipeline, as one site-suggestions row with no user and no requester email
 * (so nothing the pipeline later does to it can mail a shopper). At most ONCE
 * per store ever (learned_coupon_box_handovers is never pruned, and a wiped
 * box does not reopen it), and at most handoverDailyCap stores per rolling 24
 * hours overall, of which at most handoversPerNetworkPerDay may come from the
 * reports of one network and handoversPerBlockPerDay from its block
 * (`anyStoreNetwork`, the network of that counted report), so a few networks
 * cannot use up the day's hand-overs with made-up stores. A store refused by
 * a cap is handed over on a later counted servable report. Every refusal is
 * checked first WITHOUT the lock, so repeated reports on a store already
 * handed over or over a cap never touch it; the lock, which it never waits
 * for, then serialises the check and the writes (`busy` when taken, retried
 * on the next report).
 */
export async function handOverLearnedStore(
    domain: string,
    anyStoreNetwork: CrossStoreNetwork,
    now: Date = new Date(),
): Promise<HandoverResult> {
    const suggested = normalizeSuggestedDomain(domain)
    if (!suggested) return { created: false, reason: 'not_a_store' }
    const refused = await handoverRefusal(prisma, domain, anyStoreNetwork, now)
    if (refused) return { created: false, reason: refused }
    return prisma.$transaction(async (tx): Promise<HandoverResult> => {
        if (!(await tryLock(tx, HANDOVER_LOCK_KEY))) {
            return { created: false, reason: 'busy' }
        }
        // Read again under the lock: the reads above may have raced another.
        const again = await handoverRefusal(tx, domain, anyStoreNetwork, now)
        if (again) return { created: false, reason: again }
        await recordNetworkEvent(tx, anyStoreNetwork, 'handover', now)
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
