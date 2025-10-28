import '@/styles/globals.css'
import { ReactNode } from 'react'
import Providers from './providers'

export const metadata = {
    title: 'Caramel | The Trusted Alternative To Honey For Finding Coupons',
    description:
        "The open-source & privacy-first extension that automatically finds and applies the best coupon codes at checkout without selling your data or hijacking creators' commissions.",
    metadataBase: new URL(
        process.env.NEXT_PUBLIC_BASE_URL || 'https://grabcaramel.com',
    ),
    openGraph: {
        type: 'website',
        title: 'Caramel | The Trusted Alternative To Honey For Finding Coupons',
        description:
            "The open-source & privacy-first extension that automatically finds and applies the best coupon codes at checkout without selling your data or hijacking creators' commissions.",
        url: '/',
        images: ['/caramel_banner.png'],
    },
    icons: {
        icon: '/favicon.ico',
    },
    manifest: '/manifest.json',
}

export default function RootLayout({ children }: { children: ReactNode }) {
    return (
        <html lang="en">
            <body>
                <Providers>{children}</Providers>
            </body>
        </html>
    )
}
