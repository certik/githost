/**
 * Unit tests for the review-priority sort logic.
 *
 * Pure logic, runs in the @cloudflare/vitest-pool-workers runtime like the
 * rest of our tests — fine because there's no DOM/React dependency.
 */
import { describe, it, expect } from "vitest";
import {
  priorityOf,
  labelOf,
  bothPassing,
  groupForReviewPriority,
  type PrLike,
} from "../../web/src/lib/review-priority";

let nextId = 1;
function pr(opts: Partial<PrLike> & { quick?: string | null; exhaustive?: string | null }): PrLike {
  const quick = opts.quick === undefined ? null : opts.quick;
  const exhaustive = opts.exhaustive === undefined ? null : opts.exhaustive;
  return {
    id: opts.id ?? nextId++,
    draft: opts.draft ?? false,
    updatedAt: opts.updatedAt ?? 1_700_000_000_000,
    quickTest: quick === null ? null : { status: quick as PrLike["quickTest"] extends infer T ? T extends { status: infer S } ? S : never : never },
    exhaustiveTest: exhaustive === null ? null : { status: exhaustive as PrLike["exhaustiveTest"] extends infer T ? T extends { status: infer S } ? S : never : never },
  };
}

describe("priorityOf", () => {
  it("ranks (quick=passed, exhaustive=passed) the highest (priority 0)", () => {
    expect(priorityOf(pr({ quick: "passed", exhaustive: "passed" }))).toBe(0);
  });

  it("orders quick=passed sub-buckets correctly: passed < running < queued < skipped < null < failed", () => {
    const order = [
      pr({ quick: "passed", exhaustive: "passed" }),
      pr({ quick: "passed", exhaustive: "running" }),
      pr({ quick: "passed", exhaustive: "queued" }),
      pr({ quick: "passed", exhaustive: "skipped" }),
      pr({ quick: "passed", exhaustive: null }),
      pr({ quick: "passed", exhaustive: "failed" }),
    ];
    const priorities = order.map(priorityOf);
    expect(priorities).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("quick=running ranks above any non-quick-passed state", () => {
    expect(priorityOf(pr({ quick: "running" }))).toBe(10);
    expect(priorityOf(pr({ quick: "running" })))
      .toBeLessThan(priorityOf(pr({ quick: "queued" })));
    expect(priorityOf(pr({ quick: "running" })))
      .toBeLessThan(priorityOf(pr({ quick: "skipped" })));
    expect(priorityOf(pr({ quick: "running" })))
      .toBeLessThan(priorityOf(pr({ quick: "failed" })));
  });

  it("treats quick=null the same as quick=queued (both 'not started')", () => {
    expect(priorityOf(pr({ quick: null }))).toBe(20);
    expect(priorityOf(pr({ quick: "queued" }))).toBe(20);
  });

  it("quick=failed ranks last", () => {
    expect(priorityOf(pr({ quick: "failed" }))).toBe(30);
  });
});

describe("bothPassing", () => {
  it("true only when both quick and exhaustive are passed", () => {
    expect(bothPassing(pr({ quick: "passed", exhaustive: "passed" }))).toBe(true);
    expect(bothPassing(pr({ quick: "passed", exhaustive: "skipped" }))).toBe(false);
    expect(bothPassing(pr({ quick: "passed", exhaustive: null }))).toBe(false);
    expect(bothPassing(pr({ quick: "running", exhaustive: "passed" }))).toBe(false);
    expect(bothPassing(pr({ quick: null, exhaustive: null }))).toBe(false);
  });
});

describe("labelOf", () => {
  it("returns the expected label for each priority key", () => {
    expect(labelOf(0)).toBe("Quick + Exhaustive passed");
    expect(labelOf(1)).toBe("Quick passed · Exhaustive running");
    expect(labelOf(2)).toBe("Quick passed · Exhaustive queued");
    expect(labelOf(3)).toBe("Quick passed · Exhaustive skipped");
    expect(labelOf(4)).toBe("Quick passed · Exhaustive not run");
    expect(labelOf(5)).toBe("Quick passed · Exhaustive failed");
    expect(labelOf(10)).toBe("Quick running");
    expect(labelOf(20)).toBe("Quick queued / not run");
    expect(labelOf(25)).toBe("Quick skipped");
    expect(labelOf(30)).toBe("Quick failed");
  });
});

describe("groupForReviewPriority", () => {
  it("partitions drafts to the bottom; non-drafts to ready", () => {
    const open1 = pr({ quick: "passed", exhaustive: "passed" });
    const open2 = pr({ quick: "failed" });
    const draft1 = pr({ draft: true, quick: "passed", exhaustive: "passed" });
    const draft2 = pr({ draft: true, quick: "running" });

    const { ready, drafts } = groupForReviewPriority([open1, open2, draft1, draft2]);

    const readyIds = ready.flatMap((g) => g.items.map((p) => p.id));
    expect(readyIds).toEqual(expect.arrayContaining([open1.id, open2.id]));
    expect(readyIds).not.toContain(draft1.id);
    expect(readyIds).not.toContain(draft2.id);
    expect(drafts.map((p) => p.id).sort()).toEqual([draft1.id, draft2.id].sort());
  });

  it("returns groups in ascending priority order", () => {
    const a = pr({ quick: "failed" });
    const b = pr({ quick: "passed", exhaustive: "passed" });
    const c = pr({ quick: "running" });
    const { ready } = groupForReviewPriority([a, b, c]);
    expect(ready.map((g) => g.key)).toEqual([0, 10, 30]);
  });

  it("marks only the priority=0 group as highlighted (CI-ready)", () => {
    const ci_green = pr({ quick: "passed", exhaustive: "passed" });
    const partial   = pr({ quick: "passed", exhaustive: "queued" });
    const { ready } = groupForReviewPriority([ci_green, partial]);
    expect(ready[0]?.key).toBe(0);
    expect(ready[0]?.highlight).toBe(true);
    expect(ready[1]?.highlight).toBe(false);
  });

  it("omits empty groups", () => {
    const { ready } = groupForReviewPriority([pr({ quick: "passed", exhaustive: "passed" })]);
    expect(ready).toHaveLength(1);
    expect(ready[0]?.key).toBe(0);
  });

  it("sorts within each group by updatedAt desc", () => {
    const old = pr({ quick: "passed", exhaustive: "passed", updatedAt: 1000 });
    const mid = pr({ quick: "passed", exhaustive: "passed", updatedAt: 2000 });
    const fresh = pr({ quick: "passed", exhaustive: "passed", updatedAt: 3000 });
    const { ready } = groupForReviewPriority([old, fresh, mid]);
    expect(ready[0]?.items.map((p) => p.id)).toEqual([fresh.id, mid.id, old.id]);
  });

  it("sorts drafts by updatedAt desc", () => {
    const old = pr({ draft: true, updatedAt: 1000 });
    const fresh = pr({ draft: true, updatedAt: 2000 });
    const { drafts } = groupForReviewPriority([old, fresh]);
    expect(drafts.map((p) => p.id)).toEqual([fresh.id, old.id]);
  });

  it("on an empty list returns empty ready[] and empty drafts[]", () => {
    const { ready, drafts } = groupForReviewPriority([]);
    expect(ready).toEqual([]);
    expect(drafts).toEqual([]);
  });

  it("group labels match the priorities of their items", () => {
    const { ready } = groupForReviewPriority([
      pr({ quick: "passed", exhaustive: "passed" }),
      pr({ quick: "passed", exhaustive: "failed" }),
      pr({ quick: "failed" }),
    ]);
    expect(ready.find((g) => g.key === 0)?.label).toBe("Quick + Exhaustive passed");
    expect(ready.find((g) => g.key === 5)?.label).toBe("Quick passed · Exhaustive failed");
    expect(ready.find((g) => g.key === 30)?.label).toBe("Quick failed");
  });
});
