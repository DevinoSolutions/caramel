// Registers @testing-library/jest-dom's matchers (toBeVisible, toBeDisabled,
// toHaveAttribute, …) on vitest's expect for every suite. The .mjs logic
// suites simply never call them; the .test.tsx view suites depend on them.
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// RTL's automatic unmount-after-each relies on a GLOBAL afterEach, and this
// config keeps `globals: false` — without this line every render() leaks
// into the next test's document and duplicate-element queries start failing.
afterEach(cleanup)
