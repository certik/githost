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
 *   Group key                                            | priority | label
 *   -----------------------------------------------------|----------|-------
 *   quick=passed + exhaustive=passed + mergeable ≠ false |  0  | "Quick + Exhaustive passed" (green box)
 *   quick=passed + exhaustive=passed + mergeable = false |  1  | "Quick + Exhaustive passed (merge conflict)" (amber box)
 *   quick=passed + exhaustive=running   |  2  | "Quick passed · Exhaustive running"
 *   quick=passed + exhaustive=queued    |  3  | "Quick passed · Exhaustive queued"
 *   quick=passed + exhaustive=skipped   |  4  | "Quick passed · Exhaustive skipped"
 *   quick=passed + exhaustive=null      |  5  | "Quick passed · Exhaustive not run"
 *   quick=passed + exhaustive=failed    |  6  | "Quick passed · Exhaustive failed"
 *   quick=running                       | 10  | "Quick running"
 *   quick=queued | null                 | 20  | "Quick queued / not run"
 *   quick=skipped                       | 25  | "Quick skipped"
 *   quick=failed                        | 30  | "Quick failed"
 *
 * mergeable semantics:
 *   - true:  GitHub confirms PR can be merged into base.
 *   - false: PR has merge conflicts (mergeable_state is usually "dirty").
 *   - null:  GitHub is still computing — common right after a push. We treat
 *            this as "probably mergeable" so the user isn't yanked out of the
 *            green box during the brief computing window.
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
  mergeable?: boolean | null;
  quickTest: { status: TestStatus } | null;
  exhaustiveTest: { status: TestStatus } | null;
}

export interface PriorityGroup<P extends PrLike> {
  key: number;
  label: string;
  highlight: boolean;       // "ready to go in CI terms" → green box highlight
  warn: boolean;            // ready-CI-wise but blocked (e.g. merge conflict) → amber box
  items: P[];
}

export interface ReviewPriorityResult<P extends PrLike> {
  ready: PriorityGroup<P>[];
  drafts: P[];
}

/** True iff GitHub reports a real conflict. null (computing) is NOT a conflict. */
export function hasMergeConflict(pr: PrLike): boolean {
  return pr.mergeable === false;
}

/** Priority key (lower = sorts earlier). */
export function priorityOf(pr: PrLike): number {
  const q = pr.quickTest?.status ?? null;
  const e = pr.exhaustiveTest?.status ?? null;
  if (q === "passed") {
    if (e === "passed")  return hasMergeConflict(pr) ? 1 : 0;
    if (e === "running") return 2;
    if (e === "queued")  return 3;
    if (e === "skipped") return 4;
    if (e === "failed")  return 6;
    return 5;                          // null / unknown
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
    case 1:  return "Quick + Exhaustive passed (merge conflict)";
    case 2:  return "Quick passed · Exhaustive running";
    case 3:  return "Quick passed · Exhaustive queued";
    case 4:  return "Quick passed · Exhaustive skipped";
    case 5:  return "Quick passed · Exhaustive not run";
    case 6:  return "Quick passed · Exhaustive failed";
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
    return {
      key,
      label: labelOf(key),
      highlight: key === 0,
      warn: key === 1,
      items,
    };
  });

  drafts.sort(byUpdatedAtDesc);
  return { ready, drafts };
}

function byUpdatedAtDesc<P extends PrLike>(a: P, b: P): number {
  return b.updatedAt - a.updatedAt;
}
