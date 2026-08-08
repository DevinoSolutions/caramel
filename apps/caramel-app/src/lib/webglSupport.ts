// webglSupport — a cheap one-shot probe shared by every lazy 3D surface
// (CouponVaultSection, HeroSection): a pinned dep + a mounted <Canvas> still
// hard-fail on machines/policies with no GL, so we gate on a REAL context
// before ever mounting a scene. Guarded for SSR (returns false on the server).
export function detectWebGL(): boolean {
    if (typeof document === 'undefined') return false
    try {
        const canvas = document.createElement('canvas')
        const gl =
            canvas.getContext('webgl2') ??
            canvas.getContext('webgl') ??
            canvas.getContext('experimental-webgl')
        return gl !== null
    } catch {
        return false
    }
}
