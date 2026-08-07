import { withRoute } from '@/lib/api/withRoute'
import { BUILD_SHA } from '@/lib/buildInfo'
import { NextResponse } from 'next/server'

// CI polls this to prove the live site is serving the commit under test before
// running E2E against it (.github/workflows/scripts/wait-for-deploy.sh). A
// cached body would let the gate pass on the previous build, which is the
// exact failure it exists to prevent.
export const dynamic = 'force-dynamic'

// No rate limit, for the same reason health/db has none: an external poller
// must never be throttled into a false answer. Public and unauthenticated —
// the only thing disclosed is a commit of a public repository.
export const GET = withRoute({ method: 'GET', routeName: 'version' }, () =>
    NextResponse.json(
        { sha: BUILD_SHA },
        { headers: { 'Cache-Control': 'no-store' } },
    ),
)
