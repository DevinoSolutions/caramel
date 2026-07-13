import { vi } from 'vitest'

// `server-only`'s package.json redirects the `.` export to a no-op empty
// module via the `react-server` export condition — a resolution Next.js's
// own server bundler applies, but plain Node/Vite (this test runner) does
// not. Without this, any module that does `import 'server-only'`
// (src/lib/env.ts) throws the instant it's imported under vitest, even in
// files that never render to the browser. This mirrors what Next.js's
// server build already does (see server-only's package.json
// `exports["."]["react-server"]`, which points at its own empty module).
vi.mock('server-only', () => ({}))
