// src/lib/mcp/tools/registry.ts
//
// Every Caramel MCP tool, in the order tools/list and search_tools show them.
// A new tool is defined with defineTool() and added here; the parity test
// (tests/unit/mcp/parity.test.ts) fails when a signed-in API route has neither
// a tool that covers it nor an entry in NOT_EXPOSED below.
import { registerTool, type RegisteredTool } from '../guard'
import {
    addFavoriteStore,
    billingStatus,
    deleteAccount,
    deleteMyData,
    exportData,
    getAccountOverview,
    getProfile,
    getSettings,
    listFavoriteStores,
    removeFavoriteStore,
    updateProfile,
    updateSettings,
} from './account'
import {
    createSupportTicket,
    disconnect,
    listConnections,
    listGrantedScopes,
    requestScopes,
} from './connections'
import {
    getCatalogOverview,
    getCoupon,
    getStoreDeals,
    listCouponSources,
    listRecentlyWorkedCoupons,
    listTopStores,
    reportCoupon,
    requestCouponSource,
    requestStore,
    searchCoupons,
    searchStores,
    submitCoupon,
} from './coupons'

export const CARAMEL_TOOLS: readonly RegisteredTool[] = [
    // Coupons and stores
    registerTool(searchCoupons),
    registerTool(getStoreDeals),
    registerTool(getCoupon),
    registerTool(searchStores),
    registerTool(listTopStores),
    registerTool(listRecentlyWorkedCoupons),
    registerTool(getCatalogOverview),
    registerTool(listCouponSources),
    registerTool(submitCoupon),
    registerTool(reportCoupon),
    registerTool(requestStore),
    registerTool(requestCouponSource),
    // Account
    registerTool(getProfile),
    registerTool(updateProfile),
    registerTool(getAccountOverview),
    registerTool(getSettings),
    registerTool(updateSettings),
    registerTool(listFavoriteStores),
    registerTool(addFavoriteStore),
    registerTool(removeFavoriteStore),
    registerTool(billingStatus),
    registerTool(exportData),
    registerTool(deleteMyData),
    registerTool(deleteAccount),
    // This connection, other AI apps, support
    registerTool(listGrantedScopes),
    registerTool(requestScopes),
    registerTool(listConnections),
    registerTool(disconnect),
    registerTool(createSupportTicket),
]

/**
 * API routes a signed-in user (or the extension) can call that are NOT MCP
 * tools, each with the reason. Owner rule: anything a signed-in user can do in
 * Caramel, an agent can do over MCP, so every entry here is either not a user
 * action at all, or one the fleet contract keeps away from agents.
 */
const BETTER_AUTH_REASON =
    'better-auth itself: sign-in, sign-up, password and email changes, sessions and the OAuth server are credential operations, kept out of agent reach (fleet contract: credentials and key rotation are owner-only). Profile name and image are exposed as update_profile.'

export const NOT_EXPOSED: Readonly<Record<string, string>> = {
    'POST /api/account/savings':
        'Extension-only ingest: the extension uploads savings it measured at checkout; an agent has no checkout to measure.',
    'POST /api/coupons/increment':
        'Extension telemetry (a code was copied), not a user action.',
    'POST /api/coupons/expire':
        'Server-to-server catalog maintenance behind COUPONS_ADMIN_SECRET.',
    'POST /api/classify-cart':
        'Extension-internal LLM page classifier, not a user action.',
    'POST /api/ext/installed': 'Extension install telemetry.',
    'POST /api/extension/coupon-box-pick':
        'Extension-only: the shopper points at the coupon box on a live checkout page.',
    'POST /api/extension/coupon-box-save':
        'Extension-only: saves the coupon box picked on a live checkout page.',
    'GET /api/extension/features': 'Extension feature flags.',
    'POST /api/extension/login':
        'Extension sign-in (credentials); agents connect through OAuth instead.',
    'GET /api/extension/me': 'Extension session probe.',
    'GET /api/extension/oauth/authorize': 'Extension Google/Apple sign-in.',
    'POST /api/extension/oauth/google-id-token': 'Extension Google sign-in.',
    'GET /api/extension/oauth/redirect': 'Extension Google/Apple sign-in.',
    'POST /api/extension/oauth/redirect': 'Extension Google/Apple sign-in.',
    'POST /api/extension/oauth': 'Extension Google/Apple sign-in.',
    'POST /api/extension/session': 'Extension session refresh.',
    'DELETE /api/extension/session': 'Extension sign-out.',
    'GET /api/extension/supported-stores':
        'Extension checkout configuration; search_stores answers the same question for people.',
    'POST /api/extension/telemetry': 'Extension diagnostics.',
    'POST /api/app/web-session/handoff':
        'Native app to website sign-in handoff (credentials).',
    'GET /api/app/web-session/redeem':
        'Native app to website sign-in handoff (credentials).',
    'POST /api/dev-proof/session': 'Development-only probe.',
    'GET /api/health': 'Operations health check.',
    'GET /api/health/db': 'Operations health check.',
    'GET /api/version': 'Build metadata.',
    'POST /api/ingest/catalog': 'Supplier catalog ingest (server key).',
    'GET /api/ingest/site-suggestions': 'Pipeline queue read (server key).',
    'POST /api/ingest/site-suggestions/ack': 'Pipeline queue ack (server key).',
    'POST /api/ingest/site-suggestions/notify':
        'Pipeline notification (server key).',
    'GET /api/auth/[...all]': BETTER_AUTH_REASON,
    'POST /api/auth/[...all]': BETTER_AUTH_REASON,
    'POST /api/mcp': 'The MCP endpoint itself.',
    'GET /api/mcp': 'The MCP endpoint itself.',
    'DELETE /api/mcp': 'The MCP endpoint itself.',
}
