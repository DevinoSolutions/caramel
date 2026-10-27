import { test as base, expect, type Request } from '@playwright/test'
import {
    formatRequestEvidence,
    isHydrationCritical,
    type RequestEvidence,
} from './request-evidence'

// Every E2E spec imports `test` and `expect` from here, never `test` from
// '@playwright/test' (tests/unit/e2e-specs-import-test-from-the-request-evidence-fixture.test.ts).
//
// The one thing this `test` adds is an automatic fixture that, when a test
// FAILS (or times out), prints the sanitized list of requests the browser
// context saw go wrong: failed requests, 4xx/5xx responses, every document
// request, and hydration-critical requests still in flight when the test
// ended. It prints to the job log at the end of THAT attempt, so it is there
// before the retry and before run-e2e-push.sh's rerun. See request-evidence.ts
// for what is (and is not) ever printed. Scope: pages in the `context` fixture;
// a spec that opens its own browser.newContext() is not covered.

export { expect }

function describeRequest(request: Request, outcome: string): RequestEvidence {
    return {
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
        outcome,
    }
}

export const test = base.extend<{ requestEvidence: undefined }>({
    requestEvidence: [
        async ({ context }, use, testInfo) => {
            const inFlight = new Map<Request, RequestEvidence>()
            const seen: RequestEvidence[] = []

            context.on('request', request => {
                inFlight.set(request, describeRequest(request, 'pending'))
            })
            context.on('requestfinished', request => {
                inFlight.delete(request)
            })
            context.on('requestfailed', request => {
                inFlight.delete(request)
                seen.push(
                    describeRequest(
                        request,
                        request.failure()?.errorText ?? 'failed',
                    ),
                )
            })
            context.on('response', response => {
                const request = response.request()
                if (
                    response.status() >= 400 ||
                    request.resourceType() === 'document'
                ) {
                    seen.push(
                        describeRequest(request, String(response.status())),
                    )
                }
            })

            await use(undefined)

            if (testInfo.status === testInfo.expectedStatus) return

            const pending = [...inFlight.values()].filter(isHydrationCritical)
            const lines = formatRequestEvidence(
                `${testInfo.titlePath.filter(Boolean).join(' > ')} (attempt ${testInfo.retry + 1}, ${testInfo.status ?? 'unknown'})`,
                [...seen, ...pending],
            )
            console.log(lines.join('\n'))
        },
        { auto: true },
    ],
})
