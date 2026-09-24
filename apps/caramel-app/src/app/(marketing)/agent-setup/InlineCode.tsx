import { Fragment } from 'react'

/**
 * Renders a manifest string that uses markdown-style `code` spans (the same
 * text prompt.md serves raw) as HTML: odd segments between backticks become
 * <code>. Keeps agentSetup.config.ts the single source for both surfaces.
 */
export default function InlineCode({ text }: { text: string }) {
    return (
        <>
            {text
                .split('`')
                .map((segment, index) =>
                    index % 2 === 1 ? (
                        <code key={index}>{segment}</code>
                    ) : (
                        <Fragment key={index}>{segment}</Fragment>
                    ),
                )}
        </>
    )
}
