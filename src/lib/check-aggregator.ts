/**
 * Aggregate a set of GitHub check runs that all belong to the SAME bucket
 * (quick or exhaustive) into a single bucket-level status that the UI displays
 * as one colored dot/icon.
 *
 * Logic:
 *   1. Filter out runs we treat as "not really executed":
 *        completed/skipped, completed/neutral, completed/stale, completed/cancelled
 *      These show on github.com as "Skipped"/"Cancelled" and shouldn't make
 *      the bucket green.
 *   2. Empty filtered set:
 *        - if there WERE runs (all filtered) → "skipped"
 *        - if there were ZERO runs to begin with → null (UI shows empty ring)
 *   3. Priority within the filtered (real) runs:
 *        - any "failed-ish" conclusion → "failed"
 *        - any in_progress             → "running"
 *        - any queued/pending/waiting/requested → "queued"
 *        - otherwise (all completed successfully) → "passed"
 *
 * "Failed-ish" conclusions: failure, timed_out, action_required, startup_failure.
 */

export type GhCheckStatus = "queued" | "in_progress" | "completed" | "waiting" | "pending" | "requested";
export type GhCheckConclusion =
  | "success" | "failure" | "neutral" | "cancelled" | "skipped"
  | "timed_out" | "action_required" | "stale" | "startup_failure" | null;

export interface GhCheckRun {
  name: string;
  status: GhCheckStatus | string;
  conclusion: GhCheckConclusion | string | null;
}

export type AggregateStatus = "queued" | "running" | "passed" | "failed" | "skipped";

const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "action_required", "startup_failure"]);
const NOT_REALLY_EXECUTED = new Set(["skipped", "neutral", "stale", "cancelled"]);

export function aggregateChecks(runs: readonly GhCheckRun[]): AggregateStatus | null {
  if (runs.length === 0) return null;

  const effective = runs.filter((r) => {
    if (r.status !== "completed") return true;
    if (r.conclusion === null || r.conclusion === undefined) return true;
    return !NOT_REALLY_EXECUTED.has(String(r.conclusion));
  });
  // There were runs but all were skipped/cancelled/etc → the bucket "ran but
  // didn't really test anything". The UI shows a distinct skipped icon, which
  // is different from "no rows at all" (null → empty ring).
  if (effective.length === 0) return "skipped";

  if (effective.some((r) => r.status === "completed" && r.conclusion !== null && FAILED_CONCLUSIONS.has(String(r.conclusion)))) {
    return "failed";
  }
  if (effective.some((r) => r.status === "in_progress")) return "running";
  if (effective.some((r) => r.status === "queued" || r.status === "pending" || r.status === "waiting" || r.status === "requested")) {
    return "queued";
  }
  return "passed";
}
