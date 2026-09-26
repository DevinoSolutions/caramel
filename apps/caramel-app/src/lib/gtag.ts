import { clientEnv } from '@/lib/env.client'

export const GA_TRACKING_ID = clientEnv.NEXT_PUBLIC_GOOGLE_ANALYTICS_ID

// Both helpers are no-ops without a measurement id: providers.tsx then
// renders no GA scripts, so window.gtag does not exist.
export const pageView = (url: string) => {
    if (
        GA_TRACKING_ID &&
        process.env.NODE_ENV === 'production' &&
        typeof window !== 'undefined'
    ) {
        window.gtag('config', GA_TRACKING_ID, {
            page_path: url,
        })
    }
}

type Params = {
    action: string
    event_category?: string
    event_label?: string
    value?: string
}
export const event = ({
    action,
    event_category,
    event_label,
    value,
}: Params) => {
    if (
        GA_TRACKING_ID &&
        process.env.NODE_ENV === 'production' &&
        typeof window !== 'undefined'
    ) {
        window.gtag('event', action, {
            event_category,
            event_label,
            value,
        })
    }
}
