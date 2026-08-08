import EmailLayout, { EmailButton, EmailNotice, text } from './EmailLayout'

interface ResetPasswordEmailProps {
    url: string
}

export default function ResetPasswordTemplate({
    url,
}: ResetPasswordEmailProps) {
    return (
        <EmailLayout previewText="Reset your Caramel password">
            <h1 style={text.heading}>Reset your password</h1>
            <p style={text.body}>
                We received a request to reset the password for your Caramel
                account. Click the button below to choose a new one.
            </p>

            <EmailButton href={url}>Reset Password</EmailButton>

            <EmailNotice>
                This link expires in <strong>1 hour</strong> and can only be
                used once. If you didn&apos;t request a password reset, you can
                safely ignore this email — your password will not change.
            </EmailNotice>

            <div style={text.divider} />

            <p style={text.small}>
                If the button doesn&apos;t work, copy and paste this link into
                your browser:
            </p>
            <p
                style={{
                    ...text.small,
                    wordBreak: 'break-all' as const,
                    color: '#ea6925',
                    marginTop: '6px',
                }}
            >
                {url}
            </p>
        </EmailLayout>
    )
}
