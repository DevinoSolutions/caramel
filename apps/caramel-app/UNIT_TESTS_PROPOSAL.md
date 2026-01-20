# Unit Tests Proposal for Auth Features

## Overview

Unit tests complement E2E tests by testing individual components, functions, and logic in isolation. They run faster and help identify exactly where issues occur.

---

## 1. Authentication Utilities (`lib/auth/`)

### `lib/auth/client.test.ts`

```typescript
describe('Auth Client', () => {
    describe('signUp.email', () => {
        it('should successfully sign up with valid credentials')
        it('should throw error with invalid email format')
        it('should throw error with weak password')
        it('should throw error with duplicate email')
        it('should trim and lowercase email')
        it('should handle network errors gracefully')
    })

    describe('signIn.email', () => {
        it('should successfully sign in with valid credentials')
        it('should throw error with wrong password')
        it('should throw error with non-existent email')
        it('should handle unverified email')
    })

    describe('signIn.social', () => {
        it('should initiate Google OAuth flow')
        it('should initiate Apple OAuth flow')
        it('should redirect to callbackURL after success')
        it('should handle OAuth cancellation')
    })

    describe('signOut', () => {
        it('should clear session on sign out')
        it('should redirect to home page')
        it('should handle sign out errors')
    })

    describe('useSession', () => {
        it('should return null when not authenticated')
        it('should return user data when authenticated')
        it('should update when session changes')
        it('should handle isPending state correctly')
    })
})
```

---

## 2. Profile Page Component

### `app/(auth)/profile/ProfilePageClient.test.tsx`

```typescript
describe('ProfilePageClient', () => {
    describe('Rendering', () => {
        it('should show loading state while fetching session')
        it('should redirect to login when not authenticated')
        it('should display user information when authenticated')
        it('should show user initial when no image available')
        it('should display user image when available')
        it('should show verified badge for verified emails')
        it('should display correct status color for each status type')
    })

    describe('Edit Mode', () => {
        it('should enter edit mode when clicking Edit Profile')
        it('should show editable inputs in edit mode')
        it('should hide Edit Profile button in edit mode')
        it('should show Save and Cancel buttons in edit mode')
        it('should disable username field in edit mode')
        it('should keep email field read-only')
    })

    describe('Form Handling', () => {
        it('should update form data when typing')
        it('should restore original values on cancel')
        it('should submit updated profile data')
        it('should show loading state during submission')
        it('should display success toast on successful update')
        it('should display error toast on failed update')
        it('should exit edit mode after successful save')
    })

    describe('Sign Out', () => {
        it('should call signOut when clicking Sign Out button')
        it('should show success toast after sign out')
        it('should redirect to home after sign out')
    })

    describe('User Status Display', () => {
        it('should show green indicator for ACTIVE_USER')
        it('should show yellow indicator for NOT_VERIFIED')
        it('should show red indicator for USER_BANNED')
        it('should show orange indicator for DELETE_REQUESTED_BY_USER')
        it('should display correct status text for each status')
    })

    describe('Member Since', () => {
        it('should format createdAt date correctly')
        it('should show "Recently" when no createdAt')
    })
})
```

---

## 3. Header Component

### `layouts/Header/Header.test.tsx`

```typescript
describe('Header', () => {
    describe('Unauthenticated State', () => {
        it('should show Login button when not logged in')
        it('should show Sign Up button when not logged in')
        it('should not show profile icon when not logged in')
        it('should not show profile dropdown when not logged in')
    })

    describe('Authenticated State', () => {
        it('should show profile icon when logged in')
        it('should hide Login/Sign Up buttons when logged in')
        it('should display user initial in profile icon')
        it('should display user image in profile icon when available')
    })

    describe('Profile Dropdown', () => {
        it('should open dropdown when clicking profile icon')
        it('should close dropdown when clicking outside')
        it('should close dropdown when clicking profile icon again')
        it('should display user email in dropdown')
        it('should display Profile link in dropdown')
        it('should display Sign out button in dropdown')
        it('should navigate to profile when clicking Profile link')
        it('should call signOut when clicking Sign out')
    })

    describe('Mobile Menu', () => {
        it('should show hamburger icon on mobile')
        it('should open mobile menu when clicking hamburger')
        it(
            'should show Login/Sign Up buttons in mobile menu when not logged in',
        )
        it('should close mobile menu when clicking link')
        it('should close mobile menu when clicking outside')
    })

    describe('Button Styling', () => {
        it('should have correct styles for Login button')
        it('should have correct styles for Sign Up button')
        it('should have hover effects on buttons')
        it('should have scale transition on hover')
    })
})
```

