import { safeReturnPath } from '@/lib/auth/safeReturnPath'
import { describe, expect, it } from 'vitest'

describe('safeReturnPath', () => {
    it('returns / for undefined or null', () => {
        expect(safeReturnPath(undefined)).toBe('/')
        expect(safeReturnPath(null)).toBe('/')
        expect(safeReturnPath('')).toBe('/')
    })

    it('accepts a simple relative path', () => {
        expect(safeReturnPath('/profile')).toBe('/profile')
        expect(safeReturnPath('/coupons/amazon.com')).toBe(
            '/coupons/amazon.com',
        )
    })

    it('accepts paths with query strings', () => {
        expect(safeReturnPath('/coupons?page=2')).toBe('/coupons?page=2')
    })

    it('rejects absolute URLs (open redirect)', () => {
        expect(safeReturnPath('https://evil.com')).toBe('/')
        expect(safeReturnPath('http://evil.com/path')).toBe('/')
    })

    it('rejects protocol-relative URLs', () => {
        expect(safeReturnPath('//evil.com')).toBe('/')
        expect(safeReturnPath('//evil.com/path')).toBe('/')
    })

    it('rejects scheme injection via colon', () => {
        expect(safeReturnPath('/javascript:alert(1)')).toBe('/')
    })

    it('rejects redirect loops to login/signup', () => {
        expect(safeReturnPath('/login')).toBe('/')
        expect(safeReturnPath('/login?next=/profile')).toBe('/')
        expect(safeReturnPath('/signup')).toBe('/')
    })

    it('trims whitespace', () => {
        expect(safeReturnPath('  /profile  ')).toBe('/profile')
    })
})
