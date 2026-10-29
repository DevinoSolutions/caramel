import { withoutSearchText } from '@/lib/api/withoutSearchText'
import { describe, expect, it } from 'vitest'

// T-7505: withoutSearchText scrubs the message and the stack HEADER only. A
// typed value that is also a substring of a file path or an error name must not
// rewrite the stack frames (source maps and issue grouping read them).

const FRAMES = [
    '    at couponsRepo (/app/src/lib/couponsRepo.ts:201:9)',
    '    at GET (/app/src/app/api/coupons/route.ts:88:12)',
].join('\n')

function errorWith(name: string, message: string): Error {
    const error = new Error(message)
    error.name = name
    error.stack = `${name}: ${message}\n${FRAMES}`
    return error
}

describe('withoutSearchText: stack frames stay intact', () => {
    it('a search for "coupon" does not rewrite file paths in the frames', () => {
        const safe = withoutSearchText(
            errorWith('Error', 'ILIKE failed for coupon'),
            ['coupon'],
        )

        expect(safe.message).toBe('ILIKE failed for [Filtered search text]')
        expect(safe.stack).toBe(
            `Error: ILIKE failed for [Filtered search text]\n${FRAMES}`,
        )
        expect(safe.stack).toContain('/app/src/lib/couponsRepo.ts:201:9')
    })

    it('a search for "ma" does not damage the error name or the frames', () => {
        const safe = withoutSearchText(
            errorWith('PrismaClientKnownRequestError', 'bad pattern %ma%'),
            ['ma'],
        )

        expect(safe.name).toBe('PrismaClientKnownRequestError')
        expect(safe.stack).toBe(
            `PrismaClientKnownRequestError: bad pattern %[Filtered search text]%\n${FRAMES}`,
        )
    })

    it('scrubs every header line of a multi-line message, not the frames', () => {
        const message = 'line one my-typed-text\nline two my-typed-text'
        const safe = withoutSearchText(errorWith('Error', message), [
            'my-typed-text',
        ])

        expect(safe.stack).toBe(
            `Error: line one [Filtered search text]\nline two [Filtered search text]\n${FRAMES}`,
        )
    })

    it('an error with no stack frames still gets a scrubbed header', () => {
        const error = new Error('echo my-typed-text')
        error.stack = 'Error: echo my-typed-text'
        expect(withoutSearchText(error, ['my-typed-text']).stack).toBe(
            'Error: echo [Filtered search text]',
        )
    })
})

describe('withoutSearchText: the forms a typed value takes in a message', () => {
    it('the LIKE-escaped pattern a driver echoes ("%my\\_store%" for "my_store")', () => {
        const safe = withoutSearchText(
            new Error('operator does not exist near "%my\\_store%"'),
            ['my_store'],
        )

        expect(safe.message).not.toContain('my')
        expect(safe.message).toBe(
            'operator does not exist near "%[Filtered search text]%"',
        )
    })

    it('each comma token of key_words ("red,blue" is matched as "%red%")', () => {
        const safe = withoutSearchText(new Error('bad pattern "%red%"'), [
            'red,blue',
        ])
        expect(safe.message).toBe('bad pattern "%[Filtered search text]%"')

        const second = withoutSearchText(
            new Error('ANY(ARRAY[%red%,%blue%])'),
            [' red , blue '],
        )
        expect(second.message).toBe(
            'ANY(ARRAY[%[Filtered search text]%,%[Filtered search text]%])',
        )
    })

    it('still ignores one-character tokens', () => {
        const safe = withoutSearchText(new Error('plain a failure'), ['a,b'])
        expect(safe.message).toBe('plain a failure')
    })
})
