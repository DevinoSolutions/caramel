// ticketNotchMask — a CSS mask that punches a semicircular notch into each
// SHORT edge of a ticket (left/right at the perforation axis): the 2D twin of
// the extruded 3D notch in couponTicket3d, used by the DOM poster fallbacks.
// Two radial gradients — each opaque except a transparent disc at one edge —
// intersected so only the two discs read as cut-outs. `axis` is the vertical
// position of the notch line.
//
// Lives in its own tiny module ON PURPOSE: the poster shells (HeroSection,
// CouponVaultSection) are in the main page bundle, and importing this from
// couponTicket3d (which imports `three`) would drag the whole three/R3F stack
// into first-load JS, defeating the next/dynamic lazy-loading of the scenes.

export function ticketNotchMask(
    radius: string,
    axis: string,
): React.CSSProperties {
    const grad = (at: string): string =>
        `radial-gradient(circle ${radius} at ${at}, transparent calc(${radius} - 1px), #000 ${radius})`
    const image = `${grad(`0 ${axis}`)}, ${grad(`100% ${axis}`)}`
    return {
        maskImage: image,
        WebkitMaskImage: image,
        maskComposite: 'intersect',
        WebkitMaskComposite: 'source-in',
    }
}
