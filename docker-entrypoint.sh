#!/bin/sh
# caramel-app container entrypoint — one-root-compose (F-016).
#
# Fail-hard: apply DB migrations, THEN start the standalone server. `set -e`
# with no `|| true` and no retry loop — a failed migration must crash the boot
# loudly and visibly, never silently serve against an unmigrated schema.
set -e

echo ">>> [entrypoint] applying prisma migrate deploy"
# The CLI lives in its own staged tree (prisma-cli/), isolated from the app's
# traced node_modules. Prisma 7 takes the schema path and DATABASE_URL from the
# config file (its paths resolve relative to the file itself).
node prisma-cli/node_modules/prisma/build/index.js migrate deploy \
  --config apps/caramel-app/prisma.config.ts
echo ">>> [entrypoint] migrations applied; starting server"

exec node apps/caramel-app/server.js
