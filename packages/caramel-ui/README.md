# caramel-ui

Shared Caramel UI primitives (monorepo doctrine: one UI package for the big
shared elements — animations, logos, brand components). First consumer: the
extension's React popup (WXT P2). Next: Shorty's extension, then caramel-app.

## Contract

- **Source-consumed.** No build step: `exports` points at `src/index.ts` and
  the consuming bundler compiles it (vite/WXT works out of the box; Next needs
  `transpilePackages: ['caramel-ui']` when caramel-app adopts it).
- **Tokens are the HOST's responsibility.** Components style themselves with
  `var(--cm-*)` custom properties and ship no color literals of their own. The
  canonical token sheet currently lives in
  `apps/caramel-extension/public/assets/tokens.css`; a host page must load a
  `--cm-*` token sheet before these components render. Moving the token sheet
  INTO this package is a deliberate future PR (it must move, not fork — a copy
  here would be exactly the drift pair the shared-UI doctrine exists to
  prevent).
- Strict TypeScript, no `any`, exact-pinned devDependencies.
