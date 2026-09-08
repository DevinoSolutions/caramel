import EmailLayout, { EmailButton, text } from './EmailLayout'

interface StoreSupportedEmailProps {
    /** Bare host of the store the person asked for, e.g. `worldofbooks.com`. */
    domain: string
    /** Absolute URL of that store's page on the site. Built by the caller from
     * BASE_URL — never assembled here, so the text part and this HTML part can
     * never point at different places. */
    storeUrl: string
}

/**
 * "The store you asked for is now supported."
 *
 * The ONLY mail this product sends to someone because of a site suggestion, and
 * it is sent at most once per requester email per domain. Short and plain on
 * purpose: they asked a question months ago and this is the answer, not a
 * campaign — no offers, no cross-sell, no other stores.
 */
export default function StoreSupportedTemplate({
    domain,
    storeUrl,
}: StoreSupportedEmailProps) {
    return (
        <EmailLayout previewText={`${domain} is now supported in Caramel`}>
            <h1 style={text.heading}>{domain} is now supported</h1>
            <p style={text.body}>
                You asked us to support <strong>{domain}</strong>. It is live
                now, so Caramel will find and test coupon codes for you the next
                time you check out there.
            </p>

            <EmailButton href={storeUrl}>See {domain} codes</EmailButton>

            <div style={text.divider} />

            <p style={text.small}>Thanks for the suggestion.</p>
        </EmailLayout>
    )
}
