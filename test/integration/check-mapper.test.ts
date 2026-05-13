/**
 * Unit tests for the check-name → kind mapper.
 * Pure function — no D1, no Worker.
 */
import { describe, it, expect } from "vitest";
import { mapCheckToKind, type CheckMapping } from "../../src/lib/check-mapper";

const defaults: CheckMapping[] = [
  { pattern: "Build LFortran to WASM and Upload", kind: "quick",      matchType: "exact", priority: 100 },
  { pattern: "LFortran CI (OS=*, LLVM=*)",        kind: "quick",      matchType: "glob",  priority: 100 },
  { pattern: "*",                                 kind: "exhaustive", matchType: "glob",  priority: 1 },
];

describe("mapCheckToKind", () => {
  it("exact-matches the WASM build job into quick", () => {
    expect(mapCheckToKind("Build LFortran to WASM and Upload", defaults)).toBe("quick");
  });

  it("globs every LFortran CI matrix job into quick", () => {
    expect(mapCheckToKind("LFortran CI (OS=ubuntu-latest, LLVM=11)", defaults)).toBe("quick");
    expect(mapCheckToKind("LFortran CI (OS=ubuntu-latest, LLVM=21)", defaults)).toBe("quick");
    expect(mapCheckToKind("LFortran CI (OS=macos-latest, LLVM=11)", defaults)).toBe("quick");
    expect(mapCheckToKind("LFortran CI (OS=macos-latest, LLVM=21)", defaults)).toBe("quick");
    expect(mapCheckToKind("LFortran CI (OS=windows-2025, LLVM=11)", defaults)).toBe("quick");
  });

  it("buckets every other check into exhaustive via the * catchall", () => {
    expect(mapCheckToKind("Test LLVM 8 (ubuntu-latest)", defaults)).toBe("exhaustive");
    expect(mapCheckToKind("Test LLVM 22 (macos-latest)", defaults)).toBe("exhaustive");
    expect(mapCheckToKind("Check Out-of-Source Debug build", defaults)).toBe("exhaustive");
    expect(mapCheckToKind("Check Release build", defaults)).toBe("exhaustive");
    expect(mapCheckToKind("Test MLIR backend", defaults)).toBe("exhaustive");
    expect(mapCheckToKind("Documentation", defaults)).toBe("exhaustive");
    expect(mapCheckToKind("Upload Tarball", defaults)).toBe("exhaustive");
    expect(mapCheckToKind("Test without LLVM Backend", defaults)).toBe("exhaustive");
    expect(mapCheckToKind("build-and-push-image", defaults)).toBe("exhaustive");
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

  it("Quick patterns at high priority override the * catchall (exhaustive at priority 1)", () => {
    expect(mapCheckToKind("LFortran CI (OS=ubuntu-latest, LLVM=11)", defaults)).toBe("quick");
    expect(mapCheckToKind("Build LFortran to WASM and Upload", defaults)).toBe("quick");
  });
});
