import type { ErrorEvent } from '@sentry/nextjs'
import { describe, expect, it } from 'vitest'

import {
    EXTENSION_VERSION_TAG,
    tagExtensionVersion,
} from '@/lib/sentryExtensionVersion'

// T-10681: CARAMEL-1D comes from the extension's content script on our own
// pages, and only the extension's version tells an old build from a fixed one.
const html = (stamp: string | null) => ({ getAttribute: () => stamp })
const event = (): ErrorEvent => ({ type: undefined, tags: { handled: 'no' } })

describe('tagExtensionVersion', () => {
    it('tags the event with the version the extension stamped on <html>', () => {
        const tagged = tagExtensionVersion(event(), html('1.4.36'))

        expect(tagged.tags).toEqual({
            handled: 'no',
            [EXTENSION_VERSION_TAG]: '1.4.36',
        })
    })

    it('adds nothing when no extension stamped the page', () => {
        expect(tagExtensionVersion(event(), html(null)).tags).toEqual({
            handled: 'no',
        })
        expect(tagExtensionVersion(event(), null).tags).toEqual({
            handled: 'no',
        })
    })

    it('ignores a stamp that is not a version', () => {
        const tagged = tagExtensionVersion(event(), html('<script>x</script>'))

        expect(tagged.tags).toEqual({ handled: 'no' })
    })
})
