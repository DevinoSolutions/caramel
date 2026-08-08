'use client'

// HeroTicketScene — the compact WebGL half of the split hero (right column,
// desktop/lg+ only). Same ticket visual language as the shared ./couponTicket3d
// geometry + palette, deliberately LIGHT: THREE large 3D stat coupons (real
// ticket meshes) scattered around the canvas center at varied depths — an
// art-directed "random soft floating" composition, not a row. The big main
// "%" coupon from earlier iterations is GONE (owner call 2026-07-29: "just
// keep the 3 stats… remove the % big one"); the three stat tickets ARE the
// scene now, recomposed to read centered and balanced on their own. Each
// coupon drifts/bobs/sways on its own frequency + phase (never in sync), and
// reacts to the pointer: the coupon nearest the cursor gently lifts toward
// the camera, tilts toward the pointer and pops ~4% — all damped, no
// snapping. Numbers count up as IN-CANVAS 3D text so the type moves with the
// ticket like print. The coupons don't pop in: each plays a staggered soft
// entrance (drop + scale + small-overshoot ease, see the entrance block above
// SCATTER) choreographed with the parent's poster cross-fade so the reveal
// reads as one continuous materialization. The whole choreography — poster
// fade AND entrance clock AND count-up — keys off RevealGate's
// first-PRESENTED-frame signal (every troika text synced + one full frame
// rendered), NOT off GL context creation: the 2026-07-30 frame captures
// proved onCreated fires seconds before the suspended scene (font fetch, env
// bake, first-render shader compile, async SDF glyph generation) can present
// anything, which faded the poster into a blank box and let the entrance
// play unseen — the literal "they appear suddenly" complaint. A handful of
// instanced droplets, low-count Sparkles, and a one-frame Lightformer
// environment complete the scene. No ContactShadows
// and no scroll dolly — the hero doesn't scroll-drive. Loaded via
// next/dynamic ssr:false and only mounted after the browser is idle + a real
// WebGL context + a lg+ viewport (HeroSection gates all of that), so the
// `three` chunk never touches phones or first paint. Until (or instead of)
// the canvas, HeroSection renders the SSR'd DOM twin of this exact
// composition (HeroCouponPoster) and cross-fades it out on onReady.
//
// Perf posture (brief "not heavy"): DPR clamped [1, 1.5]; frameloop gated by
// the `active` prop (parent IntersectionObserver → 'never' when the hero is
// scrolled out of view); the three stat coupons SHARE one memoized geometry;
// droplets are ONE instanced mesh (≤10); the environment ships no network
// fetch; the stat type is SDF text (drei <Text>) on a SELF-HOSTED font,
// count-up runs only ~1.2s from the reveal. The per-coupon pointer reaction adds
// one Vector3 project per stat coupon per frame (3 total) — negligible.

import { formatStatDigits, HERO_STATS, useCountUp } from '@/lib/heroStats'
import { Environment, Lightformer, Sparkles, Text } from '@react-three/drei'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useCallback, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import {
    CARAMEL,
    CARAMEL_DEEP,
    CARAMEL_LIGHT,
    makeTicketGeometry,
    Perforation,
} from './couponTicket3d'

// The stat coupon ticket — ONE shared geometry for all three; per-coupon size
// variety comes from SCATTER[i].scale, not from separate geometries.
// Front-face Z (post-center) is depth/2 + bevel.
const STAT = {
    w: 2.5,
    h: 1.6,
    cr: 0.2,
    nr: 0.18,
    ny: 0,
    depth: 0.32,
    bevel: 0.05,
}
const STAT_FRONT = STAT.depth / 2 + STAT.bevel

