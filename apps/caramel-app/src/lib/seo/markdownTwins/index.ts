import { markdownLink, markdownText, type MarkdownPageContent } from './content'
import { guidePageBuilders } from './guidePages'
import { MARKDOWN_ORIGIN, MARKDOWN_TWIN_PATHS } from './registry.mjs'
import { staticPageBuilders } from './staticPages'
import { createStoreMarkdownBuilder } from './storePage'

const pageBuilders: Record<
    string,
    () => MarkdownPageContent | Promise<MarkdownPageContent>
> = {
    ...staticPageBuilders,
    ...guidePageBuilders,
}

export async function markdownTwinResponse(path: string[]): Promise<Response> {
    const htmlPath =
        path.length === 1 && path[0] === 'index' ? '/' : `/${path.join('/')}`
    const builder =
        Object.prototype.hasOwnProperty.call(pageBuilders, htmlPath) &&
        MARKDOWN_TWIN_PATHS.includes(htmlPath)
            ? pageBuilders[htmlPath]
            : undefined
    const store =
        !builder && path.length === 2 && path[0] === 'coupons'
            ? await createStoreMarkdownBuilder()(path[1])
            : null
    const content = builder ? await builder() : store
    if (!content) {
        return new Response('Not found\n', {
            status: 404,
            headers: {
                'Content-Type': 'text/plain; charset=utf-8',
                Vary: 'Accept',
            },
        })
    }
    const canonical = `${MARKDOWN_ORIGIN}${store?.canonicalPath ?? htmlPath}`
    return new Response(
        [
            markdownLink('Canonical HTML', canonical),
            `# ${markdownText(content.title)}`,
            markdownText(content.summary),
            content.body,
            '',
        ].join('\n\n'),
        {
            headers: {
                'Content-Type': 'text/markdown; charset=utf-8',
                Link: `<${canonical}>; rel="canonical"`,
                Vary: 'Accept',
            },
        },
    )
}
