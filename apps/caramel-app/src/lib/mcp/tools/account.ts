// src/lib/mcp/tools/account.ts
//
// The signed-in user's own Caramel account: profile, savings overview,
// settings, saved stores, data export and the two deletes. Every tool runs
// the route the profile page calls (routeBridge.ts); the profile name has no
// route of its own and goes through better-auth's user update, the same write
// better-auth's own update-user endpoint makes.
import { POST as dataDeletePost } from '@/app/api/account/data/delete/route'
import { POST as accountDeletePost } from '@/app/api/account/delete/route'
import { GET as exportGet } from '@/app/api/account/export/route'
import {
    DELETE as favoriteDelete,
    PUT as favoritePut,
} from '@/app/api/account/favorites/[store]/route'
import { GET as favoritesGet } from '@/app/api/account/favorites/route'
import { GET as overviewGet } from '@/app/api/account/overview/route'
import { PATCH as promptsPatch } from '@/app/api/account/prompts/route'
import { PATCH as savingsSyncPatch } from '@/app/api/account/savings-sync/route'
import { auth } from '@/lib/auth/auth'
import { McpDenialError } from '@/lib/mcp/denial'
import { callRouteOk } from '@/lib/mcp/routeBridge'
import { readSavingsSyncEnabled } from '@/lib/profile/savingsSyncPreference'
import type { ProfileOverview } from '@/lib/profile/types'
import { z } from 'zod'
import { defineTool, DESTRUCTIVE, IDEMPOTENT_WRITE, READ } from './defineTool'

const storeArg = z
    .string()
    .trim()
    .min(1)
    .max(253)
    .describe('The store as a domain, e.g. "nike.com".')

export const getProfile = defineTool({
    id: 'get_profile',
    title: 'Get Profile',
    description:
        "The user's Caramel profile: name, email, username and when they joined.",
    tier: 'read',
    annotations: READ,
    covers: [],
    inputSchema: z.object({}),
    run: async (_args, { principal }) => {
        const { user } = principal.session
        return {
            id: user.id,
            name: user.name || null,
            firstName: user.firstName ?? null,
            lastName: user.lastName ?? null,
            username: user.username ?? null,
            email: user.email || null,
            emailVerified: user.emailVerified,
            memberSince: user.createdAt.toISOString(),
        }
    },
})

const nameField = z.string().trim().min(1).max(100)

export const updateProfile = defineTool({
    id: 'update_profile',
    title: 'Update Profile',
    description:
        "Change the user's display name, first name or last name. Email and password are not changed here.",
    tier: 'write',
    annotations: IDEMPOTENT_WRITE,
    covers: [],
    inputSchema: z
        .object({
            name: nameField.optional(),
            firstName: nameField.optional(),
            lastName: nameField.optional(),
        })
        .refine(
            args =>
                args.name !== undefined ||
                args.firstName !== undefined ||
                args.lastName !== undefined,
            { message: 'give at least one of name, firstName, lastName' },
        ),
    run: async (args, { principal }) => {
        const ctx = await auth.$context
        const updated = await ctx.internalAdapter.updateUser(principal.userId, {
            ...(args.name !== undefined ? { name: args.name } : {}),
            ...(args.firstName !== undefined
                ? { firstName: args.firstName }
                : {}),
            ...(args.lastName !== undefined ? { lastName: args.lastName } : {}),
        })
        if (!updated) {
            throw new McpDenialError({
                code: 'TOOL_FAILED',
                details: 'The profile could not be updated.',
            })
        }
        return {
            name: (updated.name as string | null | undefined) ?? null,
            firstName: (updated.firstName as string | null | undefined) ?? null,
            lastName: (updated.lastName as string | null | undefined) ?? null,
        }
    },
})

export const getAccountOverview = defineTool({
    id: 'get_account_overview',
    title: 'Get Account Overview',
    description:
        "The user's Caramel dashboard: money saved per currency, recent savings, saved stores with their code counts, coupon reports and the codes they submitted.",
    tier: 'read',
    annotations: READ,
    covers: ['GET /api/account/overview'],
    inputSchema: z.object({}),
    run: async (_args, { principal }) =>
        callRouteOk<ProfileOverview>(principal.session, {
            handler: overviewGet,
            method: 'GET',
            path: '/api/account/overview',
        }),
})

export const getSettings = defineTool({
    id: 'get_settings',
    title: 'Get Settings',
    description:
        'The user\'s Caramel settings: "Show tips and prompts" and savings sync across devices.',
    tier: 'read',
    annotations: READ,
    covers: [],
    inputSchema: z.object({}),
    run: async (_args, { principal }) => ({
        showTipsAndPrompts: principal.session.user.growthPromptsEnabled,
        savingsSync: await readSavingsSyncEnabled(principal.userId),
    }),
})

