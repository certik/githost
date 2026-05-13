/**
 * Unit tests for the check-name → kind mapper.
 * Pure function — no D1, no Worker.
 */
import { describe, it, expect } from "vitest";
import { mapCheckToKind, type CheckMapping } from "../../src/lib/check-mapper";

const defaults: CheckMapping[] = [
  { pattern: "LFortran CI (OS=ubuntu-latest, LLVM=11)", kind: "quick", matchType: "exact", priority: 100 },
  { pattern: "Test without LLVM Backend",               kind: "quick", matchType: "exact", priority: 100 },
  { pattern: "Check Release build",                     kind: "quick", matchType: "exact", priority: 100 },
  { pattern: "Test LLVM * (*)",                         kind: "exhaustive", matchType: "glob", priority: 50 },
  { pattern: "LFortran CI (OS=*, LLVM=*)",              kind: "exhaustive", matchType: "glob", priority: 40 },
];

describe("mapCheckToKind", () => {
  it("exact matches the seeded quick checks", () => {
    expect(mapCheckToKind("LFortran CI (OS=ubuntu-latest, LLVM=11)", defaults)).toBe("quick");
    expect(mapCheckToKind("Test without LLVM Backend", defaults)).toBe("quick");
    expect(mapCheckToKind("Check Release build", defaults)).toBe("quick");
  });

  it("globs into exhaustive for the LLVM matrix", () => {
    expect(mapCheckToKind("Test LLVM 8 (ubuntu-latest)", defaults)).toBe("exhaustive");
    expect(mapCheckToKind("Test LLVM 22 (macos-latest)", defaults)).toBe("exhaustive");
    expect(mapCheckToKind("Test LLVM 19 (ubuntu-latest)", defaults)).toBe("exhaustive");
  });

  it("globs into exhaustive for other LFortran CI OS/LLVM combos", () => {
    expect(mapCheckToKind("LFortran CI (OS=macos-latest, LLVM=21)", defaults)).toBe("exhaustive");
    expect(mapCheckToKind("LFortran CI (OS=windows-2025, LLVM=11)", defaults)).toBe("exhaustive");
  });

  it("higher-priority exact wins over lower-priority glob", () => {
    // 'LFortran CI (OS=ubuntu-latest, LLVM=11)' matches BOTH the exact (priority
    // 100) and the OS=*, LLVM=* glob (priority 40). The exact must win.
    expect(mapCheckToKind("LFortran CI (OS=ubuntu-latest, LLVM=11)", defaults)).toBe("quick");
  });

  it("returns null for unmapped check names", () => {
    expect(mapCheckToKind("Documentation", defaults)).toBeNull();
    expect(mapCheckToKind("Upload Tarball", defaults)).toBeNull();
    expect(mapCheckToKind("build-and-push-image", defaults)).toBeNull();
    expect(mapCheckToKind("Test MLIR backend", defaults)).toBeNull();
  });

  it("returns null when mappings is empty", () => {
    expect(mapCheckToKind("anything", [])).toBeNull();
  });

  it("globs escape regex metacharacters in literal segments", () => {
    const m: CheckMapping[] = [
      { pattern: "build.x86_64 (gcc)", kind: "quick", matchType: "exact", priority: 1 },
      { pattern: "build.* (gcc)",      kind: "exhaustive", matchType: "glob",  priority: 1 },
    ];
    // exact wins on the literal name…
    expect(mapCheckToKind("build.x86_64 (gcc)", m)).toBe("quick");
    // …and `.` in the glob matches a literal `.`, not "any char" (regex semantics).
    expect(mapCheckToKind("buildXx86_64 (gcc)", m)).toBeNull();
    expect(mapCheckToKind("build.arm64 (gcc)", m)).toBe("exhaustive");
  });

  it("tie-breaks on match type (exact beats glob) when priorities are equal", () => {
    const m: CheckMapping[] = [
      { pattern: "Test foo",          kind: "quick",      matchType: "exact", priority: 50 },
      { pattern: "Test *",            kind: "exhaustive", matchType: "glob",  priority: 50 },
    ];
    // Both match "Test foo"; exact wins.
    expect(mapCheckToKind("Test foo", m)).toBe("quick");
    // Only glob matches "Test bar".
    expect(mapCheckToKind("Test bar", m)).toBe("exhaustive");
  });

  it("tie-breaks on pattern length (shorter wins) within the same match type", () => {
    const m: CheckMapping[] = [
      { pattern: "Test *",            kind: "quick",      matchType: "glob", priority: 50 },
      { pattern: "Test * (*)",        kind: "exhaustive", matchType: "glob", priority: 50 },
    ];
    // "Test LLVM 8 (ubuntu)" matches both globs at priority 50; pattern length
    // "Test *" = 6 vs "Test * (*)" = 10 → shorter wins → quick. In practice
    // you'd give the more specific pattern higher priority to override this.
    expect(mapCheckToKind("Test LLVM 8 (ubuntu)", m)).toBe("quick");
    expect(mapCheckToKind("Test foo", m)).toBe("quick");
  });
});