---

## 4. Signup Page Component

### `app/(auth)/signup/SignupPageClient.test.tsx`

```typescript
describe('SignupPageClient', () => {
    describe('Form Rendering', () => {
        it('should render all form fields')
        it('should show password strength checker on focus')
        it('should hide password strength checker on blur')
        it('should display OAuth buttons')
    })

    describe('Form Validation', () => {
        it('should validate username minimum length (4 chars)')
        it('should validate email format')
        it('should validate password minimum length (5 chars)')
        it('should require uppercase letter in password')
        it('should require number in password')
        it('should require special character in password')
        it('should validate password confirmation matches')
        it('should show validation errors below fields')
    })

    describe('Form Submission', () => {
        it('should submit form with valid data')
        it('should trim and lowercase email before submission')
        it('should trim and lowercase username before submission')
        it('should show loading state during submission')
        it('should disable submit button while loading')
        it('should redirect to verify page on success')
        it('should show error toast on failure')
        it('should handle duplicate email error')
        it('should handle network errors')
    })

    describe('OAuth Integration', () => {
        it('should call Google OAuth when clicking Google button')
        it('should call Apple OAuth when clicking Apple button')
        it('should pass correct callbackURL to OAuth')
    })

    describe('Password Strength Checker', () => {
        it('should load dynamically (not SSR)')
        it('should display when password field is focused')
        it('should update as user types password')
    })
})
```

---

## 5. Login Page Component

### `app/(auth)/login/LoginPageClient.test.tsx`

```typescript
describe('LoginPageClient', () => {
    describe('Form Rendering', () => {
        it('should render email and password fields')
        it('should render submit button')
        it('should render OAuth buttons')
        it('should render "Forgot password?" link')
        it('should render "Sign up" link')
    })

    describe('Form Submission', () => {
        it('should submit form with valid credentials')
        it('should show loading state during login')
        it('should redirect to home on successful login')
        it('should show error toast on failed login')
        it('should handle wrong password error')
        it('should handle non-existent email error')
        it('should handle unverified email')
    })

    describe('OAuth Integration', () => {
        it('should call Google OAuth when clicking Google button')
        it('should call Apple OAuth when clicking Apple button')
    })

    describe('Navigation', () => {
        it('should have link to signup page')
        it('should have link to forgot password page')
    })
})
```

---

## 6. Password Strength Component

### `components/PasswordStrength/PasswordChecker.test.tsx`

```typescript
describe('PasswordChecker', () => {
    describe('Password Rules', () => {
        it('should check minimum length (5 characters)')
        it('should check for uppercase letter')
        it('should check for lowercase letter')
        it('should check for number')
        it('should check for special character')
    })

    describe('Strength Calculation', () => {
        it('should show weak for password with only lowercase')
        it('should show medium for password with lowercase and uppercase')
        it('should show strong for password meeting all criteria')
        it('should update strength in real-time as user types')
    })

    describe('Visual Indicators', () => {
        it('should show red color for weak password')
        it('should show yellow color for medium password')
        it('should show green color for strong password')
        it('should show progress bar matching strength')
    })

    describe('Rule Checklist', () => {
        it('should show checkmark for met rules')
        it('should show x for unmet rules')
        it('should update checklist as password changes')
    })
})
```

---

## 7. Utility Functions

### `lib/auth/helpers.test.ts`

