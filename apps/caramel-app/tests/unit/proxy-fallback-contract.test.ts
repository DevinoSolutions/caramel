import { describe, expect, it } from 'vitest'

import {
    buildProxyFallbackHeaders,
    isValidFallbackAfterSeconds,
    isValidFallbackKey,
    isValidFallbackModel,
} from '@/lib/proxy-fallback-headers'

const KEY = 'sk-or-v1-' + 'test000000000000000000000000'
const PROXY = 'https://proxyai.devino.ca/v1'
const build = (
    input: Partial<Parameters<typeof buildProxyFallbackHeaders>[0]> = {},
) =>
    buildProxyFallbackHeaders({
        baseUrl: PROXY,
        key: KEY,
        model: undefined,
        afterSeconds: undefined,
        ...input,
    })

describe('the canonical paid fallback contract', () => {
    it('sends the key, model and normalized wait only to the HTTPS proxy', () => {
        expect(
            build({
                model: 'deepseek/deepseek-v4.1-flash',
                afterSeconds: '7.50',
            }),
        ).toEqual({
            'X-ORF-Fallback-Key': KEY,
            'X-ORF-Fallback-Model': 'deepseek/deepseek-v4.1-flash',
            'X-ORF-Fallback-After': '7.5',
        })
    })
    it('defaults the wait to eight seconds with only a key', () => {
        expect(build()).toEqual({
            'X-ORF-Fallback-Key': KEY,
            'X-ORF-Fallback-After': '8',
        })
    })
    it('sends nothing without a key', () => {
        for (const key of [undefined, '', '   '])
            expect(build({ key })).toEqual({})
    })
    it('ignores malformed keys without throwing', () => {
        for (const key of ['wrong', `${KEY}\ninner`, `${KEY}é`])
            expect(build({ key })).toEqual({})
    })
    it('withholds the key from every other host, HTTP and invalid URLs', () => {
        for (const baseUrl of [
            'https://openrouter.ai/api/v1',
            'https://eu.openrouter.ai./api/v1',
            'http://proxyai.devino.ca/v1',
            'https://proxyai.devino.ca.evil.com/v1',
            'https://gateway.example.com/openrouter.ai/v1',
            'not a URL',
            '',
            undefined,
        ])
            expect(build({ baseUrl })).toEqual({})
    })
    it('accepts proxy host case and one trailing dot', () => {
        expect(build({ baseUrl: 'https://PROXYAI.devino.ca./v1' })).toEqual(
            build(),
        )
    })
    it('uses the safe wait for malformed numbers and normalizes leading zeroes', () => {
        for (const afterSeconds of [
            '1e3',
            '0x10',
            '-5',
            '0',
            'abc',
            '301',
            '08',
        ])
            expect(build({ afterSeconds })['X-ORF-Fallback-After']).toBe('8')
    })
    it('drops an invalid model without dropping the key', () => {
        expect(build({ model: 'bad model' })).toEqual(build())
    })
    it('allows blank env values and refuses malformed key, model and wait', () => {
        for (const predicate of [
            isValidFallbackKey,
            isValidFallbackModel,
            isValidFallbackAfterSeconds,
        ]) {
            expect(predicate(undefined)).toBe(true)
            expect(predicate('  ')).toBe(true)
        }
        expect(isValidFallbackKey(KEY)).toBe(true)
        expect(isValidFallbackKey(`${KEY}\ninner`)).toBe(false)
        expect(isValidFallbackModel('bad model')).toBe(false)
        for (const raw of ['1e3', '0x10', '-5', '0', 'abc', '301'])
            expect(isValidFallbackAfterSeconds(raw)).toBe(false)
        expect(isValidFallbackAfterSeconds('7.50')).toBe(true)
    })
})
