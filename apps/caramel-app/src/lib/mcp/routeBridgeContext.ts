// src/lib/mcp/routeBridgeContext.ts
//
// The in-process identity an MCP tool call runs a Caramel API route as.
//
// MCP tools do not re-implement what the app does: each one calls the SAME
// route handler the website and the extension call (src/lib/mcp/routeBridge.ts),
// so validation, rate limits, reputation rules and side effects cannot drift
// between a person and their AI agent. The route still needs a "signed-in
// user", and an MCP caller has an OAuth access token, not a better-auth
// session. The bridge runs the handler inside this AsyncLocalStorage scope, and
// withRoute (src/lib/api/withRoute.ts) uses the session found here instead of
// reading cookies or a bearer.
//
// Nothing outside the bridge can enter this scope: it is not reachable from an
// HTTP request, only from code that calls runAsBridgedSession. Deliberately
// free of runtime imports, so withRoute can read it without pulling in Prisma
// or the auth server.
import { AsyncLocalStorage } from 'node:async_hooks'

/** better-auth's `getSession` result, as withRoute types it. */
export type BridgedSession = NonNullable<
    Awaited<ReturnType<typeof import('@/lib/auth/auth').auth.api.getSession>>
>

const bridgedSessionStore = new AsyncLocalStorage<BridgedSession>()

/** Run `fn` with `session` as the signed-in user of every route it calls. */
export function runAsBridgedSession<T>(
    session: BridgedSession,
    fn: () => Promise<T>,
): Promise<T> {
    return bridgedSessionStore.run(session, fn)
}

/** The session of the MCP call this code runs inside, or undefined. */
export function currentBridgedSession(): BridgedSession | undefined {
    return bridgedSessionStore.getStore()
}