```typescript
describe('Auth Helpers', () => {
    describe('getUserStatusColor', () => {
        it('should return green for ACTIVE_USER')
        it('should return yellow for NOT_VERIFIED')
        it('should return red for USER_BANNED')
        it('should return orange for DELETE_REQUESTED_BY_USER')
        it('should return gray for unknown status')
    })

    describe('getUserStatusText', () => {
        it('should return "Active" for ACTIVE_USER')
        it('should return "Not Verified" for NOT_VERIFIED')
        it('should return "Banned" for USER_BANNED')
        it('should return "Deletion Pending" for DELETE_REQUESTED_BY_USER')
        it('should return "Unknown" for invalid status')
    })

    describe('getUserInitial', () => {
        it('should return first letter of name when available')
        it('should return first letter of email when no name')
        it('should return "U" when neither name nor email')
        it('should return uppercase letter')
    })

    describe('formatMemberSince', () => {
        it('should format date as "Month Year"')
        it('should return "Recently" for null date')
        it('should return "Recently" for undefined date')
    })
})
```

---

## 8. API Route Handlers

### `app/api/user/profile/route.test.ts`

```typescript
describe('Profile API', () => {
    describe('PATCH /api/user/profile', () => {
        it('should update user profile with valid data')
        it('should require authentication')
        it('should validate name length')
        it('should validate username format')
        it('should prevent email update')
        it('should return 401 for unauthenticated requests')
        it('should return 400 for invalid data')
        it('should return 409 for duplicate username')
        it('should return updated user data on success')
    })
})
```

---

## 9. Database Operations

### `lib/prisma/user.test.ts`

```typescript
describe('User Database Operations', () => {
    describe('createUser', () => {
        it('should create user with hashed password')
        it('should set default status to NOT_VERIFIED')
        it('should set default role to USER')
        it('should create account record')
        it('should throw error for duplicate email')
        it('should throw error for duplicate username')
    })

    describe('findUserByEmail', () => {
        it('should find user by email')
        it('should return null for non-existent email')
        it('should be case-insensitive')
    })

    describe('updateUser', () => {
        it('should update user name')
        it('should update user username')
        it('should update user image')
        it('should not update email')
        it('should update updatedAt timestamp')
    })

    describe('deleteUser', () => {
        it('should cascade delete sessions')
        it('should cascade delete accounts')
        it('should remove user from database')
    })
})
```

---

## 10. Session Management

### `lib/auth/session.test.ts`

```typescript
describe('Session Management', () => {
    describe('createSession', () => {
        it('should create session with token')
        it('should set expiration date')
        it('should store user agent')
        it('should store IP address')
    })

    describe('validateSession', () => {
        it('should return valid session if not expired')
        it('should return null if expired')
        it('should return null if token invalid')
    })

    describe('deleteSession', () => {
        it('should remove session from database')
        it('should clear session cookie')
    })

    describe('refreshSession', () => {
        it('should extend session expiration')
        it('should update last accessed time')
    })
})
```

---

## Testing Strategy

### Setup Requirements

```bash
npm install --save-dev @testing-library/react @testing-library/jest-dom
npm install --save-dev @testing-library/user-event jest-environment-jsdom
npm install --save-dev vitest @vitest/ui
```

### File Structure

```
src/
├── __tests__/
│   ├── components/
│   │   ├── Header.test.tsx
│   │   ├── PasswordChecker.test.tsx
│   │   └── ...
│   ├── pages/
│   │   ├── ProfilePageClient.test.tsx
│   │   ├── SignupPageClient.test.tsx
│   │   └── LoginPageClient.test.tsx
│   ├── lib/
│   │   ├── auth/
│   │   │   ├── client.test.ts
│   │   │   ├── helpers.test.ts
│   │   │   └── session.test.ts
│   │   └── prisma/
│   │       └── user.test.ts
│   └── api/
│       └── user/
│           └── profile.test.ts
```

### Mock Strategy

**Mock better-auth:**

```typescript
jest.mock('@/lib/auth/client', () => ({
    useSession: jest.fn(),
    signIn: {
        email: jest.fn(),
        social: jest.fn(),
    },
    signUp: {
        email: jest.fn(),
    },
    signOut: jest.fn(),
}))
```

**Mock Next.js router:**

```typescript
jest.mock('next/navigation', () => ({
    useRouter: jest.fn(),
    usePathname: jest.fn(),
}))
```

**Mock Prisma client:**

