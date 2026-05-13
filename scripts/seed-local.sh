#!/usr/bin/env bash
# Seed the local D1 databases with fixture data so the SPA shows something
# meaningful when you run `npm run dev`.
#
# Usage:
#   npm run dev:seed
#
# Idempotent — re-running it overwrites the same rows.
set -euo pipefail

cd "$(dirname "$0")/.."

# Make sure the schema is up to date locally.
npx wrangler d1 migrations apply githost-mirror --local
npx wrangler d1 migrations apply githost-app    --local

# Mirror DB: repo + users + PRs covering every badge state.
npx wrangler d1 execute githost-mirror --local --file=scripts/seed-mirror.sql

# App DB: pr_test_run rows covering every dot color.
npx wrangler d1 execute githost-app    --local --file=scripts/seed-app.sql

cat <<'EOF'

  ✅ Local D1 databases seeded.

  Next:
    1. npm run dev              # start wrangler (8787) + vite (5173)
    2. Open http://localhost:5173/auth/dev-login   ← logs you in as "dev"
    3. Browse the PR list — you should see colored test-status dots.

  Re-seed any time:  npm run dev:seed
  Reset to empty:    rm -rf .wrangler/state && npm run db:apply:local

EOF
