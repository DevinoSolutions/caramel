import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import PasswordChecker from '@/components/PasswordStrength/PasswordChecker'

describe('PasswordChecker', () => {
    describe('Password Rules Validation', () => {
        it('should check minimum length (5 characters)', () => {
            render(<PasswordChecker password="Test" confirmPassword="Test" />)

            expect(
                screen.getByText('At least 5 characters required'),
            ).toBeInTheDocument()

            render(
                <PasswordChecker password="Test1" confirmPassword="Test1" />,
            )

            expect(
                screen.getByText('The minimum length is reached'),
            ).toBeInTheDocument()
        })

        it('should check for uppercase letter', () => {
            render(
                <PasswordChecker
                    password="test123!"
                    confirmPassword="test123!"
                />,
            )

            expect(
                screen.getByText('At least one uppercase letter required'),
            ).toBeInTheDocument()
        })

        it('should validate uppercase letter is present', () => {
            render(
                <PasswordChecker
                    password="Test123!"
                    confirmPassword="Test123!"
                />,
            )

            expect(
                screen.getByText('At least one uppercase letter'),
            ).toBeInTheDocument()
        })

        it('should check for number', () => {
            render(
                <PasswordChecker
                    password="TestAbc!"
                    confirmPassword="TestAbc!"
                />,
            )

            expect(
                screen.getByText('At least one number required'),
            ).toBeInTheDocument()
        })

        it('should validate number is present', () => {
            render(
                <PasswordChecker
                    password="Test123!"
                    confirmPassword="Test123!"
                />,
            )

            expect(screen.getByText('At least one number')).toBeInTheDocument()
        })

        it('should check for special character', () => {
            render(
                <PasswordChecker
                    password="Test1234"
                    confirmPassword="Test1234"
                />,
            )

            expect(
                screen.getByText('At least special character required'),
            ).toBeInTheDocument()
        })

        it('should validate special character is present', () => {
            render(
                <PasswordChecker
                    password="Test123!"
                    confirmPassword="Test123!"
                />,
            )

            expect(
                screen.getByText('At least special character'),
            ).toBeInTheDocument()
        })

        it('should check if passwords match', () => {
            render(
                <PasswordChecker
                    password="Test123!"
                    confirmPassword="Different123!"
                />,
            )

            expect(
                screen.getByText('Passwords must match'),
            ).toBeInTheDocument()
        })

        it('should validate passwords match', () => {
            render(
                <PasswordChecker
                    password="Test123!"
                    confirmPassword="Test123!"
                />,
            )

            expect(screen.getByText('Passwords match')).toBeInTheDocument()
        })

        it('should not show passwords match when password is empty', () => {
            render(<PasswordChecker password="" confirmPassword="" />)

            expect(
                screen.getByText('Passwords must match'),
            ).toBeInTheDocument()
        })
    })

    describe('Multiple Validation Rules', () => {
        it('should show all failures for weak password', () => {
            render(<PasswordChecker password="test" confirmPassword="test" />)

            expect(
                screen.getByText('At least 5 characters required'),
            ).toBeInTheDocument()
            expect(
                screen.getByText('At least one uppercase letter required'),
            ).toBeInTheDocument()
            expect(
                screen.getByText('At least one number required'),
            ).toBeInTheDocument()
            expect(
                screen.getByText('At least special character required'),
            ).toBeInTheDocument()
        })

        it('should show all success for strong password', () => {
            render(
                <PasswordChecker
                    password="Test123!"
                    confirmPassword="Test123!"
                />,
            )

            expect(
                screen.getByText('The minimum length is reached'),
            ).toBeInTheDocument()
            expect(
                screen.getByText('At least one uppercase letter'),
            ).toBeInTheDocument()
            expect(screen.getByText('At least one number')).toBeInTheDocument()
            expect(
                screen.getByText('At least special character'),
            ).toBeInTheDocument()
            expect(screen.getByText('Passwords match')).toBeInTheDocument()
        })

        it('should show mixed validation states for medium password', () => {
            render(
                <PasswordChecker
                    password="Test1234"
                    confirmPassword="Test1234"
                />,
            )

            // Should pass these
            expect(
                screen.getByText('The minimum length is reached'),
            ).toBeInTheDocument()
            expect(
                screen.getByText('At least one uppercase letter'),
            ).toBeInTheDocument()
            expect(screen.getByText('At least one number')).toBeInTheDocument()
            expect(screen.getByText('Passwords match')).toBeInTheDocument()

            // Should fail this
            expect(
                screen.getByText('At least special character required'),
            ).toBeInTheDocument()
        })
    })

    describe('Password Confirmation', () => {
        it('should validate confirm password matches', () => {
            render(
                <PasswordChecker
                    password="Test123!"
                    confirmPassword="Test123!"
                />,
            )

            expect(screen.getByText('Passwords match')).toBeInTheDocument()
        })

        it('should show error when confirm password does not match', () => {
            render(
                <PasswordChecker
                    password="Test123!"
                    confirmPassword="Different!"
                />,
            )

            expect(
                screen.getByText('Passwords must match'),
            ).toBeInTheDocument()
        })

        it('should update validation when confirm password changes', () => {
            const { rerender } = render(
                <PasswordChecker
                    password="Test123!"
                    confirmPassword="Test123"
                />,
            )

            expect(
                screen.getByText('Passwords must match'),
            ).toBeInTheDocument()

            rerender(
                <PasswordChecker
                    password="Test123!"
                    confirmPassword="Test123!"
                />,
            )

            expect(screen.getByText('Passwords match')).toBeInTheDocument()
        })
    })

    describe('Special Characters', () => {
        it('should accept ! as special character', () => {
            render(
                <PasswordChecker
                    password="Test123!"
                    confirmPassword="Test123!"
                />,
            )

            expect(
                screen.getByText('At least special character'),
            ).toBeInTheDocument()
        })

        it('should accept @ as special character', () => {
            render(
                <PasswordChecker
                    password="Test123@"
                    confirmPassword="Test123@"
                />,
            )

            expect(
                screen.getByText('At least special character'),
            ).toBeInTheDocument()
        })

        it('should accept # as special character', () => {
            render(
                <PasswordChecker
                    password="Test123#"
                    confirmPassword="Test123#"
                />,
            )

            expect(
                screen.getByText('At least special character'),
            ).toBeInTheDocument()
        })

        it('should accept $ as special character', () => {
            render(
                <PasswordChecker
                    password="Test123$"
                    confirmPassword="Test123$"
                />,
            )

            expect(
                screen.getByText('At least special character'),
            ).toBeInTheDocument()
        })

        it('should accept multiple special characters', () => {
            render(
                <PasswordChecker
                    password="Test123!@#$"
                    confirmPassword="Test123!@#$"
                />,
            )

            expect(
                screen.getByText('At least special character'),
            ).toBeInTheDocument()
        })

        it('should not accept invalid special characters', () => {
            render(
                <PasswordChecker
                    password="Test123()"
                    confirmPassword="Test123()"
                />,
            )

            expect(
                screen.getByText('At least special character required'),
            ).toBeInTheDocument()
        })
    })

    describe('Real-time Validation', () => {
        it('should update validation when password changes', () => {
            const { rerender } = render(
                <PasswordChecker password="t" confirmPassword="t" />,
            )

            expect(
                screen.getByText('At least 5 characters required'),
            ).toBeInTheDocument()

            rerender(<PasswordChecker password="Test1" confirmPassword="t" />)

            expect(
                screen.getByText('The minimum length is reached'),
            ).toBeInTheDocument()
        })

        it('should show progressive validation as password is built', () => {
            const { rerender } = render(
                <PasswordChecker password="" confirmPassword="" />,
            )

            // All requirements should fail initially
            expect(
                screen.getByText('At least 5 characters required'),
            ).toBeInTheDocument()

            // Add minimum length
            rerender(<PasswordChecker password="test1" confirmPassword="" />)
            expect(
                screen.getByText('The minimum length is reached'),
            ).toBeInTheDocument()

            // Add uppercase
            rerender(<PasswordChecker password="Test1" confirmPassword="" />)
            expect(
                screen.getByText('At least one uppercase letter'),
            ).toBeInTheDocument()

            // Add special character
            rerender(<PasswordChecker password="Test1!" confirmPassword="" />)
            expect(
                screen.getByText('At least special character'),
            ).toBeInTheDocument()

            // Match passwords
            rerender(
                <PasswordChecker
                    password="Test1!"
                    confirmPassword="Test1!"
                />,
            )
            expect(screen.getByText('Passwords match')).toBeInTheDocument()
        })
    })
})