export const updateSettings = defineTool({
    id: 'update_settings',
    title: 'Update Settings',
    description:
        'Turn "Show tips and prompts" or savings sync on or off. Savings sync uploads the savings the extension records (store, code, amount, time) so every signed-in device shows them; turning it off stops new uploads and keeps existing history.',
    tier: 'write',
    annotations: IDEMPOTENT_WRITE,
    covers: ['PATCH /api/account/prompts', 'PATCH /api/account/savings-sync'],
    inputSchema: z
        .object({
            showTipsAndPrompts: z.boolean().optional(),
            savingsSync: z.boolean().optional(),
        })
        .refine(
            args =>
                args.showTipsAndPrompts !== undefined ||
                args.savingsSync !== undefined,
            { message: 'give showTipsAndPrompts, savingsSync or both' },
        ),
    run: async (args, { principal }) => {
        const result: { showTipsAndPrompts?: boolean; savingsSync?: boolean } =
            {}
        if (args.showTipsAndPrompts !== undefined) {
            const res = await callRouteOk<{ growthPromptsEnabled: boolean }>(
                principal.session,
                {
                    handler: promptsPatch,
                    method: 'PATCH',
                    path: '/api/account/prompts',
                    body: { enabled: args.showTipsAndPrompts },
                },
            )
            result.showTipsAndPrompts = res.growthPromptsEnabled
        }
        if (args.savingsSync !== undefined) {
            const res = await callRouteOk<{ savingsSyncEnabled: boolean }>(
                principal.session,
                {
                    handler: savingsSyncPatch,
                    method: 'PATCH',
                    path: '/api/account/savings-sync',
                    body: { enabled: args.savingsSync },
                },
            )
            result.savingsSync = res.savingsSyncEnabled
        }
        return result
    },
})

export const listFavoriteStores = defineTool({
    id: 'list_favorite_stores',
    title: 'List Favorite Stores',
    description:
        'The stores the user follows (starred), newest first. Their codes are shown first everywhere the user browses Caramel.',
    tier: 'read',
    annotations: READ,
    covers: ['GET /api/account/favorites'],
    inputSchema: z.object({}),
    run: async (_args, { principal }) =>
        callRouteOk<{ favorites: unknown[] }>(principal.session, {
            handler: favoritesGet,
            method: 'GET',
            path: '/api/account/favorites',
        }),
})

export const addFavoriteStore = defineTool({
    id: 'add_favorite_store',
    title: 'Add Favorite Store',
    description: 'Follow (star) a store. Doing it twice is harmless.',
    tier: 'write',
    annotations: IDEMPOTENT_WRITE,
    covers: ['PUT /api/account/favorites/[store]'],
    inputSchema: z.object({ store: storeArg }),
    run: async (args, { principal }) =>
        callRouteOk<{ ok: boolean; store: string; favorited: boolean }>(
            principal.session,
            {
                handler: favoritePut,
                method: 'PUT',
                path: `/api/account/favorites/${encodeURIComponent(args.store)}`,
            },
        ),
})

export const removeFavoriteStore = defineTool({
    id: 'remove_favorite_store',
    title: 'Remove Favorite Store',
    description:
        'Unfollow (unstar) a store. Doing it twice is harmless; it can be followed again any time.',
    tier: 'write',
    annotations: IDEMPOTENT_WRITE,
    covers: ['DELETE /api/account/favorites/[store]'],
    inputSchema: z.object({ store: storeArg }),
    run: async (args, { principal }) =>
        callRouteOk<{ ok: boolean; store: string; favorited: boolean }>(
            principal.session,
            {
                handler: favoriteDelete,
                method: 'DELETE',
                path: `/api/account/favorites/${encodeURIComponent(args.store)}`,
            },
        ),
})

export const exportData = defineTool({
    id: 'export_data',
    title: 'Export Data',
    description:
        'A full copy of the data Caramel holds about the user (profile, settings, savings history, saved stores, reports, submitted codes) as JSON, the same file the "Download my data" button gives.',
    tier: 'account',
    annotations: READ,
    covers: ['GET /api/account/export'],
    inputSchema: z.object({}),
    run: async (_args, { principal }) =>
        callRouteOk<unknown>(principal.session, {
            handler: exportGet,
            method: 'GET',
            path: '/api/account/export',
        }),
})

export const deleteMyData = defineTool({
    id: 'delete_my_data',
    title: 'Delete My Data',
    description:
        'Erase the user\'s synced savings history, saved stores, coupon reports and proposed coupon boxes, and take their name off store requests and submitted codes, like "Delete my data". The account and login stay. Asks for confirmation first.',
    tier: 'destructive',
    annotations: DESTRUCTIVE,
    covers: ['POST /api/account/data/delete'],
    inputSchema: z.object({}),
    confirm: () =>
        'This permanently deletes your Caramel savings history, saved stores and coupon reports, and removes your name from your store requests and submitted codes. Your account stays. It cannot be undone.',
    run: async (_args, { principal }) =>
        callRouteOk<unknown>(principal.session, {
            handler: dataDeletePost,
            method: 'POST',
            path: '/api/account/data/delete',
            body: { confirm: 'DELETE' },
        }),
})

export const deleteAccount = defineTool({
    id: 'delete_account',
    title: 'Delete Account',
    description:
        'Permanently delete the user\'s Caramel account and everything tied to it, like "Delete my account": the login, connected Google or Apple sign-in, every session, saved stores, savings history, reports and every AI app connection (including this one). Codes they submitted stay listed without their name. Asks for confirmation first.',
    tier: 'account',
    annotations: DESTRUCTIVE,
    covers: ['POST /api/account/delete'],
    inputSchema: z.object({}),
    confirm: () =>
        'This permanently deletes your Caramel account, signs you out everywhere and disconnects every AI app, this one included. It cannot be undone.',
    run: async (_args, { principal }) =>
        callRouteOk<unknown>(principal.session, {
            handler: accountDeletePost,
            method: 'POST',
            path: '/api/account/delete',
            body: { confirm: 'DELETE' },
        }),
})

export const billingStatus = defineTool({
    id: 'billing_status',
    title: 'Billing Status',
    description:
        "The user's Caramel plan. Caramel is free: there is no paid plan, subscription or payment method.",
    tier: 'read',
    annotations: READ,
    covers: [],
    inputSchema: z.object({}),
    run: async () => ({
        plan: 'free' as const,
        paid: false,
        note: 'Caramel is free for everyone. There is nothing to upgrade or pay for.',
    }),
})