// Art-directed scatter: one spot per HERO_STATS entry (index-matched). With
// the main "%" coupon removed (2026-07-29) the three tickets were recomposed
// to CENTER the constellation in the canvas: the scale-weighted centroid of
// the anchors is ≈ (0.00, 0.00), and no two anchor pairs are collinear with
// the third (no straight line through the scatter). Varied x/y/z, individual
// base rotations and per-coupon float parameters keep it reading as coupons
// drifting in space:
//   [0] "3,000+ Supported Stores" — bottom-left, nearest the camera and the
//       largest (the headline stat). Its top-right corner deliberately fans
//       OVER the deeper [2] ticket's blank bottom-left corner — a coupon-
//       stack moment, kept clear of [2]'s type (see the occlusion contract
//       below).
//   [1] "100% Open Source" — top, slightly LEFT of center (owner call
//       2026-07-29: "make the open source slight to left so it's on
//       center") — this is the coupon that re-centers the composition after
//       living at the far top-right in the four-ticket layout.
//   [2] "0% Data Selling" — mid-right and the DEEPEST ticket, so the three
//       tickets cascade top → mid-right → bottom-left with depth spread
//       front→back (0.45 / 0.05 / −0.5).
//
// OCCLUSION CONTRACT (checked whenever an anchor/scale/rotation moves): a
// nearer coupon's body may only ever cover a deeper coupon's BLANK corner
// face, never its type, including at float/hover extremes.
//   [0] over [2]: [0]'s right-edge worst reach ≈ x −0.9 + 1.30 (rotZ-rotated
//       half-extent) + 0.07 drift ≈ 0.47; [2]'s label ("DATA SELLING", ≈1.19
//       wide at scale 0.86) starts at ≈ 1.32 − 0.60 − 0.08 drift = 0.64 —
//       ≥0.17 clear. The fan overlap covers only [2]'s empty corner.
//   [1] over [2]: [1]'s right corner reaches x ≈ −0.25 + 1.10 + 0.06 drift +
//       0.05 pop ≈ 0.96; [2]'s "0%" digits start at ≈ 1.32 − 0.26 = 1.06 —
//       clear in x alone, so [1]'s bob can never dip onto [2]'s value.
// Frequencies/phases are mutually irrational-ish so no two coupons ever sync.
interface ScatterSpot {
    position: [number, number, number]
    scale: number
    rotZ: number
    rotY: number
    bobAmp: number
    bobFreq: number
    driftAmp: number
    swayFreq: number
    phase: number
    // Entrance stagger (seconds after the scene's first presented frame).
    // Order is deliberate: stores (0) → data selling (0.15) → open source
    // (0.30) — front-to-back-to-top, matching POSTER_FADE_DELAYS_S in
    // HeroSection so the poster ticket that fades out first is the 3D ticket
    // that materializes first.
    enterDelay: number
}
const SCATTER: ScatterSpot[] = [
    {
        position: [-0.9, -1.25, 0.45],
        scale: 1,
        rotZ: 0.07,
        rotY: 0.16,
        bobAmp: 0.14,
        bobFreq: 0.55,
        driftAmp: 0.07,
        swayFreq: 0.5,
        phase: 0,
        enterDelay: 0,
    },
    {
        position: [-0.25, 1.45, 0.05],
        scale: 0.92,
        rotZ: -0.07,
        rotY: -0.12,
        bobAmp: 0.1,
        bobFreq: 0.72,
        driftAmp: 0.06,
        swayFreq: 0.62,
        phase: 2.1,
        enterDelay: 0.3,
    },
    {
        position: [1.32, -0.1, -0.5],
        scale: 0.86,
        rotZ: 0.1,
        rotY: -0.16,
        bobAmp: 0.16,
        bobFreq: 0.45,
        driftAmp: 0.08,
        swayFreq: 0.55,
        phase: 4.2,
        enterDelay: 0.15,
    },
]

// --- Entrance choreography (2026-07-30, owner: "when they appear suddenly —
// not good") -----------------------------------------------------------------
// Each coupon materializes instead of popping: it starts ENTER_DROP world
// units below its float path at ENTER_SCALE of its rest size, and eases up/out
// over ENTER_DURATION_S with a small-overshoot back-ease (ENTER_BACK_C1 0.5 →
// ~2.5% overshoot — a damped-spring feel, never a bounce). The offset/scale
// are applied ON TOP of the always-running ambient float and the ease ends
// with zero slope, so the handoff into the idle float has no velocity
// discontinuity — the coupon simply IS floating by the time the offset
// reaches zero. Staggered per coupon via SCATTER[i].enterDelay; the shared
// clock origin (RevealState.t0) is stamped by RevealGate at the scene's
// first PRESENTED frame — all troika texts synced + one full frame rendered
// — never at mount or context creation, so slow font/SDF/shader warm-up can
// never let the choreography play into a blank or textless canvas
// (first-frame law: until t0 exists every coupon HOLDS the dropped start
// pose, and no coupon ever shows at full rest before its entrance has
// played). Pointer influence (lift/tilt/pop) is gated by the entrance ease
// so a hover can't yank a coupon that is still materializing. Opacity is NOT
// animated: transmission glass + troika SDF text make per-material fades
// z-sorting-artifact bait — the parent's poster cross-fade covers the blend
// instead (HeroSection fades the canvas in over the fading poster).
// Clip math: the worst transient extent (spot [0] at full drop:
// (1.25 + 0.55 + 0.14 + ext.y 1.19) · persp 1.12 ≈ 3.49 vs SCENE_BOUNDS
// halfH 2.88) exceeds rest bounds by ~21%, which at the W-bound fit (~0.67)
// stays ≈ 40px inside the bled raster edge — the drop lands in the canvas
// bleed, never at the crop.
const ENTER_DROP = 0.55
const ENTER_SCALE = 0.92
const ENTER_DURATION_S = 0.7
const ENTER_BACK_C1 = 0.5

// easeOutBack with a tame overshoot constant (~2.5% at c1 = 0.5); slope is 0
// at p = 1, which is what makes the float handoff seamless.
function easeOutBackSoft(p: number): number {
    const c1 = ENTER_BACK_C1
    const c3 = c1 + 1
    const q = p - 1
    return 1 + c3 * q * q * q + c1 * q * q
}

