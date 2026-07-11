#!/usr/bin/env bash
# Reference tests for the githost C CLI.
#
# Strategy:
#   1. Serve a fixed JSON fixture on a local ephemeral port (no Cloudflare).
#   2. Run the CLI against that base URL with --no-color.
#   3. Diff stdout against checked-in reference files.
#
# Why reference diffs (not unit asserts on individual fields)?
#   The CLI's value is the rendered table. A full-screen snapshot catches
#   grouping, sort order, truncation, and 80-col layout in one shot. Relative
#   times are deterministic because the CLI uses max(updatedAt) as "now".
#
# Update references after an intentional UI change:
#   UPDATE_REFS=1 ./cli/tests/run_tests.sh ./cli/build/githost

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="${1:-}"
if [[ -z "$BIN" ]]; then
  if [[ -x "$ROOT/build/githost" ]]; then
    BIN="$ROOT/build/githost"
  else
    echo "usage: $0 <path-to-githost-binary>" >&2
    exit 2
  fi
fi
if [[ ! -x "$BIN" ]]; then
  echo "githost binary not executable: $BIN" >&2
  exit 2
fi

REF_DIR="$ROOT/tests/reference"
FIX_DIR="$ROOT/tests/fixtures"
OUT_DIR="${TMPDIR:-/tmp}/githost-cli-test-$$"
mkdir -p "$OUT_DIR"
cleanup() {
  if [[ -n "${SRV_PID:-}" ]]; then
    kill "$SRV_PID" 2>/dev/null || true
    wait "$SRV_PID" 2>/dev/null || true
  fi
  rm -rf "$OUT_DIR"
}
trap cleanup EXIT

python3 "$ROOT/tests/serve_fixture.py" \
  --fixture "$FIX_DIR/api_prs.json" >"$OUT_DIR/url.txt" &
SRV_PID=$!

# Wait for the server to print its base URL.
for _ in $(seq 1 50); do
  if [[ -s "$OUT_DIR/url.txt" ]]; then
    break
  fi
  sleep 0.05
done
BASE_URL="$(tr -d '[:space:]' <"$OUT_DIR/url.txt")"
if [[ -z "$BASE_URL" ]]; then
  echo "fixture server did not start" >&2
  exit 1
fi

# Probe /api/prs once so we fail early if the server is broken.
curl -sf "$BASE_URL/api/prs" -o "$OUT_DIR/probe.json" || {
  echo "fixture server not answering at $BASE_URL/api/prs" >&2
  exit 1
}

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

run_case pr_list pr list
run_case pr_list_passed pr list --passed
run_case pr_list_all pr list --all
run_case pr_view_1001 pr view 1001
run_case pr_list_json pr list --passed --json

echo "All CLI reference tests passed."
