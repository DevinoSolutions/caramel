import { withRoute } from '@/lib/api/withRoute'
import { countCouponsForStores } from '@/lib/couponsRepo'
import prisma from '@/lib/prisma'
import { summarizeReports } from '@/lib/profile/reportImpact'
import { readSavingsSyncEnabled } from '@/lib/profile/savingsSyncPreference'
import { RECENT_EVENTS_LIMIT, type ProfileOverview } from '@/lib/profile/types'
import { NextResponse } from 'next/server'

// GET /api/account/overview — the ONE payload the account page reads.
//
// Four sections (savings, favorites, reports, the get-started checklist) are
// served by one request on purpose: four fetches would give the page four
// spinners and four independent failure modes, on a page whose whole job is to
// answer "what has Caramel done for me". The shape is declared once in
// src/lib/profile/types.ts and shared by the route, the hook and this route's
// test — never re-typed.
//
// Reads the three login-features tables (savings_events, favorite_stores,
// coupon_reports) DIRECTLY, so it has no dependency on the sibling PRs that
// own the write routes for those tables: it renders correct empty data today
// and correct populated data the moment they start writing.
//
// EVERY query is scoped by `userId: session.user.id`. There is no path through
// this handler that reads another account's rows.

export const GET = withRoute(
    {
        method: 'GET',
        routeName: 'account/overview',
        rateLimit: 'read',
        origin: true,
        auth: 'session',
    },
    async ({ session }) => {
        if (!session?.user) {
            // withRoute's `auth: 'session'` gate already 401s a missing
            // session; this guard covers the malformed-session edge and
            // narrows the type (same shape extension/me uses).
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }
        const userId = session.user.id

        const [
            user,
            savingsGroups,
            savingsBounds,
            recentEvents,
            favoriteRows,
            reportRows,
            syncEnabled,
        ] = await Promise.all([
            prisma.user.findUnique({
                where: { id: userId },
                select: { createdAt: true },
            }),
            // ONE groupBy carries three of the four savings figures: per-
            // currency totals, the distinct-store count, and the event count.
            // Grouping by (currency, store) rather than two separate groupBys
            // keeps them derived from the same snapshot — two queries could
            // disagree if an event landed between them.
            prisma.savingsEvent.groupBy({
                by: ['currency', 'store'],
                where: { userId },
                _sum: { amountCents: true },
                _count: { _all: true },
            }),
            prisma.savingsEvent.aggregate({
                where: { userId },
                _min: { occurredAt: true },
            }),
            prisma.savingsEvent.findMany({
                where: { userId },
                orderBy: { occurredAt: 'desc' },
                take: RECENT_EVENTS_LIMIT,
                select: {
                    store: true,
                    code: true,
                    amountCents: true,
                    currency: true,
                    occurredAt: true,
                },
            }),
            prisma.favoriteStore.findMany({
                where: { userId },
                orderBy: { createdAt: 'desc' },
                select: { storeName: true, createdAt: true },
            }),
            // Joined to the coupon's catalog state so summarizeReports can
            // tell a report our own later recheck AGREED with from one it
            // did not. See reportImpact.ts for why that join is required.
            prisma.couponReport.findMany({
                where: { userId },
                select: {
                    outcome: true,
                    createdAt: true,
                    coupon: {
                        select: {
                            status: true,
                            expired: true,
                            updatedAt: true,
                        },
                    },
                },
            }),
            readSavingsSyncEnabled(userId),
        ])

        // Per-currency totals. Deliberately NOT summed into one number: a
        // single figure that adds dollars to euros is a fabricated claim about
        // someone's money. Sorted desc so the page can render the largest
        // group as its hero and the rest as secondary lines.
        const totalsByCurrency = new Map<string, number>()
        const distinctStores = new Set<string>()
        let eventCount = 0
        for (const group of savingsGroups) {
            const current = totalsByCurrency.get(group.currency) ?? 0
            totalsByCurrency.set(
                group.currency,
                current + (group._sum.amountCents ?? 0),
            )
            distinctStores.add(group.store)
            eventCount += group._count._all
        }
        const totals = Array.from(
            totalsByCurrency,
            ([currency, minorUnits]) => ({
                currency,
                minorUnits,
            }),
        ).sort((a, b) => b.minorUnits - a.minorUnits)

        // Live "12 codes right now" counts, one query for the whole list,
        // sharing the catalog's own visibility + store-matching predicates
        // (couponsRepo) so a favorite's count agrees with the store page it
        // links to. A store absent from the map has NO count available —
        // distinct from a real 0 — and the UI renders no count line at all.
        const favoriteDomains = favoriteRows.map(row => row.storeName)
        const couponCounts = await countCouponsForStores(favoriteDomains)

        const reports = summarizeReports(reportRows)

        const overview: ProfileOverview = {
            memberSince: user?.createdAt.toISOString() ?? null,
            // Both signals originate in the extension, so either one proves it
            // is installed and working. This drives whether the page tells
            // someone to "star a store in the extension" — advice that is a
            // dead end for a user who has not installed it.
            hasExtensionActivity: eventCount > 0 || reports.reportCount > 0,
            savings: {
                syncEnabled,
                eventCount,
                storeCount: distinctStores.size,
                totals,
                firstEventAt:
                    savingsBounds._min.occurredAt?.toISOString() ?? null,
                recentEvents: recentEvents.map(event => ({
                    storeDomain: event.store,
                    // An automatic discount carries no code; the row renders a
                    // plain "automatic discount" instead of an empty chip.
                    code: event.code === '' ? null : event.code,
                    amountMinorUnits: event.amountCents,
                    currency: event.currency,
                    occurredAt: event.occurredAt.toISOString(),
                })),
            },
            favorites: favoriteRows.map(row => ({
                domain: row.storeName,
                starredAt: row.createdAt.toISOString(),
                couponCount: couponCounts.get(row.storeName) ?? null,
            })),
            reports,
        }

        return NextResponse.json(overview)
    },
)
