/**
 * Hand-written declarations for environments.mjs so wxt.config.ts (strict TS,
 * no allowJs) can import the table. Keep in lockstep with environments.mjs.
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

export interface CaramelEnvStampValues {
    readonly name: keyof typeof ENVIRONMENTS
    readonly isProduction: boolean
    readonly baseUrl: string
    readonly trustedOrigins: readonly string[]
    readonly verbose: boolean
}

export declare function stampFor(
    name: keyof typeof ENVIRONMENTS,
): CaramelEnvStampValues
