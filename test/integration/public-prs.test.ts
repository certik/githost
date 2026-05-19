/**
 * Contract tests for the public front page:
 *   - `GET /api/prs` is reachable without a session and returns the top-50
 *     slice regardless of `limit` / `offset` overrides (anti-scraping).
 *   - The anonymous response carries `Cache-Control` so Cloudflare's edge can
 *     absorb repeat hits without invoking the Worker.
 *   - Authenticated callers keep the original paging contract and do NOT
 *     receive `Cache-Control` (their responses may vary by user).
 *   - Every other PR-related endpoint still 401s anonymously.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/worker";
import { resetDbs } from "../helpers/db";
import { createSession } from "../helpers/session";
import { seedPr } from "../helpers/fixtures";

beforeEach(resetDbs);

async function fetchSelf(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : new Request(input, init);
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
  return worker.fetch(req, env, ctx);
}

async function seedPrs(count: number): Promise<void> {
  for (let i = 1; i <= count; i++) {
    await seedPr({ id: i, number: i, title: `PR ${i}` });
  }
}

describe("public /api/prs (anonymous)", () => {
  it("returns 200 with no session", async () => {
    await seedPrs(3);
    const res = await fetchSelf("https://example.com/api/prs");
    expect(res.status).toBe(200);
    const body = await res.json<{ items: unknown[]; limit: number; offset: number }>();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBe(3);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
  });

  it("serializes updatedAt and createdAt as epoch-ms numbers (not ISO strings)", async () => {
    // The SPA does arithmetic on these timestamps (relative-time formatter);
    // if Drizzle's Date object leaks into the JSON response we'd get
    // "NaN ago" everywhere. Lock the wire format here.
    await seedPrs(1);
    const res = await fetchSelf("https://example.com/api/prs");
    const body = await res.json<{ items: Array<{ updatedAt: unknown; createdAt: unknown }> }>();
    expect(body.items.length).toBe(1);
    const item = body.items[0]!;
    expect(typeof item.updatedAt).toBe("number");
    expect(typeof item.createdAt).toBe("number");
    expect(Number.isFinite(item.updatedAt as number)).toBe(true);
    expect(Number.isFinite(item.createdAt as number)).toBe(true);
  });

  it("caps anonymous response at 50 items even when ?limit=200 is requested", async () => {
    // Seed 60 PRs and ask for 200 — anon should still get 50.
    await seedPrs(60);
    const res = await fetchSelf("https://example.com/api/prs?limit=200");
    expect(res.status).toBe(200);
    const body = await res.json<{ items: unknown[]; limit: number; offset: number }>();
    expect(body.items.length).toBe(50);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
  });

  it("ignores ?offset for anonymous callers (always offset=0)", async () => {
    await seedPrs(5);
    const res = await fetchSelf("https://example.com/api/prs?offset=999");
    expect(res.status).toBe(200);
    const body = await res.json<{ items: unknown[]; offset: number }>();
    expect(body.offset).toBe(0);
    expect(body.items.length).toBe(5);
  });

  it("sets Cache-Control on the anonymous response", async () => {
    const res = await fetchSelf("https://example.com/api/prs");
    expect(res.status).toBe(200);
    const cc = res.headers.get("cache-control") ?? "";
    expect(cc).toMatch(/public/);
    expect(cc).toMatch(/max-age=\d+/);
    expect(cc).toMatch(/s-maxage=\d+/);
  });
});

describe("authenticated /api/prs keeps full paging", () => {
  it("respects ?limit when a session is present", async () => {
    const { cookie } = await createSession({ login: "alice" });
    await seedPrs(60);
    const res = await fetchSelf("https://example.com/api/prs?limit=100", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json<{ items: unknown[]; limit: number; offset: number }>();
    expect(body.limit).toBe(100);
    expect(body.items.length).toBe(60);
  });

  it("respects ?offset when a session is present", async () => {
    const { cookie } = await createSession({ login: "alice" });
    await seedPrs(5);
    const res = await fetchSelf("https://example.com/api/prs?limit=2&offset=2", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json<{ items: unknown[]; limit: number; offset: number }>();
    expect(body.offset).toBe(2);
    expect(body.items.length).toBe(2);
  });

  it("does NOT set Cache-Control on the authenticated response", async () => {
    const { cookie } = await createSession({ login: "alice" });
    const res = await fetchSelf("https://example.com/api/prs", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBeNull();
  });
});

describe("other PR endpoints stay behind login", () => {
  it("GET /api/prs/:number 401s anonymously", async () => {
    await seedPrs(1);
    const res = await fetchSelf("https://example.com/api/prs/1");
    expect(res.status).toBe(401);
  });

  it("GET /api/prs/:number/diff 401s anonymously", async () => {
    await seedPrs(1);
    const res = await fetchSelf("https://example.com/api/prs/1/diff");
    expect(res.status).toBe(401);
  });
});
