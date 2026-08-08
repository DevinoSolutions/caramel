// heroStats — the three hero stats plus the count-up hook, shared by BOTH the
// 3D stat coupons (HeroTicketScene, rendered in WebGL on desktop) and the DOM
// stat-card fallback (HeroSection, shown on mobile / reduced-motion / no-WebGL)
// so the numbers, labels and animation stay in ONE place. No `three` import
// here — safe to pull into the main bundle via the DOM fallback.

import { useEffect, useState } from 'react'

export interface HeroStat {
    value: number
    suffix: string
    label: string
    format?: 'comma'
}

// Order matters: HeroTicketScene's SCATTER array is index-matched to this
// (entry 0 = the front/largest coupon); the DOM fallback renders them as a
// uniform row left→right in the same order.
export const HERO_STATS: HeroStat[] = [
    { value: 3000, suffix: '+', label: 'Supported Stores', format: 'comma' },
    { value: 100, suffix: '%', label: 'Open Source' },
    { value: 0, suffix: '%', label: 'Data Selling' },
]

// The digit run WITHOUT the suffix — the 3D stat coupons render the suffix as
// its own smaller <Text> node (typographic small-% treatment), so they need
// the two halves separately; the DOM fallback keeps the joined formatStat.
export function formatStatDigits(value: number, stat: HeroStat): string {
    const rounded = Math.round(value)
    return stat.format === 'comma'
        ? rounded.toLocaleString('en-US')
        : `${rounded}`
}

export function formatStat(value: number, stat: HeroStat): string {
    return `${formatStatDigits(value, stat)}${stat.suffix}`
}

// Count a value up from 0 to `target` with an easeOutCubic ramp once `start`
// flips true (first paint). reduced-motion shows the final value with no
// animation. rAF math runs only inside the effect, never during render.
//
// The state starts at `target`, not 0, in BOTH motion modes deliberately: the
// server can't know the visitor's motion preference, so seeding from `reduce`
// made the server render "0+" while a reduced-motion client's first render said
// "3,000+" — a hydration TEXT mismatch that made React regenerate the whole
// tree. Starting at `target` also means the server HTML ships the real stat
// values, which is what crawlers read. The ramp restarts from 0 inside the
// effect, i.e. strictly after hydration.
export function useCountUp(
    target: number,
    start: boolean,
    reduce: boolean,
): number {
    const [val, setVal] = useState(target)
    useEffect(() => {
        if (!start) return
        if (reduce) {
            setVal(target)
            return
        }
        setVal(0)
        let raf = 0
        const duration = 1200
        const t0 = performance.now()
        const tick = (now: number): void => {
            // Clamp BOTH ends. rAF hands the callback the timestamp of the
            // frame it belongs to, which can predate the performance.now() call
            // above when the effect lands mid-frame — an unclamped negative
            // progress runs easeOutCubic backwards and paints a negative stat
            // ("-126+") for a frame.
            const p = Math.min(1, Math.max(0, (now - t0) / duration))
            const eased = 1 - Math.pow(1 - p, 3)
            setVal(target * eased)
            if (p < 1) raf = requestAnimationFrame(tick)
            else setVal(target)
        }
        raf = requestAnimationFrame(tick)
        return () => cancelAnimationFrame(raf)
    }, [target, start, reduce])
    return val
}
