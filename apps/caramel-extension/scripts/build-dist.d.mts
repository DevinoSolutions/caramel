/**
 * Hand-written declarations for build-dist.mjs, so wxt.config.ts (strict TS)
 * can import the ENVIRONMENTS table — the one env source of truth — without
 * pulling every .mjs script into the TypeScript program via allowJs.
 * Keep in lockstep with build-dist.mjs; the shapes below are load-bearing for
 * the WXT env stamp (wxt.config.ts) and the parity harness.
 */
export interface CaramelEnvironment {
    readonly baseUrl: string
    readonly trustedOrigins: readonly string[]
    readonly verbose: boolean
}

export declare const ENVIRONMENTS: {
    readonly production: CaramelEnvironment
    readonly development: CaramelEnvironment
}

export declare const SHIPPED: string[]
export declare const NEVER_SHIP: string[]
export declare const GENERATED: string[]
export declare const ENV_FILE: string

export declare function renderEnvStamp(
    name: keyof typeof ENVIRONMENTS,
): string

export declare function contentScriptRealmSources(
    files: string[],
    options?: { stamp?: string },
): string[]

export declare function buildDist(options: {
    outDir: string
    environment?: string
}): Promise<{ environment: string; entries: number }>
