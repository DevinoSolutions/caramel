// src/lib/profile/savingsSyncPreference.ts
//
// The ONE place the account page learns whether a user has opted into cloud
// savings sync. It is a module rather than an inline read so that every
// consumer (the overview payload, the export's `preferences` block) resolves
// the flag exactly one way.
//
// READ IT FROM THE TABLE, NEVER FROM THE SESSION. better-auth projects only
// the fields it knows about onto `session.user`, so a custom column arrives
// there as `undefined` — falsy, and therefore indistinguishable from a real
// "off". Every account would silently render as sync-off while the table said
// otherwise. `PATCH /api/account/savings-sync` writes this column and reads it
// back for the same reason: `users.savings_sync_enabled` is the single
// authority, and chrome.storage.sync is only a cache of it.
//
// A missing user row resolves to false rather than throwing: the caller is
// already handling a live session whose row it separately verifies (the export
// route 404s on it), and an absent row genuinely carries no consent.
import prisma from '@/lib/prisma'

export async function readSavingsSyncEnabled(userId: string): Promise<boolean> {
    const row = await prisma.user.findUnique({
        where: { id: userId },
        select: { savingsSyncEnabled: true },
    })
    return row?.savingsSyncEnabled ?? false
}
