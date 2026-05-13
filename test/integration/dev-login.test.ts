/**
 * Tests for /auth/dev-login — the local-dev shortcut that bypasses GitHub
 * OAuth. Must be 404 unless DEV_LOGIN_ENABLED === "true".
 */
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/worker";
import { resetDbs } from "../helpers/db";

beforeEach(resetDbs);

async function fetchSelf(input: RequestInfo | URL, init?: RequestInit, envOverride?: Partial<typeof env>): Promise<Response> {
  const req = input instanceof Request ? input : new Request(input, init);
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
  return worker.fetch(req, { ...env, ...envOverride }, ctx);
}

describe("/auth/dev-login", () => {
  it("404s when DEV_LOGIN_ENABLED is not 'true' (production behavior)", async () => {
    // Test config does NOT set DEV_LOGIN_ENABLED (see vitest.config.ts), so this
    // is the default state. Mirrors what happens in production.
    const res = await fetchSelf("https://example.com/auth/dev-login");
    expect(res.status).toBe(404);
  });

  it("404s for any other value of DEV_LOGIN_ENABLED ('false', 'yes', '1', empty)", async () => {
    for (const val of ["false", "yes", "1", ""]) {
      const res = await fetchSelf(
        "https://example.com/auth/dev-login",
        undefined,
        { DEV_LOGIN_ENABLED: val } as Partial<typeof env>,
      );
      expect(res.status, `value ${JSON.stringify(val)}`).toBe(404);
    }
  });

  it("logs in as 'dev' by default when enabled", async () => {
    const res = await fetchSelf(
      "https://example.com/auth/dev-login",
      undefined,
      { DEV_LOGIN_ENABLED: "true" } as Partial<typeof env>,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.get("set-cookie") ?? "").toMatch(/gh_session=/);

    const row = await env.APP_DB.prepare(
      "SELECT login FROM app_user WHERE login = ?"
    ).bind("dev").first();
    expect(row).not.toBeNull();
  });

  it("respects ?login=<name>", async () => {
    const res = await fetchSelf(
      "https://example.com/auth/dev-login?login=alice",
      undefined,
      { DEV_LOGIN_ENABLED: "true" } as Partial<typeof env>,
    );
    expect(res.status).toBe(302);
    const row = await env.APP_DB.prepare(
      "SELECT login FROM app_user WHERE login = ?"
    ).bind("alice").first();
    expect(row).not.toBeNull();
  });

  it("is idempotent — repeat calls reuse the same app_user row", async () => {
    const init = { DEV_LOGIN_ENABLED: "true" } as Partial<typeof env>;
    await fetchSelf("https://example.com/auth/dev-login?login=alice", undefined, init);
    await fetchSelf("https://example.com/auth/dev-login?login=alice", undefined, init);
    const count = await env.APP_DB.prepare(
      "SELECT COUNT(*) AS c FROM app_user WHERE login = ?"
    ).bind("alice").first<{ c: number }>();
    expect(count?.c).toBe(1);
    // Each call creates a fresh session row though.
    const sessions = await env.APP_DB.prepare(
      "SELECT COUNT(*) AS c FROM user_session"
    ).first<{ c: number }>();
    expect(sessions?.c).toBe(2);
  });

  it("bypasses the ALLOWED_GITHUB_LOGINS allowlist by design", async () => {
    // A name that isn't in ALLOWED_GITHUB_LOGINS ("alice,bob" in test config).
    const res = await fetchSelf(
      "https://example.com/auth/dev-login?login=mallory",
      undefined,
      { DEV_LOGIN_ENABLED: "true" } as Partial<typeof env>,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie") ?? "").toMatch(/gh_session=/);
  });

  it("issued session actually authenticates subsequent requests", async () => {
    const init = { DEV_LOGIN_ENABLED: "true" } as Partial<typeof env>;
    const loginRes = await fetchSelf("https://example.com/auth/dev-login", undefined, init);
    const setCookie = loginRes.headers.get("set-cookie") ?? "";
    const sessionMatch = setCookie.match(/gh_session=([^;]+)/);
    expect(sessionMatch).not.toBeNull();
    const cookie = `gh_session=${sessionMatch![1]}`;

    // Same env override required so DEV_LOGIN_ENABLED stays consistent — but
    // for /api/me we just need the cookie to validate against APP_DB.
    const meRes = await fetchSelf("https://example.com/api/me", { headers: { cookie } });
    const body = await meRes.json<{ user: { login: string } | null }>();
    expect(body.user?.login).toBe("dev");
  });
});
