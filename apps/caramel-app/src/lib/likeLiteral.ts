// src/lib/likeLiteral.ts
//
// What a shopper typed, made safe to put inside a LIKE/ILIKE pattern: `\`, `%`
// and `_` are backslash-escaped, the escape Postgres uses by default, so each
// one matches itself. The backslash goes first so the escapes added here are
// not escaped again. Every pattern built from input goes through this, and the
// caller adds its own `%` around the result. Without it a search for `%`
// listed every code and `e_ay` found ebay.com (2026-09-27, fleet ILIKE sweep).
// The value is still a bound parameter; this changes what the pattern means,
// not how it reaches the database.
//
// Its own module (pure, no imports) because withoutSearchText.ts needs the
// exact same escaped form to find a typed value inside a driver error that
// echoes the pattern; couponsRepo.ts is the only SQL consumer.
export const likeLiteral = (typed: string): string =>
    typed.replace(/[\\%_]/g, '\\$&')
