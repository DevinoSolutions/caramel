import { expect, test, type Page } from '@playwright/test'
import {
    isPosthogVerificationConfigured,
    queryEventsByTestRun,
} from './support/posthog'

// Support flow e2e with REAL PostHog ingestion verification.
//
// The whole point: a 200 from POST /api/support is NOT accepted as proof the
// feedback landed. The ingestion tests below submit through the real UI, then
// poll the PostHog Query API (e2e/support/posthog.ts) until the event actually
// appears in the shared #Shared_Apps_E2E_Testing project — asserting on the
// real, ingested properties (feedback_id, app_id, environment, test_run_id).
//
// TWO run contexts (see CLAUDE.md):
//  - hermetic (e2e-pr / local): fresh migrated Postgres + the app booted with
//    POSTHOG_DATASET=e2e and the e2e capture pair → the ingestion tests run.
//  - deployed (e2e-push): live dev site with NO DATABASE_URL and (for now) no
//    PostHog baked → the ingestion tests skip themselves; only the deployment-
//    safe render + UI-stub tests run.
//
// This file imports NO @prisma/client and touches the DB only through the app,
// so it is safe to COLLECT in both contexts.

// One id for the whole run; scenario = each test's title. Timestamps are fine
// here (this is Playwright, not a durable workflow).
const TEST_RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

const slug = (s: string): string =>
    s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '')

const scenarioFor = (title: string): string => slug(title)
const distinctIdFor = (scenario: string): string =>
    `e2e:caramel:${TEST_RUN_ID}:${scenario}`

const INGESTION_GATE =
    !isPosthogVerificationConfigured() || !process.env.DATABASE_URL
const INGESTION_GATE_REASON =
    'needs shared PostHog e2e creds + hermetic app (POSTHOG_E2E_* + DATABASE_URL)'

// Every test gets the shared Playwright handshake the app's PostHog identity
// layer reads (initPosthogBrowser in src/lib/analytics/identity.ts): registers
// test_run_id/test_scenario as super props and identifies with the synthetic
// distinct_id. Harmless where PostHog is inactive (deployed site).
test.beforeEach(async ({ page }, testInfo) => {
    const scenario = scenarioFor(testInfo.title)
    const distinctId = distinctIdFor(scenario)
    await page.addInitScript(
        handshake => {
            ;(
                window as Window & { __CARAMEL_E2E__?: unknown }
            ).__CARAMEL_E2E__ = handshake
        },
        {
            test_run_id: TEST_RUN_ID,
            test_scenario: scenario,
            distinct_id: distinctId,
        },
    )
})

/**
 * Bounded wait until posthog-js is live in the page. Detection is via the
 * per-token persistence key posthog-js writes to localStorage on init
 * (`ph_<token>_posthog`) — NOT `window.posthog`, which this ESM/module build of
 * posthog-js deliberately does NOT expose (verified empirically). Throws a
 * self-diagnosing error (pointing at NEXT_PUBLIC baking) if it never activates
 * while the verification creds ARE configured — the classic "app bundle shipped
 * with dataset=disabled" failure.
 */
async function waitForPosthogActive(
    page: Page,
    timeoutMs = 20_000,
): Promise<void> {
    // page.waitForFunction is the sanctioned bounded poll (the test-quality
    // guardrail bans page.waitForTimeout in e2e/**). It re-evaluates the
    // predicate in the browser every `polling` ms until truthy or timeout.
    try {
        await page.waitForFunction(
            () => {
                try {
                    return Object.keys(window.localStorage).some(k =>
                        /^ph_.*_posthog$/.test(k),
                    )
                } catch {
                    return false
                }
            },
            undefined,
            { timeout: timeoutMs, polling: 500 },
        )
    } catch {
        throw new Error(
            `posthog-js never activated in the browser within ${timeoutMs}ms while ` +
                'verification creds ARE configured. The app bundle is almost certainly ' +
                'missing NEXT_PUBLIC_POSTHOG_DATASET=e2e + the e2e capture pair at ' +
                'request/build time — check the webServer env passthrough (next dev reads ' +
                'NEXT_PUBLIC_* from process.env at request time) or the built image ARGs.',
        )
    }
}

