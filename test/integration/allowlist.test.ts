/**
 * GitHub OAuth callback + allowlist tests.
 *
 * The callback handler does two outbound HTTP requests:
 *   1. POST github.com/login/oauth/access_token   → exchange code for access token
 *   2. GET  api.github.com/user                   → identify the user
 *
 * We mock both via MSW (configured in test/setup.ts) and drive the full flow:
 *   /auth/login → state cookie → /auth/callback?code=…&state=… → assert outcome
 *
 * Critical invariant: ONLY logins in ALLOWED_GITHUB_LOGINS may successfully
 * complete the callback. Everyone else gets 403.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { http, HttpResponse } from "msw";
import worker from "../../src/worker";
import { resetDbs } from "../helpers/db";
import { mswServer } from "../msw-server";

beforeEach(resetDbs);

async function fetchSelf(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : new Request(input, init);
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
  return worker.fetch(req, env, ctx);
}

/** Extract a single cookie's value from a Set-Cookie header. */
function readSetCookie(setCookie: string | null, name: string): string | undefined {
  if (!setCookie) return undefined;
  const match = setCookie.match(new RegExp(`(?:^|,\\s*)${name}=([^;]+)`));
  return match?.[1];
}

/** Mock the OAuth code-exchange + /user identification calls for one login. */
function mockGithubExchange(opts: { login: string; ghUserId?: number; accessToken?: string }): void {
  const accessToken = opts.accessToken ?? "ghp_test_token";
  mswServer.use(
    http.post("https://github.com/login/oauth/access_token", () => {
      return HttpResponse.json({ access_token: accessToken, scope: "read:user", token_type: "bearer" });
    }),
    http.get("https://api.github.com/user", () => {
      return HttpResponse.json({ id: opts.ghUserId ?? 42, login: opts.login });
    }),
  );
}

/** Drive /auth/login to obtain a valid OAuth state + cookie. */
async function startOauthFlow(): Promise<{ state: string; stateCookie: string }> {
  const res = await fetchSelf("https://example.com/auth/login");
  const setCookie = res.headers.get("set-cookie") ?? "";
  const state = readSetCookie(setCookie, "gh_oauth_state") ?? "";
  if (!state) throw new Error(`No gh_oauth_state cookie in: ${setCookie}`);
  return { state, stateCookie: `gh_oauth_state=${state}` };
}

describe("/auth/callback allowlist", () => {
  it("admits a login in ALLOWED_GITHUB_LOGINS (e.g. alice)", async () => {
    const { state, stateCookie } = await startOauthFlow();
    mockGithubExchange({ login: "alice" });

    const res = await fetchSelf(
      `https://example.com/auth/callback?code=test-code&state=${state}`,
      { headers: { cookie: stateCookie } },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");

    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/gh_session=/);

    const user = await env.APP_DB.prepare(
      "SELECT login FROM app_user WHERE login = ?"
    ).bind("alice").first();
    expect(user).not.toBeNull();
  });

  it("rejects a login NOT in ALLOWED_GITHUB_LOGINS with a styled 403", async () => {
    const { state, stateCookie } = await startOauthFlow();
    mockGithubExchange({ login: "mallory" });

    const res = await fetchSelf(
      `https://example.com/auth/callback?code=test-code&state=${state}`,
      { headers: { cookie: stateCookie } },
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type") ?? "").toMatch(/html/);
    const html = await res.text();
    expect(html).toContain("Access denied");
    expect(html).toContain("@mallory");

    const user = await env.APP_DB.prepare(
      "SELECT login FROM app_user WHERE login = ?"
    ).bind("mallory").first();
    expect(user).toBeNull();
    expect(res.headers.get("set-cookie") ?? "").not.toMatch(/gh_session=/);
  });

  it("rejects a callback with a mismatched OAuth state", async () => {
    const { stateCookie } = await startOauthFlow();
    // Handler should bail on state mismatch before any outbound call;
    // no MSW handler installed.
    const res = await fetchSelf(
      `https://example.com/auth/callback?code=test-code&state=wrong-state`,
      { headers: { cookie: stateCookie } },
    );
    expect(res.status).toBe(400);
  });

  it("is case-insensitive on login matching (Alice == alice)", async () => {
    const { state, stateCookie } = await startOauthFlow();
    // GitHub returns "Alice" (mixed case). ALLOWED_GITHUB_LOGINS has "alice".
    mockGithubExchange({ login: "Alice" });

    const res = await fetchSelf(
      `https://example.com/auth/callback?code=test-code&state=${state}`,
      { headers: { cookie: stateCookie } },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });
});
