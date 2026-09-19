import { indexNowKeyResponse } from '@/lib/seo/indexnow'

// /<key>.txt — the IndexNow host-ownership proof for grabcaramel.com.
//
// The directory name IS the key: IndexNow fetches this exact path and expects
// the body to be the same key, so the two are kept in step by importing the
// one constant (see lib/seo/indexnow for why the key is public) and pinned
// by tests/unit/indexnow-key-file.test.ts.
//
// Deliberately NOT a `withRoute` handler, for the same reason as
// src/app/llms.txt/route.ts: withRoute owns the /api surface. This is a
// static public text asset in the robots.ts / sitemap.ts / llms.txt family —
// no request input, no auth, no DB.
export function GET(): Response {
    return indexNowKeyResponse()
}