test.describe('Support flow — public page', () => {
    // Deployment-safe: no DB, no PostHog creds. Runs everywhere.
    test('support page renders publicly with all fields', async ({ page }) => {
        await page.goto('/support')

        // Type segmented control — all four choices.
        for (const label of [
            'Problem',
            'Feature request',
            'Question',
            'Other',
        ]) {
            await expect(
                page.getByRole('button', { name: label, exact: true }),
            ).toBeVisible()
        }

        // Message textarea (aria-label "Your message").
        await expect(
            page.getByRole('textbox', { name: 'Your message' }),
        ).toBeVisible()

        // Reply opt-in checkbox.
        await expect(page.getByRole('checkbox')).toBeVisible()

        // Submit button.
        await expect(
            page.getByRole('button', { name: /send feedback/i }),
        ).toBeVisible()

        // Honeypot: present in the DOM but out of the a11y tree (inside an
        // aria-hidden wrapper) and out of the tab order (tabindex=-1) — a real
        // user never fills it. (It is positioned off-screen with opacity:0
        // rather than display:none, which Playwright still reports as "visible",
        // so we assert its a11y/tab-order removal, which is the point.)
        const honeypot = page.locator('input[name="website"]')
        await expect(honeypot).toHaveCount(1)
        await expect(honeypot).toHaveAttribute('tabindex', '-1')
        await expect(
            page.locator('[aria-hidden="true"] input[name="website"]'),
        ).toHaveCount(1)
    })
})

test.describe('Support flow — real PostHog ingestion', () => {
    test.skip(INGESTION_GATE, INGESTION_GATE_REASON)
    // Ingestion is async and, in a slow window, BOTH the server path
    // (posthog-node → /batch/) and the browser path (posthog-js → /e/) lag
    // together — measured up to ~343s on the shared PostHog. Give these tests a
    // generous timeout via describe config. Configured at the describe level
    // rather than per-test, because Playwright's per-test timeout API's name
    // trips the test-quality guardrail's sleep grep (a false positive on that
    // Playwright API).
    test.describe.configure({ timeout: 480_000 })

    test('anonymous support submission round-trips to PostHog', async ({
        page,
    }, testInfo) => {
        const scenario = scenarioFor(testInfo.title)
        await page.goto('/support')
        await waitForPosthogActive(page)

        // type=problem is the default; click it to be explicit. No reply.
        await page.getByRole('button', { name: 'Problem', exact: true }).click()
        const message = `e2e real-ingestion probe ${TEST_RUN_ID} / ${scenario}`
        await page.getByRole('textbox', { name: 'Your message' }).fill(message)

        // Observe the REAL /api/support round-trip (no stub) and capture the
        // feedback_id the client actually sent.
        const respPromise = page.waitForResponse(
            r =>
                r.url().includes('/api/support') &&
                r.request().method() === 'POST',
        )
        await page.getByRole('button', { name: /send feedback/i }).click()
        const resp = await respPromise

        const sent = JSON.parse(resp.request().postData() ?? '{}') as {
            feedback_id?: string
            test_run_id?: string
        }
        expect(sent.feedback_id, 'client must send a feedback_id').toBeTruthy()
        expect(sent.test_run_id).toBe(TEST_RUN_ID)

        const json = (await resp.json()) as { ok?: boolean }
        expect(json.ok, 'the /api/support matrix must report ok').toBe(true)

        // THE REAL PROOF: poll PostHog until the server-captured event lands.
        // 420s ceiling for the slow ingestion window (see the helper's note).
        // testScenario scopes the poll to THIS test's events — without it the
        // poll returns on any sibling test's row (see the helper's doc).
        const rows = await queryEventsByTestRun({
            testRunId: TEST_RUN_ID,
            event: 'support_request_submitted',
            testScenario: scenario,
            timeoutMs: 420_000,
        })
        expect(
            rows.length,
            'at least one support_request_submitted event must have ingested',
        ).toBeGreaterThanOrEqual(1)

        const match = rows.find(
            r => r.properties.feedback_id === sent.feedback_id,
        )
        expect(
            match,
            `an ingested event must carry the sent feedback_id ${sent.feedback_id}`,
        ).toBeTruthy()
        expect(match?.properties.app_id).toBe('caramel')
        expect(match?.properties.environment).toBe('e2e')
        expect(match?.properties.test_run_id).toBe(TEST_RUN_ID)
    })

    test('browser identity ($identify) ingests with the synthetic distinct_id', async ({
        page,
    }, testInfo) => {
        const scenario = scenarioFor(testInfo.title)
        const expectedDistinctId = distinctIdFor(scenario)

        // We verify the $identify event — the deterministic browser-side proof
        // of the synthetic identity. On every load the app's initPosthogBrowser
        // registers test_run_id as a super prop and then calls
        // posthog.identify(<synthetic distinct_id>), so $identify ALWAYS carries
        // both (verified directly against ingested rows). Deliberately NOT
        // $pageview (fires inside posthog.init BEFORE identify → sometimes lands
        // anonymous) and NOT $autocapture (a single control-button click does
        // not reliably emit one), and NOT a hand-rolled marker (this ESM build
        // of posthog-js doesn't expose window.posthog, so page-context
        // posthog.capture() isn't callable). The follow-up navigation flushes
        // the queued $identify via pageleave → sendBeacon.
        await page.goto('/support')
        await waitForPosthogActive(page)
        await page.goto('/')

        // 420s ceiling: a slow window lags the browser path as much as the
        // server path (see the helper's note). testScenario is the fix for the
        // deterministic CI failure this spec had from birth: the sibling
        // ingestion test also emits $identify under the same test_run_id, so an
        // unscoped poll returned ITS minutes-old row instantly while this
        // test's own $identify was still ingesting — and the distinct_id
        // assertion then ran against the wrong test's event, every time.
        const rows = await queryEventsByTestRun({
            testRunId: TEST_RUN_ID,
            event: '$identify',
            testScenario: scenario,
            timeoutMs: 420_000,
        })
        expect(
            rows.length,
            'at least one $identify must have ingested with this run’s super prop',
        ).toBeGreaterThanOrEqual(1)
        expect(
            rows.some(r => r.distinctId === expectedDistinctId),
            `an ingested $identify must carry the synthetic distinct_id ${expectedDistinctId}`,
        ).toBe(true)
        expect(rows[0]?.properties.app_id).toBe('caramel')
        expect(rows[0]?.properties.environment).toBe('e2e')
    })
})