```typescript
jest.mock('@/lib/prisma', () => ({
    prisma: {
        user: {
            create: jest.fn(),
            findUnique: jest.fn(),
            update: jest.fn(),
            delete: jest.fn(),
        },
        session: {
            create: jest.fn(),
            findUnique: jest.fn(),
            delete: jest.fn(),
        },
        account: {
            create: jest.fn(),
            findFirst: jest.fn(),
        },
    },
}))
```

---

## Priority Order

### High Priority (Implement First)

1. **Auth Client Tests** - Core functionality
2. **Form Validation Tests** - Critical for user experience
3. **Profile Component Tests** - Main feature
4. **Header Component Tests** - Visible on all pages

### Medium Priority

5. **Password Strength Tests** - Nice to have validation
6. **API Route Tests** - Backend logic
7. **Helper Function Tests** - Utilities

### Low Priority

8. **Database Operation Tests** - Covered by integration tests
9. **Session Management Tests** - Covered by E2E tests

---

## Coverage Goals

- **Target:** 80% code coverage
- **Components:** 90% coverage (highly visible)
- **Utilities:** 100% coverage (pure functions)
- **API Routes:** 80% coverage
- **Database:** 70% coverage (E2E covers most)

---

## Benefits

### Speed

- Unit tests run in **milliseconds** vs E2E **seconds**
- Fast feedback during development
- Quick CI/CD pipeline

### Isolation

- Test individual functions/components
- Easier to debug failures
- Pinpoint exact problem location

### Edge Cases

- Test error conditions easily
- Test boundary values
- Mock difficult-to-reproduce scenarios

### Documentation

- Tests serve as usage examples
- Show expected behavior
- Help onboard new developers

---

## Example Implementation

### Sample Test: ProfilePageClient

```typescript
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { useSession, signOut } from '@/lib/auth/client'
import ProfilePageClient from './ProfilePageClient'

jest.mock('@/lib/auth/client')

describe('ProfilePageClient', () => {
  const mockSession = {
    user: {
      id: '1',
      name: 'Test User',
      email: 'test@example.com',
      username: 'testuser',
      emailVerified: true,
      status: 'ACTIVE_USER',
      role: 'USER',
      createdAt: new Date('2024-01-01'),
    },
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('should redirect to login when not authenticated', () => {
    ;(useSession as jest.Mock).mockReturnValue({
      data: null,
      isPending: false,
    })

    const mockPush = jest.fn()
    jest.spyOn(require('next/navigation'), 'useRouter').mockReturnValue({
      push: mockPush,
    })

    render(<ProfilePageClient />)

    expect(mockPush).toHaveBeenCalledWith('/login')
  })

  it('should display user information when authenticated', () => {
    ;(useSession as jest.Mock).mockReturnValue({
      data: mockSession,
      isPending: false,
    })

    render(<ProfilePageClient />)

    expect(screen.getByText('Test User')).toBeInTheDocument()
    expect(screen.getByText('@testuser')).toBeInTheDocument()
    expect(screen.getByText('test@example.com')).toBeInTheDocument()
  })

  it('should enter edit mode when clicking Edit Profile', () => {
    ;(useSession as jest.Mock).mockReturnValue({
      data: mockSession,
      isPending: false,
    })

    render(<ProfilePageClient />)

    const editButton = screen.getByRole('button', { name: /edit profile/i })
    fireEvent.click(editButton)

    expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument()
  })

  it('should call signOut when clicking Sign Out button', async () => {
    ;(useSession as jest.Mock).mockReturnValue({
      data: mockSession,
      isPending: false,
    })
    ;(signOut as jest.Mock).mockResolvedValue(undefined)

    render(<ProfilePageClient />)

    const signOutButton = screen.getByRole('button', { name: /sign out/i })
    fireEvent.click(signOutButton)

    await waitFor(() => {
      expect(signOut).toHaveBeenCalled()
    })
  })
})
```

---

## Next Steps

1. **Create test configuration** (`vitest.config.ts` or `jest.config.js`)
2. **Set up test utilities** (custom render functions, mocks)
3. **Implement high-priority tests first**
4. **Add coverage reporting**
5. **Integrate into CI/CD pipeline**
6. **Set coverage thresholds**

Would you like me to:

1. Create the actual test files for any specific component?
2. Set up the testing infrastructure (config files)?
3. Implement a specific test suite from the proposal?
