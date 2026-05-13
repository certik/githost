/**
 * Aggregate a set of GitHub check runs that all belong to the SAME bucket
 * (quick or exhaustive) into a single bucket-level status that the UI displays
 * as one colored dot.
 *
 * Logic:
 *   1. Filter out runs we treat as "not really executed":
 *        - completed/skipped, completed/neutral, completed/stale
 *      These show on github.com as "Skipped" and shouldn't make a bucket green.
 *   2. After filtering, priority (highest first):
 *      - any "failed-ish" conclusion → "failed"
 *      - any in_progress             → "running"
 *      - any queued/pending/waiting/requested → "queued"
 *      - otherwise (all completed successfully) → "passed"
 *      - zero runs left → null (no row written → empty ring in UI)
 *
 * "Failed-ish" conclusions: failure, timed_out, action_required, startup_failure.
 * `cancelled` is filtered out at the failure check (it isn't a success either,
 * but it's a user/system action, not a test outcome — treat as "didn't run").
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
const NOT_REALLY_EXECUTED = new Set(["skipped", "neutral", "stale", "cancelled"]);

export function aggregateChecks(runs: readonly GhCheckRun[]): AggregateStatus | null {
  // Drop "didn't actually run" outcomes. github.com shows these as "Skipped".
  // If every run in a bucket falls into this set, the bucket as a whole hasn't
  // run — we return null so the UI renders an empty ring rather than "passed".
  const effective = runs.filter((r) => {
    if (r.status !== "completed") return true;
    if (r.conclusion === null || r.conclusion === undefined) return true;
    return !NOT_REALLY_EXECUTED.has(String(r.conclusion));
  });
  if (effective.length === 0) return null;

  if (effective.some((r) => r.status === "completed" && r.conclusion !== null && FAILED_CONCLUSIONS.has(String(r.conclusion)))) {
    return "failed";
  }
  if (effective.some((r) => r.status === "in_progress")) return "running";
  if (effective.some((r) => r.status === "queued" || r.status === "pending" || r.status === "waiting" || r.status === "requested")) {
    return "queued";
  }
  return "passed";
}