// --- Reveal gate -------------------------------------------------------------
// Shared MUTABLE state, read/written inside useFrame only (never a React
// state — per-frame writes must not render): readyNodes collects the troika
// Text nodes that completed their first glyph sync; t0 is the choreography
// clock origin, stamped by RevealGate once every text node is synced AND one
// further full frame has been rendered (glyphs provably on screen).
interface RevealState {
    t0: number | null
    readyNodes: Set<string>
}
// 3 troika nodes per coupon: value digits + value suffix + label.
const REVEAL_TEXT_NODE_COUNT = HERO_STATS.length * 3

// Sits INSIDE the scene tree, so it commits (and starts ticking) only when
// React commits the resolved scene — after drei's suspenseful loaders (font
// fetch, Environment) settle. From there it waits for troika's ASYNC SDF
// glyph generation (not suspense-tracked — meshes commit and render EMPTY
// until their first sync; the 2026-07-30 capture caught bare tickets without
// type) plus one more rendered frame (the first gl.render pays the shader
// compile for the transmission materials), then stamps reveal.t0 and tells
// the parent — which is what actually starts the poster cross-fade, the
// entrances and the count-up.
function RevealGate({
    reveal,
    onRevealed,
}: {
    reveal: RevealState
    onRevealed: () => void
}): null {
    const framesAfterTextRef = useRef(0)
    useFrame(state => {
        if (reveal.t0 !== null) return
        if (reveal.readyNodes.size < REVEAL_TEXT_NODE_COUNT) return
        framesAfterTextRef.current += 1
        if (framesAfterTextRef.current < 2) return
        reveal.t0 = state.clock.elapsedTime
        onRevealed()
    })
    return null
}

// Pointer-reaction envelope (per stat coupon): proximity is a gaussian of the
// NDC distance between the pointer and the coupon's projected rest anchor
// (sigma² = PROX_SIGMA_SQ, ~0.63 NDC sigma — reaction peaks while hovering the
// coupon, fades smoothly by ~1 NDC). The nearest coupon lifts toward the
// camera (≤ LIFT_MAX), tilts toward the cursor (the d·e^(−d²/σ²) product
// self-caps at ~0.15 rad) and pops ≤ (POP_MAX−1). All damped — no snapping.
const PROX_SIGMA_SQ = 0.4
const LIFT_MAX = 0.3
const POP_MAX = 1.045

// --- Scene bounds (drive the fit-to-layout-box scale) ----------------------
// Computed FROM the scatter config so moving/resizing a coupon can never
// silently break the clip math. For every ticket the half-extent includes:
// worst-case in-plane tilt (base rotZ + sway + parallax ≤ TILT_ALLOWANCE, via
// the rotated-rect formula), bevel, pointer pop, ambient drift/bob amplitude —
// then the whole extent is scaled by the perspective factor at the ticket's
// CLOSEST approach to the camera (rest z + LIFT_MAX), because the camera
// projects near geometry wider than the z=0 plane the fit math reasons in.
// Pointer-parallax swing of the whole scatter group spills past these rest
// bounds by a few % — that lands in the canvas bleed below, never at the
// raster edge.
const CAM_DIST = 7
const TILT_ALLOWANCE = 0.25

function tiltedHalfExtents(
    halfW: number,
    halfH: number,
    bevel: number,
    scale: number,
): { x: number; y: number } {
    const c = Math.cos(TILT_ALLOWANCE)
    const s = Math.sin(TILT_ALLOWANCE)
    return {
        x: (halfW * c + halfH * s + bevel) * scale,
        y: (halfH * c + halfW * s + bevel) * scale,
    }
}

function perspectiveFactor(closestZ: number): number {
    return CAM_DIST / (CAM_DIST - closestZ)
}

const SCENE_BOUNDS = ((): { halfW: number; halfH: number } => {
    let halfW = 0
    let halfH = 0
    for (const spot of SCATTER) {
        const ext = tiltedHalfExtents(
            STAT.w / 2,
            STAT.h / 2,
            STAT.bevel,
            spot.scale * POP_MAX,
        )
        const persp = perspectiveFactor(spot.position[2] + LIFT_MAX)
        halfW = Math.max(
            halfW,
            (Math.abs(spot.position[0]) + spot.driftAmp + ext.x) * persp,
        )
        halfH = Math.max(
            halfH,
            (Math.abs(spot.position[1]) + spot.bobAmp + ext.y) * persp,
        )
    }
    return { halfW, halfH }
})()

// The DOM shell (HeroSection) bleeds the canvas raster past the reserved
// layout box by these px per side (the -inset-x-[48px] -inset-y-[40px]
// wrapper — keep the two in sync) so tilted coupons and drifting droplets
// never get guillotined at the raster edge. The fit math subtracts the bleed,
// so the composition still sizes itself to the LAYOUT box: the bleed is pure
// clip headroom, not extra content room.
const CANVAS_BLEED_X_PX = 48
const CANVAS_BLEED_Y_PX = 40

