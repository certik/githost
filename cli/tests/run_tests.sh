#!/usr/bin/env bash
# Reference tests for the githost C CLI against the *real* Worker + local D1.
#
# Strategy:
#   1. Apply migrations and seed fixed SQL fixtures (scripts/seed-*.sql).
#   2. Start `wrangler dev` on a dedicated port (default 8799).
#   3. Run the CLI with `--url http://127.0.0.1:$PORT --no-color`.
#   4. Diff stdout against cli/tests/reference/*.txt.
#
# Relative times stay deterministic: seed timestamps are fixed epoch-ms values
# and the CLI uses max(updatedAt) as "now".
#
# Update goldens after an intentional UI or seed change:
#   UPDATE_REFS=1 ./cli/tests/run_tests.sh ./cli/build/githost
#
# Env:
#   GITHOST_TEST_PORT   wrangler port (default 8799)
#   UPDATE_REFS=1       rewrite reference files
#   SKIP_SEED=1         skip npm run dev:seed (reuse existing local D1)
#   SKIP_WRANGLER=1     don't start wrangler; use already-running server at PORT

set -euo pipefail

CLI_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$CLI_ROOT/.." && pwd)"
BIN="${1:-}"
PORT="${GITHOST_TEST_PORT:-8799}"
BASE_URL="http://127.0.0.1:${PORT}"

if [[ -z "$BIN" ]]; then
  if [[ -x "$CLI_ROOT/build/githost" ]]; then
    BIN="$CLI_ROOT/build/githost"
  else
    echo "usage: $0 <path-to-githost-binary>" >&2
    exit 2
  fi
fi
if [[ ! -x "$BIN" ]]; then
  echo "githost binary not executable: $BIN" >&2
  exit 2
fi

REF_DIR="$CLI_ROOT/tests/reference"
OUT_DIR="${TMPDIR:-/tmp}/githost-cli-test-$$"
mkdir -p "$OUT_DIR"
WRANGLER_PID=""

cleanup() {
  if [[ -n "$WRANGLER_PID" ]]; then
    kill "$WRANGLER_PID" 2>/dev/null || true
    wait "$WRANGLER_PID" 2>/dev/null || true
  fi
  rm -rf "$OUT_DIR"
}
trap cleanup EXIT

cd "$REPO_ROOT"

# --- .dev.vars (required by wrangler; never committed) ---
if [[ ! -f .dev.vars ]]; then
  if [[ -f .dev.vars.example ]]; then
    echo "Creating .dev.vars from .dev.vars.example for local/CI Worker"
    cp .dev.vars.example .dev.vars
  else
    echo "missing .dev.vars and .dev.vars.example" >&2
    exit 1
  fi
fi

# --- SPA assets (Worker ASSETS binding) ---
if [[ ! -f web/dist/index.html ]]; then
  echo "Building web/dist (required by wrangler assets)…"
  npm -w web run build
fi

# --- Seed local D1 ---
if [[ "${SKIP_SEED:-}" != "1" ]]; then
  echo "Seeding local D1 (npm run dev:seed)…"
  npm run dev:seed
fi

# --- Start Worker ---
if [[ "${SKIP_WRANGLER:-}" != "1" ]]; then
  if curl -sf "$BASE_URL/healthz" >/dev/null 2>&1; then
    echo "error: something already answers on $BASE_URL — free port $PORT or set GITHOST_TEST_PORT" >&2
    exit 1
  fi
  echo "Starting wrangler dev on $BASE_URL …"
  # --show-interactive-dev-session=false avoids TTY prompts in CI.
  npx wrangler dev --ip 127.0.0.1 --port "$PORT" \
    --show-interactive-dev-session=false \
    >"$OUT_DIR/wrangler.log" 2>&1 &
  WRANGLER_PID=$!

  ready=0
  for _ in $(seq 1 90); do
    if curl -sf "$BASE_URL/api/prs" -o "$OUT_DIR/probe.json" 2>/dev/null; then
      ready=1
      break
    fi
    # Bail early if wrangler died
    if ! kill -0 "$WRANGLER_PID" 2>/dev/null; then
      echo "wrangler exited early; log:" >&2
      cat "$OUT_DIR/wrangler.log" >&2 || true
      exit 1
    fi
    sleep 0.5
  done
  if [[ "$ready" != "1" ]]; then
    echo "Worker did not become ready at $BASE_URL/api/prs; wrangler log:" >&2
    cat "$OUT_DIR/wrangler.log" >&2 || true
    exit 1
  fi
  echo "Worker ready."
else
  if ! curl -sf "$BASE_URL/api/prs" -o "$OUT_DIR/probe.json"; then
    echo "SKIP_WRANGLER=1 but $BASE_URL/api/prs is not reachable" >&2
    exit 1
  fi
fi

# Sanity: seeded data present
item_count="$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["items"]))' "$OUT_DIR/probe.json")"
if [[ "$item_count" -lt 1 ]]; then
  echo "GET /api/prs returned 0 items — seed missing?" >&2
  exit 1
fi
echo "GET /api/prs → $item_count items"

run_case() {
  local name="$1"
  shift
  local out="$OUT_DIR/$name.txt"
  local ref="$REF_DIR/$name.txt"

  echo "RUN  $name: $BIN --url $BASE_URL --no-color $*"
  "$BIN" --url "$BASE_URL" --no-color "$@" >"$out"

  if [[ "${UPDATE_REFS:-}" == "1" ]]; then
    mkdir -p "$REF_DIR"
    cp "$out" "$ref"
    echo "UPD  $ref"
    return 0
  fi

  if [[ ! -f "$ref" ]]; then
    echo "missing reference: $ref (run with UPDATE_REFS=1 to create)" >&2
    exit 1
  fi

  if ! diff -u "$ref" "$out"; then
    echo "FAIL $name — output differs from reference" >&2
    exit 1
  fi
  echo "OK   $name"
}

# Cases exercise the public (anonymous) API the CLI uses today.
run_case pr_list pr list
run_case pr_list_passed pr list --passed
run_case pr_list_all pr list --all
run_case pr_view_1001 pr view 1001
run_case pr_list_json pr list --passed --json

echo "All CLI reference tests passed (against $BASE_URL)."
