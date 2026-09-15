// The AI answer-engine / search crawlers that get an EXPLICIT allow group in
// robots.txt (src/app/robots.ts), on top of the `*` group. A named group is
// what makes the intent unambiguous to an operator reading the file — and to
// the crawlers whose docs say they honour a product-specific token before the
// wildcard. The set is the fleet standard from
// ~/.claude/skills/seo-fleet/references/aeo-crawler-access.md; it is pinned
// verbatim by tests/unit/robots-env-contract.test.ts so nobody can drop or
// misspell an agent without a red test. Order is documentation order — keep
// it stable; the test compares the exact array.
export const AI_CRAWLERS = [
    'GPTBot',
    'OAI-SearchBot',
    'ChatGPT-User',
    'ClaudeBot',
    'Claude-User',
    'Claude-SearchBot',
    'anthropic-ai',
    'PerplexityBot',
    'Perplexity-User',
    'Google-Extended',
    'Googlebot',
    'Bingbot',
    'Applebot',
    'Applebot-Extended',
    'CCBot',
    'Amazonbot',
    'Bytespider',
    'meta-externalagent',
] as const
