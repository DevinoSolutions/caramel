// E-05 e2e seeding helper — creates a REAL, email-verified user so the login
// success spec can exercise the genuine better-auth sign-in path (real
// credential hash, real session cookie), not a page.route mock.
//
// Two steps, both against real infrastructure:
//   1. POST the REAL /api/auth/sign-up/email endpoint (better-auth creates the
//      user + the bcrypt-hashed `credential` account row exactly as production
//      would — reproducing that by hand is fragile, so we drive the real API).
//   2. Flip email_verified directly in the DB. CI cannot click a verification
//      email, and emailAndPassword.requireEmailVerification is ON (auth.ts), so
//      without this flip the seeded user could never sign in. This DB write is
//      the ONLY part that bypasses a real user action, and it is deliberate +
//      test-only. The extension e2e job (checks-extension.yml) REUSES this
//      exact helper via scripts/seed-e2e-user.ts to create its fixture login.
//
// Requires DATABASE_URL in the environment (playwright.config.ts loads .env).
// Callers MUST gate on DATABASE_URL and skip when it is absent (deployed-site
// e2e-push has no seedable DB).

import { openTestPrisma } from './test-prisma'

export interface SeedUserInput {
    baseURL: string
    email: string
    password: string
    name: string
}

export async function seedVerifiedUser({
    baseURL,
    email,
    password,
    name,
}: SeedUserInput): Promise<void> {
    if (!process.env.DATABASE_URL) {
        throw new Error(
            'seedVerifiedUser requires DATABASE_URL — caller must skip when it is unset',
        )
    }

    // 1. Real signup. better-auth lowercases nothing itself, but the login form
    // signs in with email.trim().toLowerCase(), so seed a lowercase email.
    // better-auth rejects state-changing POSTs with a null Origin
    // (MISSING_OR_NULL_ORIGIN); send the trusted origin (baseURL is in
    // auth.ts's trustedOrigins) so this Node-side fetch is accepted like a
    // real browser request would be.
    const res = await fetch(new URL('/api/auth/sign-up/email', baseURL), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Origin: new URL(baseURL).origin,
        },
        body: JSON.stringify({ name, email, password }),
    })

    // 200 = created. 422 USER_ALREADY_EXISTS = a previous run/worker already
    // seeded it — idempotent, fine. Anything else is a real failure: throw
    // loudly (no silent swallow) so the spec fails with context, not a
    // mysterious downstream login error.
    if (res.status !== 200) {
        const body = await res.text().catch(() => '')
        const alreadyExists =
            res.status === 422 && /USER_ALREADY_EXISTS/i.test(body)
        if (!alreadyExists) {
            throw new Error(
                `seedVerifiedUser signup failed: HTTP ${res.status} ${body}`,
            )
        }
    }

    // 2. Flip email_verified so requireEmailVerification lets the user sign in.
    //
    // ⚠️ The Prisma client is opened through openTestPrisma(), which imports
    // the GENERATED client lazily, never at module top level. auth-flows.spec.ts
    // imports this helper at collection time, and the e2e-push job runs
    // against the DEPLOYED site without ever running `prisma generate`
    // (correctly — it has no DB), so src/generated/prisma is absent there BY
    // DESIGN. This call is only reached when DATABASE_URL is set (e2e-pr/local,
    // where the client IS generated).
    const prisma = await openTestPrisma()
    try {
        await prisma.user.update({
            where: { email },
            data: { emailVerified: true },
        })
    } finally {
        await prisma.$disconnect()
    }
}
