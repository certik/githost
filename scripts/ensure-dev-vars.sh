#!/usr/bin/env bash
# Ensure `.dev.vars` exists for local `wrangler dev`.
#
# Wrangler does NOT pick up shell env like `DEV_LOGIN_ENABLED=true npm run dev`.
# Local-only flags must live in `.dev.vars` (git-ignored). Production never
# loads this file.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -f .dev.vars ]]; then
  exit 0
fi

if [[ ! -f .dev.vars.example ]]; then
  echo "error: missing .dev.vars.example (cannot bootstrap local secrets)" >&2
  exit 1
fi

cp .dev.vars.example .dev.vars
echo "Created .dev.vars from .dev.vars.example (DEV_LOGIN_ENABLED / DEV_AUTO_LOGIN on)."
echo "Edit .dev.vars if you need real GitHub App credentials for live diffs."
