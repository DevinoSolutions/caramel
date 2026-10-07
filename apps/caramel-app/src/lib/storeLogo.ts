// The one place a store's logo URL is built. Google's favicon service serves
// a square icon for any domain (next.config.ts allows www.google.com for
// next/image); 128px covers every place a store logo is shown, from the 24px
// landing tiles to the 56px directory cards on a 2x screen. Building the URL
// inline elsewhere is banned by tests/unit/store-logo-url.test.ts.
const STORE_LOGO_SIZE_PX = 128

export function storeLogoUrl(domain: string): string {
    return `https://www.google.com/s2/favicons?sz=${STORE_LOGO_SIZE_PX}&domain_url=${encodeURIComponent(
        domain,
    )}`
}