// A small drifting caramel field — one instanced mesh, ≤10 spheres.
const DROPLET_COUNT = 10

interface DropletDatum {
    origin: THREE.Vector3
    speed: number
    phase: number
    scale: number
    drift: number
}

// Randomized droplet layout is computed ONCE at module load (client-only — the
// scene is dynamically imported ssr:false, single instance), never during
// render, so Math.random() stays out of the render phase (react-hooks/purity)
// and the field is stable across re-renders. The y-spread is capped at 5
// because the field lives inside the fit-scaled group: worst case |y| = 2.5
// origin + 0.9 drift + 0.17 radius = 3.57, times the largest realistic fit
// (~0.70) = 2.50 world — safely inside the frustum half-height (2.687), so a
// floating sphere never gets sliced at the top or bottom raster edge.
const DROPLET_DATA: DropletDatum[] = Array.from(
    { length: DROPLET_COUNT },
    () => ({
        // z ∈ [−3.2, −1.2]: strictly BEHIND every coupon (deepest stat rests
        // at −0.5; its type sits nearer still), so a drifting droplet can
        // never occlude a stat glyph — iteration-1 screenshots caught one
        // parked on the "100%" in dark mode.
        origin: new THREE.Vector3(
            (Math.random() - 0.5) * 7,
            (Math.random() - 0.5) * 5,
            -1.2 - Math.random() * 2,
        ),
        speed: 0.2 + Math.random() * 0.5,
        phase: Math.random() * Math.PI * 2,
        scale: 0.05 + Math.random() * 0.12,
        drift: 0.3 + Math.random() * 0.6,
    }),
)

export interface HeroTicketSceneProps {
    // Drives frameloop: while false the canvas is fully paused (never renders).
    active: boolean
    // Theme-tuned lighting/material tones — kept in parity with the page.
    isDark: boolean
    // Fires once the GL context is created so the parent can cross-fade the
    // poster out from under the canvas.
    onReady?: () => void
}

// Shared caramel-glass material for every ticket so they read as one family.
// Slightly tuned per theme.
function TicketMaterial({ isDark }: { isDark: boolean }): React.JSX.Element {
    return (
        <meshPhysicalMaterial
            color={isDark ? CARAMEL_DEEP : CARAMEL}
            metalness={0.2}
            roughness={0.1}
            clearcoat={1}
            clearcoatRoughness={0.06}
            transmission={0.28}
            thickness={1.4}
            ior={1.45}
            sheen={0.6}
            sheenColor={CARAMEL_LIGHT}
            sheenRoughness={0.4}
            iridescence={0.18}
            iridescenceIOR={1.3}
            emissive={CARAMEL}
            emissiveIntensity={isDark ? 0.3 : 0.12}
            attenuationColor={CARAMEL_LIGHT}
            attenuationDistance={2.2}
        />
    )
}

// Self-hosted bold font for the in-canvas stat text (troika needs ttf/otf/woff
// — NOT woff2, and its default font is a CDN fetch we deliberately avoid).
// Only requested when the scene mounts (desktop + idle), never on first paint.
const STAT_FONT = '/fonts/Poppins-Bold.ttf'

// --- Stat type treatment (2026-07-29 outline-free rework) -------------------
// The espresso OUTLINE from the previous pass is gone (owner: "the black
// border in text is ugly"). Contrast now lives at the color level: espresso
// print-ink type (STAT_INK) directly on the caramel face — printed-ticket
// look, immune to the clearcoat highlight sweeps that washed out the earlier
// plain-white type (the reason the outline existed). The screenshot bake-off
// against the other direction (white type on a matte face) picked the ink:
// white needed a SECOND, flatter material that broke the one-glass-family
// look and still read softer on the bright light-theme face. No outlines, no
// halos, no blur. sdfGlyphSize 128 (troika default 64) stays — the "%"
// counters and thin diagonal go lumpy at 64.
//
// The value renders as TWO <Text> nodes — full-size digits + a smaller suffix
// ("%"/"+") at SUFFIX_RATIO, raised so its cap top roughly aligns with the
// digits' cap top (superscript-style, deliberate typography). Troika only
// does one size per run, hence the split.
const STAT_INK = '#4a1c05'
const VALUE_FONT_SIZE = 0.54
const SUFFIX_RATIO = 0.6
const SUFFIX_GAP = 0.025
// anchorY is 'middle' on both runs; raising the smaller suffix by half the
// size delta times Poppins' ~0.72 cap/block ratio top-aligns the caps.
const SUFFIX_RAISE = ((VALUE_FONT_SIZE * (1 - SUFFIX_RATIO)) / 2) * 0.72
const VALUE_Y = 0.2
const LABEL_FONT_SIZE = 0.17
const LABEL_Y = -0.33

