// Apple App Site Association — universal links + iOS password AutoFill for the
// Caramel iOS shell (DevinoSolutions/caramel-pwa-apple, bundle
// com.devino.caramel.app, team NYVG3QV9G2).
//
// Served from a route handler rather than public/.well-known/ because the file
// is extensionless: Next ships bare public files as application/octet-stream,
// and Apple wants application/json with no redirect. force-static keeps it on
// the SSG path like the rest of the site.
//
// NOT the Safari extension app (com.devino.Caramel / id6741873881) — that one
// ships through release-extension.yml and claims no universal links.

export const dynamic = 'force-static'

const APP_ID = 'NYVG3QV9G2.com.devino.caramel.app'

export function GET() {
    return Response.json({
        applinks: {
            details: [
                {
                    appIDs: [APP_ID],
                    // Everything except the API surface, which is never a
                    // navigable destination and should stay in the browser.
                    components: [
                        { '/': '/api/*', exclude: true },
                        { '/': '*' },
                    ],
                },
            ],
        },
        webcredentials: { apps: [APP_ID] },
    })
}
