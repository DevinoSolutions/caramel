// reducedMotion — the ONE hydration-safe reader of prefers-reduced-motion for
// the server-rendered pages. Use this instead of framer-motion's
// `useReducedMotion` in anything that server-renders.
//
// Why: the preference is client-only knowledge. framer's own hook returns
// `null` during SSR and the real value on the very FIRST client render, so any
// prop branching on it diverges — and framer serializes `initial`/`animate`
// into the SSR'd `style` attribute (a divider's `initial={{ scaleX: 0 }}` ships
// as `style="transform:scaleX(0)"`), so the branch is a literal HTML mismatch.
// React then throws away the whole server tree and regenerates it, which drops
// in-flight interactions — that is what broke the nav-click e2e specs once the
// public pages started server-rendering.
//
// `useSyncExternalStore`'s third argument is exactly the primitive for this:
// React uses `getServerSnapshot` for BOTH the server render and the hydrating
// client render, then re-renders with the real value. It also fixes a bug in
// framer's hook, which snapshots once and never responds to a preference change
// (see its own TODO).
//
// Trade-off worth stating: framer reads `initial` only at mount, so a
// reduced-motion visitor still gets the non-reduced one-shot entrance offset.
// Every LOOPING animation — the perpetual motion that actually matters for
// vestibular safety — is still switched off, on the first effect tick.

import { useSyncExternalStore } from 'react'

const QUERY = '(prefers-reduced-motion: reduce)'

let query: MediaQueryList | null = null

// null where matchMedia does not exist — notably jsdom, which ships no
// implementation, so a component test rendering an animated section would
// otherwise die on `window.matchMedia is not a function`. No media query means
// no stated preference, i.e. the same answer the server gives.
function getQuery(): MediaQueryList | null {
    if (typeof window.matchMedia !== 'function') return null
    query ??= window.matchMedia(QUERY)
    return query
}

function subscribe(onStoreChange: () => void): () => void {
    const mq = getQuery()
    if (!mq) return () => {}
    mq.addEventListener('change', onStoreChange)
    return () => mq.removeEventListener('change', onStoreChange)
}

function getSnapshot(): boolean {
    return getQuery()?.matches ?? false
}

// The server cannot know the preference, so it renders — and the client
// hydrates with — the full-motion tree.
function getServerSnapshot(): boolean {
    return false
}

export function useReducedMotion(): boolean {
    return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
