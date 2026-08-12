/**
 * The build-time environment stamp inlined by wxt.config.ts (vite `define`),
 * successor to the generated caramel-env.js. Values come from the ENVIRONMENTS
 * table in scripts/environments.mjs — the single source of truth.
 */
interface CaramelEnvStamp {
    readonly name: 'production' | 'development'
    readonly isProduction: boolean
    readonly baseUrl: string
    readonly trustedOrigins: readonly string[]
    readonly verbose: boolean
}

declare const __CARAMEL_ENV__: CaramelEnvStamp

declare var CARAMEL_ENV: CaramelEnvStamp

declare var CARAMEL_BASE_URL: string
