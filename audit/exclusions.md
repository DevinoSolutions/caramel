# Scanner exclusion list (caramel @ 537547b)

Excluded from all scans — generated, vendored, binary, or third-party. Findings inside these paths are invalid unless the finding is ABOUT the path's existence/placement (e.g. a stray artifact or a nested lockfile).

- `**/node_modules/**`, `**/dist/**`, `**/.next/**`, `**/playwright-report/**`, `**/test-results/**`
- `pnpm-lock.yaml` (root) and `apps/caramel-app/pnpm-lock.yaml` (nested — its EXISTENCE is a valid finding target, its content is not)
- `apps/caramel-app/prisma/migrations/**` (generated SQL)
- `apps/caramel-app/public/**` (assets; ~binary)
- `apps/caramel-extension/icons/**`, `**/*.png`, `**/*.jpg`, `**/*.webp`, `**/*.ico`, `**/*.gif`, `**/*.lottie`, `**/*.woff*`
- `.github/ISSUE_TEMPLATE/**`, `LICENSE`
- `.git/**`

Everything else in the 405 tracked files is in scope — including `.github/workflows/**`, `local-dev/**`, all root configs, and both apps' source.
