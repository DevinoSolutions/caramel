import { Fragment } from 'react'

/**
 * Splits text into segments that end at a URL boundary: after a path `/`
 * (never between the two slashes of a scheme `//`, never a leading `/`),
 * after the closing slash of a scheme `//`, after `?`, and after `&`.
 *
 * The break after "https://" matters on a staging host: at 320px,
 * "https://dev.grabcaramel.com/" is wider than the code box in a Linux
 * monospace font and the browser broke it between letters ("caramel.co|m").
 * With the host in its own segment it only has to fit "dev.grabcaramel.com/".
 */
export function urlBreakSegments(text: string): string[] {
    const segments: string[] = []
    let start = 0
    for (let i = 0; i < text.length; i++) {
        const ch = text[i]
        const isPathSlash =
            ch === '/' && i > 0 && text[i - 1] !== '/' && text[i + 1] !== '/'
        const isSchemeEnd =
            ch === '/' &&
            text[i - 1] === '/' &&
            text[i - 2] === ':' &&
            text[i + 1] !== '/'
        if (isPathSlash || isSchemeEnd || ch === '?' || ch === '&') {
            segments.push(text.slice(start, i + 1))
            start = i + 1
        }
    }
    if (start < text.length) segments.push(text.slice(start))
    return segments
}

/**
 * Renders a sentence or shell command containing a long URL so that, on a
 * narrow screen, it wraps at URL boundaries ("https://" | "grabcaramel.com/" |
 * "agent-setup/" | "prompt.md") instead of mid-word or by scrolling
 * sideways. The break points are <wbr> elements, which add no characters:
 * selecting and copying the text still yields the exact original string.
 *
 * Pair it with `whitespace-pre-wrap break-words` on the enclosing <pre> so
 * spaces also wrap and a segment wider than the box still can't overflow.
 */
export default function UrlBreakableText({ text }: { text: string }) {
    return (
        <>
            {urlBreakSegments(text).map((segment, index) => (
                <Fragment key={index}>
                    {index > 0 && <wbr />}
                    {segment}
                </Fragment>
            ))}
        </>
    )
}
