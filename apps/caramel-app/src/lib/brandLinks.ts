// Canonical external URLs for Caramel — the store listings, the repo and the
// social profiles. ONE module so the footer, the hero store buttons, llms.txt
// and the root layout's JSON-LD `sameAs` graph can never drift apart: a
// listing URL change lands here once and every surface follows.
//
// TODO: FeaturesSection.tsx and OpenSourceSection.tsx still carry copies of
// these URLs — they are owned by a parallel claims branch right now, so they
// are deliberately NOT refactored here. Point them at this module once that
// branch lands.

export const GITHUB_REPO_URL = 'https://github.com/DevinoSolutions/caramel'

export const CHROME_WEB_STORE_URL =
    'https://chromewebstore.google.com/detail/caramel-trusted-honey-alt/gaimofgglbackoimfjopicmbmnlccfoe'

export const FIREFOX_ADDONS_URL =
    'https://addons.mozilla.org/en-US/firefox/addon/grabcaramel/'

export const EDGE_ADDONS_URL =
    'https://microsoftedge.microsoft.com/addons/detail/caramel/leodahchedhnenmiengkfpmmcdendnof'

export const SAFARI_APP_STORE_URL =
    'https://apps.apple.com/ke/app/caramel/id6741873881'

export const DISCORD_INVITE_URL = 'https://discord.com/invite/2vVVrQ5CEB'

export const INSTAGRAM_URL = 'https://www.instagram.com/grab.caramel/'
