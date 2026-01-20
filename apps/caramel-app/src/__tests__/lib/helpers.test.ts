import { describe, expect, it } from 'vitest'

/**
 * Get user initial from name or email
 */
export function getUserInitial(name?: string | null, email?: string): string {
    if (name && name.length > 0) {
        return name.charAt(0).toUpperCase()
    }
    if (email && email.length > 0) {
        return email.charAt(0).toUpperCase()
    }
    return 'U'
}

/**
 * Format member since date
 */
export function formatMemberSince(date?: Date | null): string {
    if (!date) {
        return 'Recently'
    }

    const options: Intl.DateTimeFormatOptions = {
        year: 'numeric',
        month: 'long',
    }
    return new Date(date).toLocaleDateString('en-US', options)
}

describe('Auth Helper Utilities', () => {
    describe('getUserInitial', () => {
        it('should return first letter of name when available', () => {
            expect(getUserInitial('Test User', 'test@example.com')).toBe('T')
        })

        it('should return first letter of email when no name', () => {
            expect(getUserInitial(null, 'test@example.com')).toBe('T')
        })

        it('should return "U" when neither name nor email', () => {
            expect(getUserInitial(null, '')).toBe('U')
        })

        it('should return uppercase letter', () => {
            expect(getUserInitial('alice', 'alice@example.com')).toBe('A')
        })

        it('should handle empty name and use email', () => {
            expect(getUserInitial('', 'email@example.com')).toBe('E')
        })

        it('should handle undefined name', () => {
            expect(getUserInitial(undefined, 'email@example.com')).toBe('E')
        })

        it('should handle single character names', () => {
            expect(getUserInitial('A', 'email@example.com')).toBe('A')
        })

        it('should handle names with spaces', () => {
            expect(getUserInitial('John Doe', 'john@example.com')).toBe('J')
        })

        it('should handle names with special characters', () => {
            expect(getUserInitial('Ángel García', 'angel@example.com')).toBe(
                'Á',
            )
        })

        it('should handle lowercase email', () => {
            expect(getUserInitial(null, 'email@example.com')).toBe('E')
        })
    })

    describe('formatMemberSince', () => {
        it('should format date as "Month Year"', () => {
            const date = new Date('2024-01-15')
            const result = formatMemberSince(date)
            expect(result).toBe('January 2024')
        })

        it('should return "Recently" for null date', () => {
            expect(formatMemberSince(null)).toBe('Recently')
        })

        it('should return "Recently" for undefined date', () => {
            expect(formatMemberSince(undefined)).toBe('Recently')
        })

        it('should handle different months correctly', () => {
            const marchDate = new Date('2024-03-10')
            expect(formatMemberSince(marchDate)).toBe('March 2024')

            const decemberDate = new Date('2023-12-25')
            expect(formatMemberSince(decemberDate)).toBe('December 2023')
        })

        it('should handle different years correctly', () => {
            const date2020 = new Date('2020-06-01')
            expect(formatMemberSince(date2020)).toBe('June 2020')

            const date2025 = new Date('2025-09-15')
            expect(formatMemberSince(date2025)).toBe('September 2025')
        })

        it('should handle dates at year boundaries', () => {
            const janDate = new Date('2024-01-01')
            expect(formatMemberSince(janDate)).toBe('January 2024')

            const decDate = new Date('2024-12-31')
            expect(formatMemberSince(decDate)).toBe('December 2024')
        })

        it('should handle recent dates', () => {
            const today = new Date()
            const result = formatMemberSince(today)
            expect(result).toMatch(
                /^(January|February|March|April|May|June|July|August|September|October|November|December) \d{4}$/,
            )
        })

        it('should handle old dates', () => {
            const oldDate = new Date('2010-05-20')
            expect(formatMemberSince(oldDate)).toBe('May 2010')
        })
    })
})
