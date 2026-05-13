/**
 * Aggregate a set of GitHub check runs that all belong to the SAME bucket
 * (quick or exhaustive) into a single bucket-level status that the UI displays
 * as one colored dot.
 *
 * Priority rules (highest first):
 *   1. any "failed-ish" conclusion → "failed"
 *   2. any in_progress             → "running"
 *   3. any queued                  → "queued"
 *   4. otherwise (all completed)   → "passed"
 *   5. zero runs                   → null (no row written → empty ring in UI)
 *
 * "Failed-ish" conclusions: failure, timed_out, action_required, startup_failure.
 * `cancelled`, `skipped`, `neutral`, `stale` are treated as benign.
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

export type AggregateStatus = "queued" | "running" | "passed" | "failed";

const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "action_required", "startup_failure"]);

export function aggregateChecks(runs: readonly GhCheckRun[]): AggregateStatus | null {
  if (runs.length === 0) return null;

  if (runs.some((r) => r.status === "completed" && r.conclusion !== null && FAILED_CONCLUSIONS.has(String(r.conclusion)))) {
    return "failed";
  }
  if (runs.some((r) => r.status === "in_progress")) return "running";
  if (runs.some((r) => r.status === "queued" || r.status === "pending" || r.status === "waiting" || r.status === "requested")) {
    return "queued";
  }
  return "passed";
}
