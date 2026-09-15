import type { Metadata } from 'next'

// `<link rel="alternate" type="text/plain" href="/llms.txt" title="llms.txt">`
// — the discoverability pointer for the answer-engine summary served by
// src/app/llms.txt/route.ts (which itself points at /llms-full.txt).
//
// Next's metadata merge REPLACES `alternates` wholesale at every level
// (resolve-metadata.js: `newResolvedMetadata.alternates = resolveAlternates(
// source.alternates, …)`), so a page that declares its own canonical drops the
// root layout's entry. Every page that sets `alternates` and should carry the
// pointer spreads this in — today that is the root layout (default) and the
// home page. Pinned in raw home HTML by e2e/seo-regression.spec.ts.
export const LLMS_TXT_ALTERNATE_TYPES: NonNullable<
    NonNullable<Metadata['alternates']>['types']
> = {
    'text/plain': [{ url: '/llms.txt', title: 'llms.txt' }],
}
