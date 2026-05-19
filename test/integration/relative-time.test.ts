/**
 * Unit tests for the relative-time formatter used by the PR list.
 *
 * Pure logic — no DOM/React. Runs in @cloudflare/vitest-pool-workers like
 * the rest of our tests; that's fine because there's no runtime dependency
 * on the browser.
 */
import { describe, it, expect } from "vitest";
import { formatRelativeTime, formatAbsoluteTime } from "../../web/src/lib/relative-time";

const NOW = Date.UTC(2026, 4, 18, 12, 0, 0); // 2026-05-18 12:00:00 UTC

const sec = 1000;
const min = 60 * sec;
const hr = 60 * min;
const day = 24 * hr;

describe("formatRelativeTime", () => {
  it("returns 'just now' for very recent timestamps", () => {
    expect(formatRelativeTime(NOW - 0, NOW)).toBe("just now");
    expect(formatRelativeTime(NOW - 44 * sec, NOW)).toBe("just now");
  });

  it("flips to minutes at the 45-second boundary", () => {
    expect(formatRelativeTime(NOW - 45 * sec, NOW)).toBe("0m ago");
    expect(formatRelativeTime(NOW - 1 * min, NOW)).toBe("1m ago");
    expect(formatRelativeTime(NOW - 59 * min, NOW)).toBe("59m ago");
  });

  it("flips to hours at 60 minutes", () => {
    expect(formatRelativeTime(NOW - 60 * min, NOW)).toBe("1h ago");
    expect(formatRelativeTime(NOW - 23 * hr, NOW)).toBe("23h ago");
  });

  it("flips to days at 24 hours", () => {
    expect(formatRelativeTime(NOW - 24 * hr, NOW)).toBe("1d ago");
    expect(formatRelativeTime(NOW - 6 * day, NOW)).toBe("6d ago");
  });

  it("flips to weeks at 7 days, months at 30 days, years at 365 days", () => {
    expect(formatRelativeTime(NOW - 7 * day, NOW)).toBe("1w ago");
    expect(formatRelativeTime(NOW - 29 * day, NOW)).toBe("4w ago");
    expect(formatRelativeTime(NOW - 30 * day, NOW)).toBe("1mo ago");
    expect(formatRelativeTime(NOW - 364 * day, NOW)).toBe("12mo ago");
    expect(formatRelativeTime(NOW - 365 * day, NOW)).toBe("1y ago");
    expect(formatRelativeTime(NOW - 3 * 365 * day, NOW)).toBe("3y ago");
  });

  it("clamps future timestamps to 'just now' (skewed client clock)", () => {
    expect(formatRelativeTime(NOW + 10 * min, NOW)).toBe("just now");
  });

  it("falls back to Date.now() when called without an explicit `now`", () => {
    // We can't pin Date.now() here without mocking, but at minimum we can
    // assert the helper still produces one of the canonical formats.
    const out = formatRelativeTime(Date.now() - 5 * min);
    expect(out).toMatch(/^(just now|\d+m ago)$/);
  });
});

describe("formatAbsoluteTime", () => {
  it("formats as 'YYYY-MM-DD HH:MM' (local time)", () => {
    // Use a fixed ms value so the output is stable per timezone — we only
    // assert the shape, not the specific digits, because the test runner's
    // TZ isn't guaranteed.
    const out = formatAbsoluteTime(NOW);
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});
