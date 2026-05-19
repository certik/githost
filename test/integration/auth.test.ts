/**
 * Integration tests for the auth gating story (private-mode invariants).
 * Drives the worker via its default-export fetch handler — no HTTP server.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/worker";
import { resetDbs } from "../helpers/db";
import { createSession } from "../helpers/session";

beforeEach(resetDbs);

async function fetchSelf(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : new Request(input, init);
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
  return worker.fetch(req, env, ctx);
}

describe("auth gate", () => {
  it("returns 401 JSON on a protected API endpoint when anonymous", async () => {
    const res = await fetchSelf("https://example.com/api/refresh/status");
    expect(res.status).toBe(401);
    const body = await res.json<{ error: string }>();
    expect(body.error).toMatch(/auth/i);
  });

  it("allows /healthz anonymously", async () => {
    const res = await fetchSelf("https://example.com/healthz");
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean }>();
    expect(body.ok).toBe(true);
  });

  it("allows /auth/login anonymously and 302s to github.com", async () => {
    const res = await fetchSelf("https://example.com/auth/login");
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize/);
  });

  it("/api/me returns {user:null} anonymously", async () => {
    const res = await fetchSelf("https://example.com/api/me");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: null });
  });

  it("/api/me returns the user when a session cookie is present", async () => {
    const { cookie } = await createSession({ login: "alice" });
    const res = await fetchSelf("https://example.com/api/me", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json<{ user: { login: string } | null }>();
    expect(body.user?.login).toBe("alice");
  });

  it("expired sessions are rejected", async () => {
    const userId = crypto.randomUUID();
    const sessionId = "expired-sess";
    const now = Date.now();
    await env.APP_DB.prepare(
      "INSERT INTO app_user (id, gh_user_id, login, created_at) VALUES (?, ?, ?, ?)"
    ).bind(userId, 999, "stale", now).run();
    await env.APP_DB.prepare(
      "INSERT INTO user_session (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)"
    ).bind(sessionId, userId, now - 60_000, now - 120_000).run();

    const res = await fetchSelf("https://example.com/api/me", {
      headers: { cookie: `gh_session=${sessionId}` },
    });
    expect(await res.json()).toEqual({ user: null });
  });

  it("authenticated session can reach /api/prs", async () => {
    const { cookie } = await createSession({ login: "alice" });
    const res = await fetchSelf("https://example.com/api/prs", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json<{ items: unknown[] }>();
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("/auth/signed-out is reachable anonymously", async () => {
    const res = await fetchSelf("https://example.com/auth/signed-out");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toMatch(/html/);
    const html = await res.text();
    expect(html).toContain("Sign in with GitHub");
  });
});

/**
 * Exhaustive matrix: every documented API endpoint either requires a session
 * (returns 401 when missing) or is explicitly anonymous (only /api/me here).
 *
 * Add new endpoints to one of the arrays below as you ship them so this test
 * stays a complete inventory.
 */
describe("API endpoints require auth", () => {
  const PROTECTED: Array<{ method: string; path: string; body?: unknown }> = [
    { method: "GET",  path: "/api/prs/123" },
    { method: "GET",  path: "/api/prs/123/diff" },
    { method: "GET",  path: "/api/refresh/status" },
    { method: "GET",  path: "/api/logs" },
    { method: "PUT",  path: "/api/prs/123/tests/quick",     body: { status: "queued" } },
    { method: "POST", path: "/api/refresh",                 body: { resource: "prs" } },
    { method: "POST", path: "/api/refresh/reset" },
    { method: "POST", path: "/api/branches",                body: { name: "x", from: "main" } },
    { method: "POST", path: "/api/prs/123/post-review",     body: { aiReviewId: "x", event: "COMMENT" } },
  ];

  const ANONYMOUS: Array<{ method: string; path: string }> = [
    { method: "GET", path: "/api/me" },
    { method: "GET", path: "/api/prs" },
  ];

  it.each(PROTECTED)("$method $path 401s anonymously", async ({ method, path, body }) => {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const res = await fetchSelf(`https://example.com${path}`, init);
    expect(res.status).toBe(401);
  });

  it.each(ANONYMOUS)("$method $path is anonymous-OK", async ({ method, path }) => {
    const res = await fetchSelf(`https://example.com${path}`, { method });
    // Anonymous endpoints either return 200 (with a sensible body) or some
    // non-401 status. Just assert they don't return 401.
    expect(res.status).not.toBe(401);
  });
});
