import { BASE_URL } from '@/lib/env.client'
import React from 'react'

// Always use production URL for email assets
const PROD_URL = 'https://grabcaramel.com'
const APP_URL = BASE_URL

// Caramel brand palette
export const brand = {
    orange: '#ea6925',
    orangeDark: '#c4541a',
    orangeLight: '#f4a261',
    orangeSoft: '#fef0e6',
    orangeGlow: '#f7c59f',
    bg: '#fdf8f5',
    white: '#ffffff',
    textPrimary: '#1a1a2e',
    textSecondary: '#4a4a65',
    textMuted: '#8888a0',
    border: '#f0e4db',
    accent: '#ea6925',
    danger: '#dc2626',
}

interface EmailLayoutProps {
    children: React.ReactNode
    previewText?: string
}

export default function EmailLayout({
    children,
    previewText,
}: EmailLayoutProps) {
    return (
        <div
            style={{
                backgroundColor: brand.bg,
                fontFamily:
                    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
                margin: 0,
                padding: 0,
                width: '100%',
                WebkitTextSizeAdjust: '100%',
            }}
        >
            {previewText && (
                <div
                    style={{
                        display: 'none',
                        fontSize: '1px',
                        color: brand.bg,
                        lineHeight: '1px',
                        maxHeight: 0,
                        maxWidth: 0,
                        opacity: 0,
                        overflow: 'hidden',
                    }}
                >
                    {previewText}
                    {'‌'.repeat(120)}
                </div>
            )}

            <table
                role="presentation"
                width="100%"
                cellPadding={0}
                cellSpacing={0}
                style={{ backgroundColor: brand.bg }}
            >
                <tbody>
                    {/* Top spacer */}
                    <tr>
                        <td
                            style={{
                                backgroundColor: brand.bg,
                                height: '16px',
                                fontSize: 0,
                                lineHeight: 0,
                            }}
                        >
                            &nbsp;
                        </td>
                    </tr>
                    <tr>
                        <td align="center" style={{ padding: '0 20px 32px' }}>
                            <table
                                role="presentation"
                                width="100%"
                                cellPadding={0}
                                cellSpacing={0}
                                style={{ maxWidth: '580px' }}
                            >
                                <tbody>
                                    {/* Soft orange branded header */}
                                    <tr>
                                        <td
                                            style={{
                                                backgroundColor: '#fef0e6',
                                                backgroundImage:
                                                    'linear-gradient(135deg, #fef5ee 0%, #fef0e6 50%, #fde8d5 100%)',
                                                borderRadius: '16px 16px 0 0',
                                                padding: '44px 44px 38px',
                                                textAlign: 'center' as const,
                                            }}
                                        >
                                            <a href={APP_URL}>
                                                <img
                                                    src={`${PROD_URL}/full-logo.png`}
                                                    alt="Caramel"
                                                    height="48"
                                                    style={{
                                                        display: 'block',
                                                        margin: '0 auto',
                                                    }}
                                                />
                                            </a>
                                            <table
                                                role="presentation"
                                                width="48"
                                                cellPadding={0}
                                                cellSpacing={0}
                                                style={{
                                                    margin: '18px auto 0',
                                                }}
                                            >
                                                <tbody>
                                                    <tr>
                                                        <td
                                                            style={{
                                                                height: '3px',
                                                                backgroundColor:
                                                                    brand.orangeGlow,
                                                                borderRadius:
                                                                    '2px',
                                                                opacity: 0.6,
                                                            }}
                                                        />
                                                    </tr>
                                                </tbody>
                                            </table>
                                        </td>
                                    </tr>

                                    {/* Main content card */}
                                    <tr>
                                        <td
                                            style={{
                                                backgroundColor: brand.white,
                                                padding: '44px 44px 48px',
                                                borderLeft: `1px solid ${brand.border}`,
                                                borderRight: `1px solid ${brand.border}`,
                                            }}
                                        >
                                            {children}
                                        </td>
                                    </tr>

                                    {/* Footer */}
                                    <tr>
                                        <td
                                            style={{
                                                backgroundColor: '#f8f0eb',
                                                borderRadius: '0 0 16px 16px',
                                                padding: '32px 44px',
                                                borderLeft: `1px solid ${brand.border}`,
                                                borderRight: `1px solid ${brand.border}`,
                                                borderBottom: `1px solid ${brand.border}`,
                                            }}
                                        >
                                            <table
                                                role="presentation"
                                                width="100%"
                                                cellPadding={0}
                                                cellSpacing={0}
                                            >
                                                <tbody>
                                                    <tr>
                                                        <td align="center">
                                                            <p
                                                                style={{
                                                                    margin: '0 0 6px',
                                                                    fontSize:
                                                                        '13px',
                                                                    color: brand.textMuted,
                                                                    lineHeight:
                                                                        '20px',
                                                                }}
                                                            >
                                                                <a
                                                                    href={
                                                                        APP_URL
                                                                    }
                                                                    style={{
                                                                        color: brand.orangeLight,
                                                                        textDecoration:
                                                                            'none',
                                                                        fontWeight: 600,
                                                                    }}
                                                                >
                                                                    grabcaramel.com
                                                                </a>{' '}
                                                                &mdash; Sweet
                                                                deals, every day
                                                            </p>
                                                            <p
                                                                style={{
                                                                    margin: '0 0 6px',
                                                                    fontSize:
                                                                        '12px',
                                                                    color: brand.textMuted,
                                                                    lineHeight:
                                                                        '18px',
                                                                }}
                                                            >
                                                                This is an
                                                                automated
                                                                message from{' '}
                                                                <strong>
                                                                    no_reply@grabcaramel.com
                                                                </strong>
                                                                . Please do not
                                                                reply.
                                                            </p>
                                                            <p
                                                                style={{
                                                                    margin: 0,
                                                                    fontSize:
                                                                        '11px',
                                                                    color: '#b0b0c0',
                                                                    lineHeight:
                                                                        '16px',
                                                                }}
                                                            >
                                                                &copy;{' '}
                                                                {new Date().getFullYear()}{' '}
                                                                Caramel. All
                                                                rights reserved.
                                                            </p>
                                                        </td>
                                                    </tr>
                                                </tbody>
                                            </table>
                                        </td>
                                    </tr>
                                </tbody>
                            </table>
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>
    )
}

