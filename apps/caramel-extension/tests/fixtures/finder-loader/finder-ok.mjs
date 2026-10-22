// A finder module the loader accepts: it takes the content script's helpers.
export let handedOver = null
export function caramelProvideFinderHost(host) {
    handedOver = host
}
export const caramelFinderSeesBox = () => true
