/**
 * Unit tests for the per-bucket check aggregator.
 */
import { describe, it, expect } from "vitest";
import { aggregateChecks, type GhCheckRun } from "../../src/lib/check-aggregator";

function run(name: string, status: string, conclusion: string | null = null): GhCheckRun {
  return { name, status, conclusion };
}

describe("aggregateChecks", () => {
  it("returns null on empty input (UI: empty ring)", () => {
    expect(aggregateChecks([])).toBeNull();
  });

  it("returns passed when all completed-success", () => {
    expect(aggregateChecks([
      run("a", "completed", "success"),
      run("b", "completed", "success"),
    ])).toBe("passed");
  });

  it("returns failed if any run has a failed-ish conclusion", () => {
    expect(aggregateChecks([
      run("a", "completed", "success"),
      run("b", "completed", "failure"),
    ])).toBe("failed");
  });

  it("treats timed_out, action_required, startup_failure as failed", () => {
    for (const c of ["timed_out", "action_required", "startup_failure"]) {
      expect(aggregateChecks([
        run("a", "completed", "success"),
        run("b", "completed", c),
      ])).toBe("failed");
    }
  });

  it("treats skipped checks as 'not really run' — all-skipped → status 'skipped' (NOT null)", () => {
    expect(aggregateChecks([
      run("a", "completed", "skipped"),
      run("b", "completed", "skipped"),
    ])).toBe("skipped");
  });

  it("the lfortran #11484 fixture (8 skipped exhaustive checks) → 'skipped'", () => {
    // Before this fix the aggregator returned 'passed' (wrong: green dot for
    // checks that never ran). After the first fix it returned null (empty
    // ring). The current behavior: 'skipped', so the UI shows a distinct
    // gray-slash icon — clearer than an empty ring, which means "no checks".
    expect(aggregateChecks([
      run("Test LLVM ...",                "completed", "skipped"),
      run("build-and-push-image",         "completed", "skipped"),
      run("Documentation",                "completed", "skipped"),
      run("Check Out-of-Source Debug…",   "completed", "skipped"),
      run("Upload Tarball",               "completed", "skipped"),
      run("Check Release build",          "completed", "skipped"),
      run("Test without LLVM Backend",    "completed", "skipped"),
      run("Test MLIR backend",            "completed", "skipped"),
    ])).toBe("skipped");
  });

  it("a single cancelled check → 'skipped' (cancelled is in the not-really-run set)", () => {
    expect(aggregateChecks([run("a", "completed", "cancelled")])).toBe("skipped");
  });

  it("neutral and stale alone also map to 'skipped'", () => {
    expect(aggregateChecks([
      run("a", "completed", "neutral"),
      run("b", "completed", "stale"),
    ])).toBe("skipped");
  });

  it("a single passing check next to skipped checks → passed", () => {
    expect(aggregateChecks([
      run("a", "completed", "success"),
      run("b", "completed", "skipped"),
      run("c", "completed", "skipped"),
    ])).toBe("passed");
  });

  it("returns running if any in_progress AND no failures", () => {
    expect(aggregateChecks([
      run("a", "completed", "success"),
      run("b", "in_progress"),
    ])).toBe("running");
  });

  it("returns queued if any queued and no in_progress/failure", () => {
    expect(aggregateChecks([
      run("a", "completed", "success"),
      run("b", "queued"),
    ])).toBe("queued");
  });

  it("failure beats running (failure is decisive)", () => {
    expect(aggregateChecks([
      run("a", "in_progress"),
      run("b", "completed", "failure"),
    ])).toBe("failed");
  });

  it("running beats queued", () => {
    expect(aggregateChecks([
      run("a", "queued"),
      run("b", "in_progress"),
    ])).toBe("running");
  });

  it("treats cancelled / skipped / neutral / stale as not-really-run (→ 'skipped')", () => {
    expect(aggregateChecks([
      run("b", "completed", "cancelled"),
      run("c", "completed", "skipped"),
      run("d", "completed", "neutral"),
      run("e", "completed", "stale"),
    ])).toBe("skipped");
    // But a single real success carries the bucket.
    expect(aggregateChecks([
      run("a", "completed", "success"),
      run("b", "completed", "cancelled"),
      run("c", "completed", "skipped"),
      run("d", "completed", "neutral"),
      run("e", "completed", "stale"),
    ])).toBe("passed");
  });

  it("waiting/pending/requested map to queued", () => {
    for (const s of ["waiting", "pending", "requested"]) {
      expect(aggregateChecks([run("a", s)])).toBe("queued");
    }
  });

  it("matches the lfortran-style PR (#11488) fixture", () => {
    // 23 check runs, mixed states. The aggregator should return "queued"
    // because there are queued runs and no failures or in_progress.
    const runs: GhCheckRun[] = [
      run("Test LLVM 19 (ubuntu-latest)", "queued"),
      run("Test LLVM 21 (ubuntu-latest)", "queued"),
      run("Test LLVM 22 (macos-latest)",  "completed", "success"),
      run("Test LLVM 22 (ubuntu-latest)", "queued"),
      run("Test LLVM 15 (ubuntu-latest)", "queued"),
      run("Test LLVM 11 (ubuntu-latest)", "queued"),
      run("Test LLVM 17 (ubuntu-latest)", "queued"),
    ];
    expect(aggregateChecks(runs)).toBe("queued");
  });
});
