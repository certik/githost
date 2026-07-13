#!/usr/bin/env bash
# Review every passed PR without a local review and submit it to githost.
set -euo pipefail

cd "$(dirname "$0")/.."
REVIEW=./cli/bin/githost-review
GITHOST_BIN="${GITHOST_BIN:-./cli/build/githost}"
AGENT="${GITHOST_AGENT:-copilot}"
LOG_DIR=.githost/logs
mkdir -p "$LOG_DIR" .githost/reviews

# Explicit PR numbers override automatic discovery.
if [[ $# -gt 0 ]]; then
  PRS=("$@")
else
  json="$("$GITHOST_BIN" pr list --passed --unreviewed --json)"
  PRS=()
  while IFS= read -r pr; do
    PRS+=("$pr")
  done < <(
    python3 -c 'import json, sys; sys.stdout.writelines("{}\n".format(pr["number"]) for pr in json.load(sys.stdin)["items"])' \
      <<<"$json"
  )
fi

if [[ ${#PRS[@]} -eq 0 ]]; then
  echo "No passed PRs without a local review."
  exit 0
fi

ok=0
fail=0
summary="$LOG_DIR/batch-summary.txt"
: >"$summary"

for pr in "${PRS[@]}"; do
  log="$LOG_DIR/review-${pr}.log"
  echo "======== START PR #$pr $(date -u +%Y-%m-%dT%H:%M:%SZ) ========" | tee -a "$summary"
  args=("$pr" --agent "$AGENT" --repo lfortran/lfortran)
  if [[ "${DRY_RUN:-}" == "1" ]]; then
    args+=(--dry-run)
  else
    args+=(--submit)
  fi

  if "$REVIEW" "${args[@]}" &>"$log"; then
    if grep -q 'submitted PR' "$log"; then
      echo "OK   #$pr" | tee -a "$summary"
      ok=$((ok + 1))
    elif [[ "${DRY_RUN:-}" == "1" ]] && grep -q 'dry-run' "$log"; then
      echo "DRY  #$pr" | tee -a "$summary"
      ok=$((ok + 1))
    else
      echo "FAIL #$pr (agent ok but no submit line)" | tee -a "$summary"
      cat "$log"
      fail=$((fail + 1))
    fi
  else
    echo "FAIL #$pr (exit $?)" | tee -a "$summary"
    cat "$log"
    fail=$((fail + 1))
  fi
done

echo "======== DONE ok=$ok fail=$fail ========" | tee -a "$summary"
[[ "$fail" -eq 0 ]]