// drei's <Text> ref exposes the troika Text mesh; we only need its measured
// block bounds after each sync (typed minimally — troika ships no types).
interface MeasuredText extends THREE.Mesh {
    textRenderInfo?: { blockBounds: [number, number, number, number] } | null
}

// Digits + smaller suffix, centered AS A PAIR from LIVE troika measurements.
// The value counts up from 0, so the digit run's width changes every frame
// ("0" → "3,000") — hard-coded offsets would only fit the final number.
// onSync fires after every glyph-layout pass; re-centering there keeps the
// pair balanced mid-count-up AND at rest.
function StatValueText({
    digits,
    suffix,
    statKey,
    reveal,
}: {
    digits: string
    suffix: string
    // Unique per coupon — namespaces this pair's reveal-gate node keys.
    statKey: string
    reveal: RevealState
}): React.JSX.Element {
    const digitsRef = useRef<MeasuredText>(null)
    const suffixRef = useRef<MeasuredText>(null)
    const layout = useCallback(() => {
        const d = digitsRef.current
        const s = suffixRef.current
        const db = d?.textRenderInfo?.blockBounds
        const sb = s?.textRenderInfo?.blockBounds
        if (!d || !s || !db || !sb) return
        const digitsWidth = db[2] - db[0]
        const suffixWidth = sb[2] - sb[0]
        const total = digitsWidth + SUFFIX_GAP + suffixWidth
        d.position.x = -total / 2
        s.position.x = -total / 2 + digitsWidth + SUFFIX_GAP
        s.position.y = SUFFIX_RAISE
    }, [])
    // onSync fires on EVERY glyph-layout pass; the Set makes the reveal-gate
    // registration first-sync-only for free.
    const digitsSynced = useCallback(() => {
        reveal.readyNodes.add(`${statKey}:digits`)
        layout()
    }, [reveal, statKey, layout])
    const suffixSynced = useCallback(() => {
        reveal.readyNodes.add(`${statKey}:suffix`)
        layout()
    }, [reveal, statKey, layout])
    return (
        <group position={[0, VALUE_Y, STAT_FRONT + 0.03]}>
            <Text
                ref={digitsRef}
                font={STAT_FONT}
                fontSize={VALUE_FONT_SIZE}
                anchorX="left"
                anchorY="middle"
                color={STAT_INK}
                sdfGlyphSize={128}
                onSync={digitsSynced}
            >
                {digits}
            </Text>
            <Text
                ref={suffixRef}
                font={STAT_FONT}
                fontSize={VALUE_FONT_SIZE * SUFFIX_RATIO}
                anchorX="left"
                anchorY="middle"
                color={STAT_INK}
                sdfGlyphSize={128}
                onSync={suffixSynced}
            >
                {suffix}
            </Text>
        </group>
    )
}

