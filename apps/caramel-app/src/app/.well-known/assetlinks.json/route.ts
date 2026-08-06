// Digital Asset Links — Android App Links verification for the Caramel Android
// shell (DevinoSolutions/caramel-pwa-android, applicationId com.devino.caramel).
// Without this file the shell's autoVerify intent-filter never verifies and
// grabcaramel.com links open in the browser instead of the app.
//
// Route handler rather than a public/ file purely for symmetry with the AASA
// next door, which has to be one.

export const dynamic = 'force-static'

// Upload key: C:\Users\alaed\.android-keys\caramel-upload.keystore (minted
// 2026-08-06; credentials beside it, never regenerate — a new key orphans every
// installed build).
const UPLOAD_KEY_SHA256 =
    'A8:AB:BD:05:30:0E:97:DA:53:90:E9:E7:D4:E9:BB:CC:CF:2C:66:E5:68:AA:66:65:5A:45:02:0F:38:B0:AE:BA'

// TODO: append the Play App Signing SHA-256 the moment the Play record exists
// (Console -> Setup -> App signing). Play RE-SIGNS uploaded bundles, so a file
// carrying only the upload key verifies for sideloaded builds and silently
// fails for every user who installed from Play.
const PLAY_APP_SIGNING_SHA256: string[] = []

export function GET() {
    return Response.json([
        {
            relation: ['delegate_permission/common.handle_all_urls'],
            target: {
                namespace: 'android_app',
                package_name: 'com.devino.caramel',
                sha256_cert_fingerprints: [
                    UPLOAD_KEY_SHA256,
                    ...PLAY_APP_SIGNING_SHA256,
                ],
            },
        },
    ])
}
