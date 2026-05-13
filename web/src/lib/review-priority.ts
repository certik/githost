/**
 * Pure logic for the "Review priority" sort mode of the PR list.
 *
 * Splits open PRs into a "ready for review" section (top) and a "draft"
 * section (bottom). Within "ready for review", groups by (quick × exhaustive)
 * test status with a deterministic priority — PRs that are closest to
 * being CI-green sort to the top, things still running below, failures at
 * the bottom.
 *
 * The exact priority schedule the UI relies on:
 *
 *   Group key                           | priority | label
 *   ------------------------------------|----------|------------------------------
 *   quick=passed  + exhaustive=passed   |   0      | "Quick + Exhaustive passed"  (highlighted box)
 *   quick=passed  + exhaustive=running  |   1      | "Quick passed · Exhaustive running"
 *   quick=passed  + exhaustive=queued   |   2      | "Quick passed · Exhaustive queued"
 *   quick=passed  + exhaustive=skipped  |   3      | "Quick passed · Exhaustive skipped"
 *   quick=passed  + exhaustive=null     |   4      | "Quick passed · Exhaustive not run"
 *   quick=passed  + exhaustive=failed   |   5      | "Quick passed · Exhaustive failed"
 *   quick=running                       |  10      | "Quick running"
 *   quick=queued | null                 |  20      | "Quick queued / not run"
 *   quick=skipped                       |  25      | "Quick skipped"
 *   quick=failed                        |  30      | "Quick failed"
 *
 * Within each group, items are sorted newest-first by `updatedAt`.
 *
 * No dependency on React or the API client; testable in isolation.
 */

export type TestStatus = "queued" | "running" | "passed" | "failed" | "skipped";

export interface PrLike {
  id: number;
  draft: boolean;
  updatedAt: number;
  quickTest: { status: TestStatus } | null;
  exhaustiveTest: { status: TestStatus } | null;
}

export interface PriorityGroup<P extends PrLike> {
  key: number;
  label: string;
  highlight: boolean;       // "ready to go in CI terms" → box highlight in UI
  items: P[];
}

export interface ReviewPriorityResult<P extends PrLike> {
  ready: PriorityGroup<P>[];
  drafts: P[];
}

/** Priority key (lower = sorts earlier). */
export function priorityOf(pr: PrLike): number {
  const q = pr.quickTest?.status ?? null;
  const e = pr.exhaustiveTest?.status ?? null;
  if (q === "passed") {
    if (e === "passed")  return 0;
    if (e === "running") return 1;
    if (e === "queued")  return 2;
    if (e === "skipped") return 3;
    if (e === "failed")  return 5;
    return 4;                          // null / unknown
  }
  if (q === "running") return 10;
  if (q === "queued" || q === null) return 20;
  if (q === "skipped") return 25;
  if (q === "failed")  return 30;
  return 99;
}

export function labelOf(priority: number): string {
  switch (priority) {
    case 0:  return "Quick + Exhaustive passed";
    case 1:  return "Quick passed · Exhaustive running";
    case 2:  return "Quick passed · Exhaustive queued";
    case 3:  return "Quick passed · Exhaustive skipped";
    case 4:  return "Quick passed · Exhaustive not run";
    case 5:  return "Quick passed · Exhaustive failed";
    case 10: return "Quick running";
    case 20: return "Quick queued / not run";
    case 25: return "Quick skipped";
    case 30: return "Quick failed";
    default: return "Other";
  }
}

/** True when this PR is "ready to merge in CI terms" — both buckets passed. */
export function bothPassing(pr: PrLike): boolean {
  return pr.quickTest?.status === "passed" && pr.exhaustiveTest?.status === "passed";
}

/**
 * Split + group `prs` into the review-priority layout.
 *   - drafts: any PR with `draft === true`, sorted newest-first
 *   - ready:  the rest, bucketed by priorityOf, groups returned in
 *             ascending key order. Empty groups are omitted.
 */
export function groupForReviewPriority<P extends PrLike>(prs: readonly P[]): ReviewPriorityResult<P> {
  const drafts: P[] = [];
  const buckets = new Map<number, P[]>();

  for (const pr of prs) {
    if (pr.draft) {
      drafts.push(pr);
      continue;
    }
    const key = priorityOf(pr);
    const arr = buckets.get(key);
    if (arr) arr.push(pr);
    else buckets.set(key, [pr]);
  }

  const sortedKeys = [...buckets.keys()].sort((a, b) => a - b);
  const ready: PriorityGroup<P>[] = sortedKeys.map((key) => {
    const items = buckets.get(key)!.slice().sort(byUpdatedAtDesc);
    return { key, label: labelOf(key), highlight: key === 0, items };
  });

  drafts.sort(byUpdatedAtDesc);
  return { ready, drafts };
}

function byUpdatedAtDesc<P extends PrLike>(a: P, b: P): number {
  return b.updatedAt - a.updatedAt;
}
