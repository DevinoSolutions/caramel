import { markdownTwinResponse } from '@/lib/seo/markdownTwins'

// Public document, like llms-full.txt; not the withRoute JSON API surface.
// Catalog twins must be as fresh as the dynamic HTML store page.
export const dynamic = 'force-dynamic'

export async function GET(
    _request: Request,
    context: { params: Promise<{ path: string[] }> },
): Promise<Response> {
    const { path } = await context.params
    return markdownTwinResponse(path)
}