test.describe('Support flow — double-submit + retry (UI stub)', () => {
    // No creds, no DB: the API is stubbed with page.route, so this is fully
    // deterministic and deployment-safe (runs on the live site too). It does
    // NOT depend on PostHog being active.
    test('double-submit is prevented and a retry reuses the same feedback_id', async ({
        page,
    }) => {
        const feedbackIds: string[] = []
        // The first response is HELD open (a deferred promise the test releases)
        // so the in-flight disabled state is observed deterministically — no
        // reliance on a race against a fixed delay. Wrapped in an object so the
        // closure assignment doesn't trip TS's narrow-to-never on a plain let.
        const gate: { release: () => void } = { release: () => {} }
        const firstHeld = new Promise<void>(resolve => {
            gate.release = resolve
        })
        let call = 0
        await page.route('**/api/support', async route => {
            const body = JSON.parse(route.request().postData() ?? '{}') as {
                feedback_id?: string
            }
            feedbackIds.push(body.feedback_id ?? '')
            call += 1
            if (call === 1) await firstHeld
            await route.fulfill({
                status: 502,
                contentType: 'application/json',
                body: JSON.stringify({
                    ok: false,
                    analytics: 'failed',
                    email: 'failed',
                    feedback_id: body.feedback_id,
                }),
            })
        })

        await page.goto('/support')
        // Locate by the stable submit type, NOT the accessible name: the button
        // label flips from "Send feedback" to "Sending…" while loading, so a
        // name-based locator would stop matching exactly when we assert the
        // disabled (in-flight) state.
        const submitBtn = page.locator('button[type="submit"]')
        await page
            .getByRole('textbox', { name: 'Your message' })
            .fill('Double-submit retry probe')

        // First submit → the button disables while the (held) request is in
        // flight. That disabled state IS the double-submit prevention (plus the
        // `if (loading) return` guard); a second submit cannot fire while it's
        // held, which is exactly what the single captured request proves.
        await submitBtn.click()
        await expect(submitBtn).toBeDisabled()
        expect(feedbackIds).toHaveLength(1)

        // Release → 502 (both legs failed) → error toast, and NOTHING is lost.
        gate.release()
        await expect(page.getByText(/nothing was lost/i)).toBeVisible({
            timeout: 5000,
        })

        // Form state preserved for the retry (message intact, button re-enabled).
        await expect(
            page.getByRole('textbox', { name: 'Your message' }),
        ).toHaveValue('Double-submit retry probe')
        await expect(submitBtn).toBeEnabled()

        // Retry → a SECOND request with the SAME feedback_id (idempotent retry).
        await submitBtn.click()
        await expect.poll(() => feedbackIds.length, { timeout: 5000 }).toBe(2)
        expect(feedbackIds[0]).toBeTruthy()
        expect(feedbackIds[1]).toBe(feedbackIds[0])

        await page.unroute('**/api/support')
    })
})