// One 3D stat coupon: a real caramel-glass ticket mesh (shared geometry) with
// the number/label as IN-CANVAS 3D text (drei <Text>, SDF) sitting on the
// coupon face — it inherits every float/tilt transform, so the type moves
// with the ticket like print, instead of hovering as a flat DOM billboard.
// The number counts up from 0 on mount.
//
// Motion = two nested groups:
//   anchor (outer) — ambient drift/bob position (set directly each frame from
//     smooth periodic functions) + damped pointer lift (z) + damped scale pop.
//   tilt (inner)   — damped rotations: base pose + slow sway + tilt-toward-
//     cursor. Split so position writes never fight rotation damping.
function StatCoupon3D({
    geometry,
    spot,
    stat,
    isDark,
    reveal,
    countStart,
}: {
    geometry: THREE.ExtrudeGeometry
    spot: ScatterSpot
    stat: (typeof HERO_STATS)[number]
    isDark: boolean
    reveal: RevealState
    // Flips true at the reveal (RevealGate → parent state), so the count-up
    // runs WHILE the coupon materializes instead of finishing invisibly
    // during font/shader warm-up.
    countStart: boolean
}): React.JSX.Element {
    // The scene only ever mounts when motion is allowed (HeroSection gates
    // it) — reduce is always false here; start is the reveal signal.
    const n = useCountUp(stat.value, countStart, false)
    const digits = formatStatDigits(n, stat)
    const anchorRef = useRef<THREE.Group>(null)
    const tiltRef = useRef<THREE.Group>(null)
    const scratch = useMemo(() => new THREE.Vector3(), [])
    const labelSynced = useCallback(() => {
        reveal.readyNodes.add(`${stat.label}:label`)
    }, [reveal, stat.label])

    useFrame((state, delta) => {
        const anchor = anchorRef.current
        const tilt = tiltRef.current
        if (!anchor || !tilt || !anchor.parent) return
        const t = state.clock.elapsedTime

        // Entrance progress for THIS coupon: 0 (held at the dropped start
        // pose) until RevealGate stamps the shared clock origin, then 0→1
        // over ENTER_DURATION_S after this coupon's stagger. enter == eased
        // progress, used to blend the drop offset/scale away and to gate the
        // pointer reaction in.
        const p =
            reveal.t0 === null
                ? 0
                : THREE.MathUtils.clamp(
                      (t - reveal.t0 - spot.enterDelay) / ENTER_DURATION_S,
                      0,
                      1,
                  )
        const enter = p === 0 ? 0 : easeOutBackSoft(p)

        // Ambient float: independent frequencies + phase offsets per coupon.
        // The entrance drop rides ON TOP of the live float value, so when the
        // offset hits zero (with zero slope) the coupon is already mid-float —
        // no velocity discontinuity at the handoff.
        anchor.position.x =
            spot.position[0] +
            Math.cos(t * spot.bobFreq * 0.63 + spot.phase * 1.7) * spot.driftAmp
        anchor.position.y =
            spot.position[1] +
            Math.sin(t * spot.bobFreq + spot.phase) * spot.bobAmp -
            ENTER_DROP * (1 - enter)

        // Pointer proximity, measured in NDC against the coupon's projected
        // REST anchor (parent world matrix = fit scale + scatter parallax).
        // Gated by the entrance ease so a hover can't yank a coupon that is
        // still materializing.
        scratch
            .set(spot.position[0], spot.position[1], spot.position[2])
            .applyMatrix4(anchor.parent.matrixWorld)
            .project(state.camera)
        const dx = THREE.MathUtils.clamp(state.pointer.x - scratch.x, -0.8, 0.8)
        const dy = THREE.MathUtils.clamp(state.pointer.y - scratch.y, -0.8, 0.8)
        const influence =
            Math.exp(-(dx * dx + dy * dy) / PROX_SIGMA_SQ) * Math.min(enter, 1)

        // Lift toward the camera + gentle scale pop under the cursor.
        anchor.position.z = THREE.MathUtils.damp(
            anchor.position.z,
            spot.position[2] + LIFT_MAX * influence,
            3.5,
            delta,
        )
        // Scale = entrance growth (ENTER_SCALE → 1, set DIRECTLY while the
        // entrance plays so the choreography isn't smeared by damping) times
        // the damped hover pop once at rest. The two agree exactly at p = 1
        // (growth factor 1), so the switch is seamless.
        const enterScale =
            spot.scale * (ENTER_SCALE + (1 - ENTER_SCALE) * enter)
        if (p < 1) {
            anchor.scale.setScalar(enterScale)
        } else {
            const pop = THREE.MathUtils.damp(
                anchor.scale.x,
                spot.scale * (1 + (POP_MAX - 1) * influence),
                3.5,
                delta,
            )
            anchor.scale.setScalar(pop)
        }

        // Base pose + slow sway + tilt toward the cursor (the d·gaussian
        // product self-caps at ~0.15 rad — tasteful, never a snap).
        tilt.rotation.y = THREE.MathUtils.damp(
            tilt.rotation.y,
            spot.rotY +
                Math.sin(t * spot.swayFreq + spot.phase) * 0.06 +
                dx * 0.55 * influence,
            3.5,
            delta,
        )
        tilt.rotation.x = THREE.MathUtils.damp(
            tilt.rotation.x,
            Math.sin(t * spot.swayFreq * 0.8 + spot.phase * 2.3) * 0.045 -
                dy * 0.4 * influence,
            3.5,
            delta,
        )
        tilt.rotation.z = THREE.MathUtils.damp(
            tilt.rotation.z,
            spot.rotZ +
                Math.sin(t * spot.swayFreq * 0.7 + spot.phase * 0.9) * 0.035,
            3.5,
            delta,
        )
    })

    return (
        // Initial JSX pose = the entrance START pose (dropped + small), so
        // even a frame presented before the first useFrame tick could never
        // flash the coupon at full rest (first-frame law).
        <group
            ref={anchorRef}
            position={[
                spot.position[0],
                spot.position[1] - ENTER_DROP,
                spot.position[2],
            ]}
            scale={spot.scale * ENTER_SCALE}
        >
            <group ref={tiltRef} rotation={[0, spot.rotY, spot.rotZ]}>
                <mesh geometry={geometry} castShadow receiveShadow>
                    <TicketMaterial isDark={isDark} />
                </mesh>
                <Perforation
                    width={STAT.w - STAT.nr * 2 - 0.08}
                    y={STAT.ny}
                    z={STAT_FRONT + 0.015}
                    count={11}
                    dash={0.065}
                    color={isDark ? CARAMEL_LIGHT : '#fff2e6'}
                />
                {/* Print-ink type, lifted 0.03 off the face so the sheen
                    never kisses the glyph edges — see the treatment block
                    comment above StatValueText. */}
                <StatValueText
                    digits={digits}
                    suffix={stat.suffix}
                    statKey={stat.label}
                    reveal={reveal}
                />
                {/* Label fit math (longest label = "SUPPORTED STORES", 16
                    glyphs): Poppins-Bold uppercase averages ~0.62em advance,
                    so width ≈ 16 × 0.17 × (0.62 + 0.06 letterSpacing) ≈ 1.85
                    — inside the usable face width of STAT.w 2.5 − 2 × notch r
                    0.18 = 2.14, with ~0.145 margin per side (tilt only rotates
                    the ticket, the type rides it like print). */}
                <Text
                    font={STAT_FONT}
                    fontSize={LABEL_FONT_SIZE}
                    letterSpacing={0.06}
                    position={[0, LABEL_Y, STAT_FRONT + 0.03]}
                    anchorX="center"
                    anchorY="middle"
                    color={STAT_INK}
                    sdfGlyphSize={128}
                    onSync={labelSynced}
                >
                    {stat.label.toUpperCase()}
                </Text>
            </group>
        </group>
    )
}

