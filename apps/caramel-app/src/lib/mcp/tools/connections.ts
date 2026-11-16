// src/lib/mcp/tools/connections.ts
//
// The connection itself: what this AI app was granted, how to get more, the
// other AI apps on the account, Disconnect, and contacting support.
import { POST as supportPost } from '@/app/api/support/route'
import { listConnectedApps, revokeConnectedApp } from '@/lib/mcp/connectedApps'
import { McpDenialError } from '@/lib/mcp/denial'
import { MCP_TIERS, TIER_CONSENT_ROWS, TIER_SCOPE } from '@/lib/mcp/oauthConfig'
import { callRouteOk } from '@/lib/mcp/routeBridge'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { defineTool, DESTRUCTIVE, READ, WRITE } from './defineTool'

export const listGrantedScopes = defineTool({
    id: 'list_granted_scopes',
    title: 'List Granted Scopes',
    description:
        'What this connection may do: each permission tier, whether it is granted, and what it covers. Call request_scopes for a tier that is missing.',
    tier: 'read',
    alwaysAvailable: true,
    annotations: READ,
    covers: [],
    inputSchema: z.object({}),
    run: async (_args, { principal }) => ({
        tiers: TIER_CONSENT_ROWS.map(row => ({
            tier: row.tier,
            scope: TIER_SCOPE[row.tier],
            granted: principal.tiers.includes(row.tier),
            covers: row.detail,
        })),
    }),
})

export const requestScopes = defineTool({
    id: 'request_scopes',
    title: 'Request Scopes',
    description:
        'How to give this connection a permission it lacks. Permissions are chosen on the Caramel consent screen, so the user reconnects Caramel and ticks the tier there; nothing changes until they do.',
    tier: 'read',
    alwaysAvailable: true,
    annotations: READ,
    covers: [],
    inputSchema: z.object({
        tiers: z
            .array(z.enum(MCP_TIERS))
            .min(1)
            .describe('The permission tiers to ask for.'),
    }),
    run: async (args, { principal }) => {
        const missing = args.tiers.filter(
            tier => !principal.tiers.includes(tier),
        )
        if (missing.length === 0) {
            return {
                alreadyGranted: true,
                message: 'This connection already has every tier asked for.',
            }
        }
        const labels = missing.map(
            tier => TIER_CONSENT_ROWS.find(row => row.tier === tier)?.label,
        )
        return {
            alreadyGranted: false,
            missing,
            message: `Ask the user to reconnect Caramel from this AI app's connector settings and allow: ${labels.join('; ')}. The new permissions apply from the next call after they approve.`,
        }
    },
})

export const listConnections = defineTool({
    id: 'list_connections',
    title: 'List Connections',
    description:
        "The AI apps connected to the user's Caramel account, what each may do, and which one is this connection.",
    tier: 'connections',
    annotations: READ,
    covers: ['GET /api/account/connected-apps'],
    inputSchema: z.object({}),
    run: async (_args, { principal }) => {
        const apps = await listConnectedApps(principal.userId)
        return {
            connections: apps.map(app => ({
                ...app,
                isThisConnection: app.clientId === principal.clientId,
            })),
        }
    },
})

export const disconnect = defineTool({
    id: 'disconnect',
    title: 'Disconnect',
    description:
        "Disconnect an AI app from the user's Caramel account (this one when clientId is left out). Its access stops on its next call. Asks for confirmation first.",
    tier: 'connections',
    annotations: DESTRUCTIVE,
    covers: ['DELETE /api/account/connected-apps/[clientId]'],
    inputSchema: z.object({
        clientId: z
            .string()
            .trim()
            .min(1)
            .max(200)
            .optional()
            .describe(
                'The app to disconnect, from list_connections. Leave out to disconnect this connection.',
            ),
    }),
    confirm: args =>
        args.clientId
            ? 'This disconnects that AI app from your Caramel account. It loses access immediately; you can connect it again later.'
            : 'This disconnects this AI app from your Caramel account. It loses access immediately; you can connect it again later.',
    run: async (args, { principal }) => {
        const clientId = args.clientId ?? principal.clientId
        const { wasConnected } = await revokeConnectedApp({
            userId: principal.userId,
            clientId,
        })
        if (!wasConnected) {
            throw new McpDenialError({
                code: 'NOT_FOUND',
                details: 'No AI app with that clientId is connected.',
                next: { tool: 'list_connections', args: {} },
            })
        }
        return { disconnected: true, clientId }
    },
})

export const createSupportTicket = defineTool({
    id: 'create_support_ticket',
    title: 'Create Support Ticket',
    description:
        'Send a question, a problem report or a feature request to the Caramel team for the user, like the support form. Replies go to the account email.',
    tier: 'support',
    annotations: { ...WRITE, openWorldHint: true },
    covers: ['POST /api/support'],
    inputSchema: z.object({
        type: z.enum(['problem', 'feature_request', 'question', 'other']),
        message: z.string().trim().min(1).max(4000),
        expectedOutcome: z
            .string()
            .trim()
            .max(2000)
            .optional()
            .describe('For a problem: what the user expected to happen.'),
        wantsReply: z.boolean().default(true),
    }),
    run: async (args, { principal }) => {
        const feedbackId = randomUUID()
        const email = principal.session.user.email || undefined
        if (args.wantsReply && !email) {
            throw new McpDenialError({
                code: 'VALIDATION_ERROR',
                details:
                    'wantsReply: this account has no email address to reply to. Send it with wantsReply false.',
            })
        }
        await callRouteOk<{ ok: boolean }>(principal.session, {
            handler: supportPost,
            method: 'POST',
            path: '/api/support',
            body: {
                feedback_id: feedbackId,
                feedback_type: args.type,
                message: args.message,
                ...(args.expectedOutcome
                    ? { expected_outcome: args.expectedOutcome }
                    : {}),
                wants_reply: args.wantsReply,
                ...(email ? { email } : {}),
                route: 'mcp',
            },
        })
        return {
            sent: true,
            ticketId: feedbackId,
            replyTo: args.wantsReply ? email : null,
        }
    },
})
