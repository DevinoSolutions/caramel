import EmailLayout, { brand, EmailNotice, text } from './EmailLayout'

/**
 * The operator-facing notification for a support-form submission.
 *
 * This email used to be plain text dropped straight into the HTML body (see
 * `src/lib/email.ts`), so every line break collapsed and the whole report
 * arrived as one unstyled run-on paragraph. The fields are structured here
 * instead, and the plain-text version travels alongside as the real text part.
 *
 * Everything interpolated is USER INPUT or user-influenced. It is rendered as
 * JSX text children, never as `dangerouslySetInnerHTML`, so React escapes it —
 * a report whose message contains `<script>` or `<img onerror=…>` arrives as
 * the literal characters the user typed. `renderMessage` preserves newlines
 * with real <br/> elements rather than by injecting markup.
 */

export interface SupportNotificationProps {
    feedbackId: string
    feedbackType: string
    wantsReply: boolean
    message: string
    expectedOutcome?: string
    appLabel: string
    environment: string
    platform: string
    route: string
    userLabel: string
    posthogSessionId?: string
    posthogDistinctId?: string
    sentryEventId?: string
    sentryUrl?: string
}

/** Preserve the author's line breaks as <br/> — never by injecting markup. */
function renderMessage(value: string) {
    const lines = value.split('\n')
    return lines.map((line, index) => (
        <span key={index}>
            {line}
            {index < lines.length - 1 ? <br /> : null}
        </span>
    ))
}

const panel = {
    backgroundColor: brand.bg,
    border: `1px solid ${brand.border}`,
    borderRadius: '10px',
    padding: '16px 18px',
    fontSize: '15px',
    lineHeight: '25px',
    color: brand.textPrimary,
    margin: '0 0 24px',
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-word' as const,
}

const sectionLabel = {
    color: brand.textMuted,
    fontSize: '12px',
    fontWeight: 700 as const,
    letterSpacing: '0.7px',
    lineHeight: '18px',
    margin: '0 0 8px',
    textTransform: 'uppercase' as const,
}

const contextCell = {
    fontSize: '13px',
    lineHeight: '20px',
    padding: '5px 0',
    color: brand.textSecondary,
    verticalAlign: 'top' as const,
}

/** One label/value row in the context block. Values wrap rather than overflow. */
function ContextRow({ label, value }: { label: string; value: string }) {
    return (
        <tr>
            <td style={{ ...contextCell, width: '38%', fontWeight: 600 }}>
                {label}
            </td>
            <td
                style={{
                    ...contextCell,
                    color: brand.textPrimary,
                    wordBreak: 'break-word',
                }}
            >
                {value}
            </td>
        </tr>
    )
}

export default function SupportNotificationTemplate(
    props: SupportNotificationProps,
) {
    const {
        feedbackId,
        feedbackType,
        wantsReply,
        message,
        expectedOutcome,
        appLabel,
        environment,
        platform,
        route,
        userLabel,
        posthogSessionId,
        posthogDistinctId,
        sentryEventId,
        sentryUrl,
    } = props

    // The inbox preview line: the type plus the opening of what they wrote,
    // so a triage decision is possible without opening the mail.
    const preview = `${feedbackType} — ${message.slice(0, 90)}`

    return (
        <EmailLayout
            previewText={preview}
            footerNote={
                wantsReply
                    ? 'Reply to this email and your response goes straight to the customer.'
                    : undefined
            }
        >
            <h1 style={text.heading}>New support request</h1>

            <table
                role="presentation"
                width="100%"
                cellPadding={0}
                cellSpacing={0}
                style={{ margin: '0 0 24px' }}
            >
                <tbody>
                    <tr>
                        <td>
                            <span
                                style={{
                                    backgroundColor: brand.orangeSoft,
                                    border: `1px solid ${brand.orangeGlow}`,
                                    borderRadius: '999px',
                                    color: brand.orangeDark,
                                    display: 'inline-block',
                                    fontSize: '12px',
                                    fontWeight: 700,
                                    letterSpacing: '0.4px',
                                    padding: '5px 14px',
                                    textTransform: 'uppercase',
                                }}
                            >
                                {feedbackType}
                            </span>
                            <span
                                style={{
                                    color: brand.textMuted,
                                    fontSize: '13px',
                                    paddingLeft: '10px',
                                }}
                            >
                                {wantsReply
                                    ? 'Wants a reply'
                                    : 'No reply requested'}
                            </span>
                        </td>
                    </tr>
                </tbody>
            </table>

            {wantsReply ? (
                <EmailNotice>
                    This customer asked for a reply. Replying to this email
                    reaches them directly.
                </EmailNotice>
            ) : null}

            <div style={{ height: wantsReply ? '24px' : '0' }} />

            <p style={sectionLabel}>Message</p>
            <div style={panel}>{renderMessage(message)}</div>

            {expectedOutcome ? (
                <>
                    <p style={sectionLabel}>Expected outcome</p>
                    <div style={panel}>{renderMessage(expectedOutcome)}</div>
                </>
            ) : null}

            {sentryUrl && sentryEventId ? (
                <>
                    <p style={sectionLabel}>Error report</p>
                    <p style={{ ...text.body, margin: '0 0 24px' }}>
                        <a href={sentryUrl} style={text.link}>
                            Open Sentry event {sentryEventId}
                        </a>
                    </p>
                </>
            ) : null}

            <div style={text.divider} />

            <p style={sectionLabel}>Context</p>
            <table
                role="presentation"
                width="100%"
                cellPadding={0}
                cellSpacing={0}
            >
                <tbody>
                    <ContextRow label="Feedback ID" value={feedbackId} />
                    <ContextRow label="App" value={appLabel} />
                    <ContextRow label="Environment" value={environment} />
                    <ContextRow label="Platform" value={platform} />
                    <ContextRow label="Route" value={route} />
                    <ContextRow label="User" value={userLabel} />
                    {posthogSessionId ? (
                        <ContextRow
                            label="PostHog session"
                            value={posthogSessionId}
                        />
                    ) : null}
                    {posthogDistinctId ? (
                        <ContextRow
                            label="PostHog distinct id"
                            value={posthogDistinctId}
                        />
                    ) : null}
                </tbody>
            </table>
        </EmailLayout>
    )
}
