// Canonical external URLs for Caramel — the store listings, the repo and the
// social profiles. ONE module so the footer, the hero store buttons, llms.txt
// and the root layout's JSON-LD `sameAs` graph can never drift apart: a
// listing URL change lands here once and every surface follows
// (tests/unit/discord-invite.test.ts pins the Discord invite to this module).

export const GITHUB_REPO_URL = 'https://github.com/DevinoSolutions/caramel'

export const CHROME_WEB_STORE_URL =
    'https://chromewebstore.google.com/detail/caramel-trusted-honey-alt/gaimofgglbackoimfjopicmbmnlccfoe'

export const FIREFOX_ADDONS_URL =
    'https://addons.mozilla.org/en-US/firefox/addon/grabcaramel/'

export const EDGE_ADDONS_URL =
    'https://microsoftedge.microsoft.com/addons/detail/caramel/leodahchedhnenmiengkfpmmcdendnof'

export const SAFARI_APP_STORE_URL =
    'https://apps.apple.com/ke/app/caramel/id6741873881'

// The Caramel community server: a permanent invite (no expiry, unlimited uses,
// verified live 2026-10-08). Linked from the footer, the open-source section,
// /support, the support dialog, the FAQ and the mobile menu, plus llms-full.txt
// and the JSON-LD `sameAs`.
export const DISCORD_INVITE_URL = 'https://discord.gg/2vVVrQ5CEB'

export const INSTAGRAM_URL = 'https://www.instagram.com/grab.caramel/'
