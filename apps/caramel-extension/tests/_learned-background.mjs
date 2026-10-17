// The background's side of the learned-box messages (background.js
// couponBoxLearnedMessage, couponBoxLearnedBox, couponBoxLearnHold,
// couponBoxLearnTake), for content-script tests: the same module functions
// against the test's storage area, always for the page's own host, never a
// domain the message names. The flag gate and the server report are pinned
// in tests/background-coupon-box-pick.test.mjs.
import {
    caramelLearnedOutcome,
    caramelLearnedRead,
} from '../coupon-box-learned.js'

export const LEARNED_ACTIONS = [
    'couponBoxLearned',
    'couponBoxLearnedBox',
    'couponBoxLearnHold',
    'couponBoxLearnTake',
]

// reported: receives every report the background would send to the server.
// holds: the per-tab hold (one tab here), kept across page loads of a test.
export function learnedBackground(area, reported, holds = new Map()) {
    return async message => {
        const host = location.hostname
        switch (message.action) {
            case 'couponBoxLearnedBox':
                return { box: await caramelLearnedRead(area, host) }
            case 'couponBoxLearned': {
                const saved = await caramelLearnedOutcome(
                    area,
                    host,
                    message.box,
                    message.source,
                    message.outcome,
                    Date.now(),
                )
                if (message.report === true && saved !== 'refused')
                    reported.push({ ...message, domain: host })
                return { saved, ok: true }
            }
            case 'couponBoxLearnHold':
                holds.set(host, message.l)
                return { held: true }
            case 'couponBoxLearnTake': {
                const l = holds.get(host) ?? null
                holds.delete(host)
                return { l }
            }
        }
    }
}