function StatCoupons({
    isDark,
    reveal,
    countStart,
}: {
    isDark: boolean
    reveal: RevealState
    countStart: boolean
}): React.JSX.Element {
    const fieldRef = useRef<THREE.Group>(null)
    // ONE geometry shared by all three coupons (same shape; per-coupon size
    // comes from SCATTER[i].scale on the anchor group).
    const geometry = useMemo(
        () =>
            makeTicketGeometry(
                STAT.w,
                STAT.h,
                STAT.cr,
                STAT.nr,
                STAT.ny,
                STAT.depth,
                STAT.bevel,
            ),
        [],
    )

    // Mild whole-field pointer parallax so the scatter answers the mouse as
    // one drifting constellation; the per-coupon proximity reaction in
    // StatCoupon3D layers on top of this.
    useFrame((state, delta) => {
        const field = fieldRef.current
        if (!field) return
        const { x: px, y: py } = state.pointer
        field.rotation.y = THREE.MathUtils.damp(
            field.rotation.y,
            px * 0.14,
            4,
            delta,
        )
        field.rotation.x = THREE.MathUtils.damp(
            field.rotation.x,
            -py * 0.1,
            4,
            delta,
        )
    })

    return (
        <group ref={fieldRef}>
            {HERO_STATS.map((stat, i) => (
                <StatCoupon3D
                    key={stat.label}
                    geometry={geometry}
                    spot={SCATTER[i]}
                    stat={stat}
                    isDark={isDark}
                    reveal={reveal}
                    countStart={countStart}
                />
            ))}
        </group>
    )
}

function Droplets({ isDark }: { isDark: boolean }): React.JSX.Element {
    const meshRef = useRef<THREE.InstancedMesh>(null)
    const dummy = useMemo(() => new THREE.Object3D(), [])
    const data = DROPLET_DATA
    const geometry = useMemo(() => new THREE.SphereGeometry(1, 14, 14), [])
    // Deeper caramel grade (dark color + short attenuation distance + modest
    // transmission) so the drops read as thick caramel, not clear bubbles.
    const material = useMemo(
        () =>
            new THREE.MeshPhysicalMaterial({
                color: new THREE.Color(CARAMEL),
                metalness: 0.1,
                roughness: 0.15,
                clearcoat: 1,
                clearcoatRoughness: 0.1,
                transmission: 0.35,
                thickness: 0.9,
                ior: 1.4,
                attenuationColor: new THREE.Color(CARAMEL_DEEP),
                attenuationDistance: 0.6,
                emissive: new THREE.Color(CARAMEL),
                emissiveIntensity: isDark ? 0.35 : 0.15,
            }),
        [isDark],
    )

    useFrame(state => {
        const mesh = meshRef.current
        if (!mesh) return
        const t = state.clock.elapsedTime
        for (let i = 0; i < DROPLET_COUNT; i++) {
            const d = data[i]
            const y = d.origin.y + Math.sin(t * d.speed + d.phase) * d.drift
            const x = d.origin.x + Math.cos(t * d.speed * 0.7 + d.phase) * 0.2
            dummy.position.set(x, y, d.origin.z)
            dummy.scale.setScalar(d.scale)
            dummy.updateMatrix()
            mesh.setMatrixAt(i, dummy.matrix)
        }
        mesh.instanceMatrix.needsUpdate = true
    })

    return (
        <instancedMesh
            ref={meshRef}
            args={[geometry, material, DROPLET_COUNT]}
        />
    )
}

