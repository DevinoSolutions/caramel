// src/lib/profile/savingsSyncPreference.ts
//
// The ONE place the account page learns whether a user has opted into cloud
// savings sync. It is a module rather than an inline read so that wiring it to
// its real storage is a one-line change in one file.
//
// TODO(feat/login-savings): this must read `users.savings_sync_enabled` — the
// additive `User.savingsSyncEnabled Boolean @default(false)` column owned by
// the savings-sync PR (feat/login-savings), which also ships
// `PATCH /api/account/savings-sync`. That column does NOT exist on this branch
// (feat/profile-revamp is cut from feat/login-foundation), so referencing it
// here would not compile. When the two PRs meet, replace the body below with:
//
//     const row = await prisma.user.findUnique({
//         where: { id: userId },
//         select: { savingsSyncEnabled: true },
//     })
//     return row?.savingsSyncEnabled ?? false
//
// and delete this comment. Read it from Prisma, NOT from the better-auth
// session: `auth.api.getSession()` only returns fields better-auth knows
// about, so a custom column arrives there as `undefined` — falsy, and every
// user would silently render as sync-off.
//
// Returning false today is not a placeholder or a guess, it is the true
// value: on this branch nothing can set the preference (no column, no PATCH
// route), so every account genuinely has sync off and the savings section
// correctly renders its opt-in pitch. The account page therefore behaves
// correctly standalone and lights up the moment the column lands.
export async function readSavingsSyncEnabled(userId: string): Promise<boolean> {
    void userId
    return false
}
