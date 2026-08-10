'use client'

import {
    navChipActiveClasses,
    navChipBarClasses,
    navChipClasses,
    navChipIdleClasses,
    navRailClasses,
    navRailItemActiveClasses,
    navRailItemClasses,
    navRailItemIdleClasses,
} from '@/lib/profile/profileStyles'
import { useReducedMotion } from '@/lib/reducedMotion'
import { useEffect, useState } from 'react'

// The answer to "where is the menu". Five-plus sections on one long scroll had
// no way to move between them and no sense of position.
//
// Two presentations of ONE list, chosen by breakpoint rather than duplicated:
// a fixed side rail on desktop, a scrollable horizontal chip row above the
// first card on small screens. Both drive the same scroll-spy state, so the
// active section is always shown in whichever presentation is visible.
// (Why fixed and not sticky: see the positioning note in profileStyles.ts —
// sticky is inert app-wide behind Layout.tsx's overflow-x-hidden.)
//
// Sections are passed in rather than hardcoded because the page's section set
// is DYNAMIC — "Your reports" renders only when the user has reports. A fixed
// menu would link to an anchor that isn't on the page.

export interface ProfileNavItem {
    id: string
    label: string
}

/**
 * Tracks which section is currently in view.
 *
 * Uses IntersectionObserver with a top-heavy rootMargin so a section counts as
 * "current" once its heading reaches the upper band of the viewport, rather
 * than only when it fills it — otherwise a short section (Reports is three
 * lines) could never win and the rail would skip it.
 */
function useScrollSpy(ids: string[]): string | null {
    const [activeId, setActiveId] = useState<string | null>(ids[0] ?? null)

    useEffect(() => {
        if (ids.length === 0) return
        const visible = new Map<string, number>()

        const observer = new IntersectionObserver(
            entries => {
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        visible.set(
                            entry.target.id,
                            entry.boundingClientRect.top,
                        )
                    } else {
                        visible.delete(entry.target.id)
                    }
                }
                if (visible.size === 0) return
                // Topmost intersecting section wins — matches what a reader
                // considers "the section I am in" when two are on screen.
                const [topmost] = Array.from(visible.entries()).sort(
                    (a, b) => a[1] - b[1],
                )
                if (topmost) setActiveId(topmost[0])
            },
            // Bottom margin pulls the detection band up so the LAST section can
            // still become active when the page bottoms out.
            { rootMargin: '-96px 0px -55% 0px', threshold: 0 },
        )

        const observed = ids
            .map(id => document.getElementById(id))
            .filter((el): el is HTMLElement => el !== null)
        observed.forEach(el => observer.observe(el))

        return () => observer.disconnect()
    }, [ids])

    return activeId
}

export default function ProfileNav({ items }: { items: ProfileNavItem[] }) {
    // Join the ids so the effect re-runs when the SET changes (a section
    // appearing after the first report lands), not on every parent render.
    const ids = items.map(item => item.id)
    const key = ids.join('|')
    const activeId = useScrollSpy(key ? key.split('|') : [])
    const prefersReducedMotion = useReducedMotion()

    function jumpTo(id: string) {
        const target = document.getElementById(id)
        if (!target) return
        target.scrollIntoView({
            behavior: prefersReducedMotion ? 'auto' : 'smooth',
            block: 'start',
        })
        // Move keyboard focus with the viewport, or a keyboard user's next Tab
        // continues from wherever they were before the jump.
        target.setAttribute('tabindex', '-1')
        target.focus({ preventScroll: true })
    }

    if (items.length === 0) return null

    return (
        <>
            {/* Desktop rail. `lg:hidden` = hidden at <=1023px (MAX-width
                screens), so this is the large-screen presentation. The <nav>
                stays a grid item — it is what reserves the column the fixed
                rail is aligned to, and `display: none` below lg takes the
                fixed child out with it. */}
            <nav aria-label="Account sections" className="lg:hidden">
                <div className={navRailClasses}>
                    {items.map(item => {
                        const active = item.id === activeId
                        return (
                            <button
                                key={item.id}
                                type="button"
                                onClick={() => jumpTo(item.id)}
                                aria-current={active ? 'true' : undefined}
                                className={`${navRailItemClasses} ${
                                    active
                                        ? navRailItemActiveClasses
                                        : navRailItemIdleClasses
                                }`}
                            >
                                {item.label}
                            </button>
                        )
                    })}
                </div>
            </nav>

            {/* Small-screen chip row. `hidden lg:block` = shown only at
                <=1023px. */}
            <nav aria-label="Account sections" className={navChipBarClasses}>
                <div className="flex gap-2">
                    {items.map(item => {
                        const active = item.id === activeId
                        return (
                            <button
                                key={item.id}
                                type="button"
                                onClick={() => jumpTo(item.id)}
                                aria-current={active ? 'true' : undefined}
                                className={`${navChipClasses} ${
                                    active
                                        ? navChipActiveClasses
                                        : navChipIdleClasses
                                }`}
                            >
                                {item.label}
                            </button>
                        )
                    })}
                </div>
            </nav>
        </>
    )
}
