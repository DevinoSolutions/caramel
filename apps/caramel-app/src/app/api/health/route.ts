import { withRoute } from '@/lib/api/withRoute'
import { NextResponse } from 'next/server'

// Container LIVENESS probe — the docker-compose `web` healthcheck target.
//
// Deliberately the cheapest possible handler: no DB, no catalog, no rate
// limit, no session. It answers "is the Node process accepting requests?"
// and nothing more. The Aug-13 → Sep-4 2026 outage streak was the compose
// healthcheck probing the HOMEPAGE with a 5s timeout: whenever the app was
// merely SLOW (a 1.2 MB supported-stores build, an ingest push, a scraper
// burst) the container flipped `unhealthy`, Traefik dropped its router, and
// every user got a 404 until 10 probes in a row passed again. A liveness
// probe must never depend on request latency elsewhere in the process.
//
// Dependency health (Prisma `SELECT 1`, catalog freshness) stays on the
// bearer-gated GET /api/health/db — that is the monitoring contract, NOT a
// routing decision. `no-store` so no edge/proxy ever answers for the probe.
export const GET = withRoute({ method: 'GET', routeName: 'health' }, async () =>
    NextResponse.json(
        { status: 'ok' },
        { headers: { 'Cache-Control': 'no-store' } },
    ),
)
