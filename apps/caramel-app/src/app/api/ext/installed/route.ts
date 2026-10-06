// src/app/api/ext/installed/route.ts
//
// Server half of the post-install handshake (the /welcome page POSTs here, see
// src/lib/extensionInstall.ts). Records `extension_installed` in PostHog from
// OUR server, so an install is counted even when the visitor's own PostHog
// traffic never arrives (content blocker, consent refusal, failed load).
//
// Public + same-origin: the extension opens the page in the user's browser, so
// the POST comes from the site itself. The first-touch cookie (`cm_ft`) rides
// along because it is first-party, which is what lets the install be
// attributed to the campaign that sent the user to the store.
//
// Idempotent: the install id is the PostHog event uuid (and `$insert_id`), and
// the page also guards in localStorage, so a reload or retry cannot double
// count. The reply is `{ captured: boolean }` and the client checks it; a
// `false` is never swallowed (the page reports it).
import { deriveFirstTouchSource } from '@/lib/analytics/firstTouchRecord'
import {
    readFirstTouchFromHeaders,
    readPosthogDistinctId,
} from '@/lib/analytics/firstTouchServer'
import { buildFirstTouchProperties } from '@/lib/analytics/identityProperties'
import {
    captureServerEvent,
    getServerPosthogProjectToken,
} from '@/lib/analytics/posthogServer'
import { withRoute } from '@/lib/api/withRoute'
import {
    EXTENSION_STORES,
    EXTENSION_VERSION_PATTERN,
    INSTALL_ID_PATTERN,
    organicInstallSource,
    type ExtInstalledRequest,
    type ExtInstalledResponse,
} from '@/lib/extensionInstall'
import { NextResponse } from 'next/server'
import { z } from 'zod'

// `satisfies` ties this schema to the interface the client sends with: a field
// added on one side fails the type-check on the other.
const ExtInstalledBodySchema = z.object({
    store: z.enum(EXTENSION_STORES),
    extension_version: z.string().regex(EXTENSION_VERSION_PATTERN),
    iid: z.string().regex(INSTALL_ID_PATTERN),
    distinct_id: z.string().min(1).max(200).optional(),
}) satisfies z.ZodType<ExtInstalledRequest>

export const POST = withRoute(
    {
        method: 'POST',
        routeName: 'ext/installed',
        rateLimit: 'mutation',
        origin: true,
        body: ExtInstalledBodySchema,
    },
    async ({ req, body }) => {
        const firstTouch = readFirstTouchFromHeaders(req.headers)
        const token = getServerPosthogProjectToken()
        const cookieDistinctId = token
            ? readPosthogDistinctId(req.headers, token)
            : null
        // The browser's own id when it has one, so this event and the browser's
        // (same uuid) are the SAME event to PostHog; the install id otherwise.
        const distinctId = body.distinct_id ?? cookieDistinctId ?? body.iid

        const captured = await captureServerEvent({
            event: 'extension_installed',
            distinctId,
            uuid: body.iid,
            properties: {
                store: body.store,
                extension_version: body.extension_version,
                iid: body.iid,
                source:
                    deriveFirstTouchSource(firstTouch) ??
                    organicInstallSource(body.store),
                capture_path: 'server',
                ...buildFirstTouchProperties(firstTouch),
                // An install is not a person: do not mint a profile for an
                // anonymous id (or, worse, one per install id). The event still
                // joins the person when the browser id is later identified.
                $process_person_profile: false,
            },
        })

        const response: ExtInstalledResponse = { captured }
        return NextResponse.json(response)
    },
)