function SceneContents({
    isDark,
    reveal,
    countStart,
    onRevealed,
}: {
    isDark: boolean
    reveal: RevealState
    countStart: boolean
    onRevealed: () => void
}): React.JSX.Element {
    // The vertical FOV keeps world height constant, so on the narrow hero
    // column the scattered stat coupons can overflow the frustum — scale the
    // whole ticket group down to fit both dimensions (bounds come from
    // SCENE_BOUNDS, computed from the scatter config). The canvas raster is
    // BLED past the layout box (CANVAS_BLEED_*_PX), so the fit is computed
    // against the layout-box slice of the frustum, not the whole canvas: the
    // composition keeps the size it had when canvas == layout box, and the
    // bleed becomes pure headroom that tilted geometry can swing into without
    // clipping. The 0.92 margin leaves ~8% of the layout box as rest-pose
    // slack before the bleed even starts (SCENE_BOUNDS already bakes in
    // tilt/lift/pop/drift extremes, so this is belt-and-braces, not the only
    // guard). Reactive to resize via R3F size state; no per-frame camera work.
    const { width, height } = useThree(state => state.size)
    const halfH = Math.tan((42 * Math.PI) / 180 / 2) * CAM_DIST
    const worldPerPx = (halfH * 2) / height
    const layoutHalfW =
        (Math.max(1, width - CANVAS_BLEED_X_PX * 2) / 2) * worldPerPx
    const layoutHalfH =
        (Math.max(1, height - CANVAS_BLEED_Y_PX * 2) / 2) * worldPerPx
    const fit = Math.min(
        1,
        (layoutHalfW * 0.92) / SCENE_BOUNDS.halfW,
        (layoutHalfH * 0.92) / SCENE_BOUNDS.halfH,
    )

    return (
        <>
            <ambientLight intensity={isDark ? 0.45 : 0.8} />
            <directionalLight
                position={[4, 6, 5]}
                intensity={isDark ? 1.6 : 2.1}
                color={CARAMEL_LIGHT}
            />
            <pointLight
                position={[-5, -2, 3]}
                intensity={isDark ? 2.2 : 1.4}
                color={CARAMEL}
                distance={18}
            />

            {/* Registered before the coupons (mount order = useFrame order)
                so t0 is stamped before any coupon reads it in the same
                tick. */}
            <RevealGate reveal={reveal} onRevealed={onRevealed} />

            <group scale={fit}>
                <StatCoupons
                    isDark={isDark}
                    reveal={reveal}
                    countStart={countStart}
                />
                {/* Inside the fit group ON PURPOSE: the droplet field is wider
                    than the layout box in raw world units, so scaling it with
                    the content keeps every sphere inside the (bled) frustum
                    instead of slicing them mid-sphere at the raster edge. */}
                <Droplets isDark={isDark} />
            </group>

            <Sparkles
                count={16}
                scale={[7, 6, 4]}
                size={2.2}
                speed={0.3}
                opacity={isDark ? 0.7 : 0.45}
                color={CARAMEL_LIGHT}
            />

            {/* One-frame Lightformer env: a warm 3-point rig (key fill, cool-
                warm side, back rim) baked once (frames={1}) — no HDR fetch, no
                per-frame cost, sculpted highlights across the glass. */}
            <Environment resolution={256} frames={1} background={false}>
                <Lightformer
                    intensity={isDark ? 1.3 : 1.9}
                    color={CARAMEL_LIGHT}
                    position={[0, 4, 4]}
                    scale={[9, 4, 1]}
                />
                <Lightformer
                    intensity={isDark ? 1.6 : 1.1}
                    color={CARAMEL}
                    position={[-5, -1, 2]}
                    scale={[6, 6, 1]}
                />
                <Lightformer
                    form="ring"
                    intensity={isDark ? 2.4 : 1.7}
                    color={CARAMEL_LIGHT}
                    position={[4, 2, -4]}
                    scale={[5, 5, 1]}
                />
            </Environment>
        </>
    )
}

export default function HeroTicketScene({
    active,
    isDark,
    onReady,
}: HeroTicketSceneProps): React.JSX.Element {
    // Shared mutable reveal state (see RevealGate). Deliberately NOT the
    // Canvas onCreated signal: context creation precedes the first real
    // frame by font-fetch + SDF generation + shader-compile time, and firing
    // the poster cross-fade there is exactly the blank-box pop this
    // choreography replaces.
    const reveal = useMemo<RevealState>(
        () => ({ t0: null, readyNodes: new Set<string>() }),
        [],
    )
    // React-side echo of the reveal for the count-up hooks (state, not the
    // mutable object, because useCountUp needs a render to start).
    const [revealStarted, setRevealStarted] = useState(false)
    const handleRevealed = useCallback(() => {
        setRevealStarted(true)
        onReady?.()
    }, [onReady])
    return (
        <Canvas
            className="h-full w-full"
            dpr={[1, 1.5]}
            frameloop={active ? 'always' : 'never'}
            camera={{ position: [0, 0, CAM_DIST], fov: 42 }}
            gl={{
                alpha: true,
                antialias: true,
                powerPreference: 'high-performance',
            }}
        >
            <SceneContents
                isDark={isDark}
                reveal={reveal}
                countStart={revealStarted}
                onRevealed={handleRevealed}
            />
        </Canvas>
    )
}