// Reusable CTA button
export function EmailButton({
    href,
    children,
    variant = 'primary',
}: {
    href: string
    children: React.ReactNode
    variant?: 'primary' | 'danger'
}) {
    const isPrimary = variant === 'primary'
    const bg = isPrimary ? brand.accent : brand.danger
    return (
        <table role="presentation" width="100%" cellPadding={0} cellSpacing={0}>
            <tbody>
                <tr>
                    <td align="center" style={{ padding: '16px 0 24px' }}>
                        <a
                            href={href}
                            style={{
                                display: 'inline-block',
                                backgroundColor: bg,
                                color: '#ffffff',
                                fontSize: '15px',
                                fontWeight: 600,
                                padding: '14px 40px',
                                borderRadius: '10px',
                                textDecoration: 'none',
                                lineHeight: '22px',
                                letterSpacing: '0.3px',
                                boxShadow: `0 2px 8px ${isPrimary ? 'rgba(234,105,37,0.35)' : 'rgba(220,38,38,0.3)'}`,
                            }}
                        >
                            {children}
                        </a>
                    </td>
                </tr>
            </tbody>
        </table>
    )
}

// Reusable notice box
export function EmailNotice({
    children,
    variant = 'info',
}: {
    children: React.ReactNode
    variant?: 'info' | 'warning'
}) {
    const isWarning = variant === 'warning'
    const bgColor = isWarning ? '#fef9ee' : brand.orangeSoft
    const borderColor = isWarning ? '#f59e0b' : brand.orangeLight
    const icon = isWarning ? '\u26A0\uFE0F' : '\u2139\uFE0F'
    return (
        <table role="presentation" width="100%" cellPadding={0} cellSpacing={0}>
            <tbody>
                <tr>
                    <td
                        style={{
                            backgroundColor: bgColor,
                            borderLeft: `4px solid ${borderColor}`,
                            borderRadius: '0 8px 8px 0',
                            padding: '16px 20px',
                            fontSize: '13px',
                            lineHeight: '21px',
                            color: brand.textSecondary,
                        }}
                    >
                        <span style={{ marginRight: '6px' }}>{icon}</span>
                        {children}
                    </td>
                </tr>
            </tbody>
        </table>
    )
}

// Shared text styles
export const text = {
    heading: {
        color: brand.textPrimary,
        fontSize: '26px',
        fontWeight: 700 as const,
        lineHeight: '34px',
        margin: '0 0 18px',
        letterSpacing: '-0.4px',
    },
    body: {
        color: brand.textSecondary,
        fontSize: '15px',
        lineHeight: '26px',
        margin: '0 0 24px',
    },
    small: {
        color: brand.textMuted,
        fontSize: '13px',
        lineHeight: '20px',
        margin: '0' as const,
    },
    link: {
        color: brand.accent,
        textDecoration: 'none' as const,
        fontWeight: 500 as const,
    },
    divider: {
        borderTop: `1px solid ${brand.border}`,
        margin: '28px 0',
    } as React.CSSProperties,
}
