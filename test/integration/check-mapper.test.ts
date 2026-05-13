/**
 * Unit tests for the check-name → kind mapper.
 *
 * Patterns are matched against the workflow-prefixed display name
 * (`<workflow> / <check>`). Bucket all "Quick checks / ..." jobs to quick,
 * "Exhaustive checks / ..." to exhaustive, with a fallback glob for any
 * stray "Test LLVM N (...)" jobs outside those workflows.
 */
import { describe, it, expect } from "vitest";
import { mapCheckToKind, type CheckMapping } from "../../src/lib/check-mapper";

const defaults: CheckMapping[] = [
  { pattern: "Quick checks / *",      kind: "quick",      matchType: "glob", priority: 100 },
  { pattern: "Exhaustive checks / *", kind: "exhaustive", matchType: "glob", priority: 100 },
  { pattern: "Test LLVM * (*)",       kind: "exhaustive", matchType: "glob", priority: 50 },
];

describe("mapCheckToKind", () => {
  it("globs every Quick checks job into quick", () => {
    expect(mapCheckToKind("Quick checks / LFortran CI (OS=ubuntu-latest, LLVM=11)", defaults)).toBe("quick");
    expect(mapCheckToKind("Quick checks / LFortran CI (OS=macos-latest, LLVM=21)", defaults)).toBe("quick");
    expect(mapCheckToKind("Quick checks / LFortran CI (OS=windows-2025, LLVM=11)", defaults)).toBe("quick");
    expect(mapCheckToKind("Quick checks / Build LFortran to WASM and Upload", defaults)).toBe("quick");
  });

  it("globs every Exhaustive checks job into exhaustive", () => {
    expect(mapCheckToKind("Exhaustive checks / Test LLVM 19 (ubuntu-latest)", defaults)).toBe("exhaustive");
    expect(mapCheckToKind("Exhaustive checks / Test MLIR backend", defaults)).toBe("exhaustive");
  });

  it("falls through to the bare Test LLVM glob for unprefixed names", () => {
    // Some workflows surface the test as a top-level check without a workflow prefix.
    expect(mapCheckToKind("Test LLVM 8 (ubuntu-latest)", defaults)).toBe("exhaustive");
  });

  it("returns null for unmapped check names", () => {
    expect(mapCheckToKind("Documentation", defaults)).toBeNull();
    expect(mapCheckToKind("Upload Tarball", defaults)).toBeNull();
    expect(mapCheckToKind("build-and-push-image", defaults)).toBeNull();
    // Bare 'LFortran CI (...)' without the workflow prefix doesn't match anymore.
    expect(mapCheckToKind("LFortran CI (OS=ubuntu-latest, LLVM=11)", defaults)).toBeNull();
  });

  it("returns null when mappings is empty", () => {
    expect(mapCheckToKind("anything", [])).toBeNull();
  });

  it("globs escape regex metacharacters in literal segments", () => {
    const m: CheckMapping[] = [
      { pattern: "build.x86_64 (gcc)", kind: "quick", matchType: "exact", priority: 1 },
      { pattern: "build.* (gcc)",      kind: "exhaustive", matchType: "glob",  priority: 1 },
    ];
    expect(mapCheckToKind("build.x86_64 (gcc)", m)).toBe("quick");
    expect(mapCheckToKind("buildXx86_64 (gcc)", m)).toBeNull();
    expect(mapCheckToKind("build.arm64 (gcc)", m)).toBe("exhaustive");
  });

  it("tie-breaks on match type (exact beats glob) when priorities are equal", () => {
    const m: CheckMapping[] = [
      { pattern: "Test foo",          kind: "quick",      matchType: "exact", priority: 50 },
      { pattern: "Test *",            kind: "exhaustive", matchType: "glob",  priority: 50 },
    ];
    expect(mapCheckToKind("Test foo", m)).toBe("quick");
    expect(mapCheckToKind("Test bar", m)).toBe("exhaustive");
  });

  it("tie-breaks on pattern length (shorter wins) within the same match type", () => {
    const m: CheckMapping[] = [
      { pattern: "Test *",            kind: "quick",      matchType: "glob", priority: 50 },
      { pattern: "Test * (*)",        kind: "exhaustive", matchType: "glob", priority: 50 },
    ];
    expect(mapCheckToKind("Test LLVM 8 (ubuntu)", m)).toBe("quick");
    expect(mapCheckToKind("Test foo", m)).toBe("quick");
  });

  it("higher priority overrides a shorter glob", () => {
    const m: CheckMapping[] = [
      { pattern: "Test *",            kind: "quick",      matchType: "glob", priority: 10 },
      { pattern: "Test * (*)",        kind: "exhaustive", matchType: "glob", priority: 50 },
    ];
    // Even though "Test *" is shorter, the longer glob has higher priority.
    expect(mapCheckToKind("Test LLVM 8 (ubuntu)", m)).toBe("exhaustive");
  });
});
