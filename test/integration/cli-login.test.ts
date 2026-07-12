/**
 * /auth/cli-login — browser handshake used by `githost login`.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/worker";
import { resetDbs } from "../helpers/db";

beforeEach(resetDbs);

async function fetchSelf(
  input: RequestInfo | URL,
  init?: RequestInit,
  envOverride?: Partial<typeof env>,
): Promise<Response> {
  const req = input instanceof Request ? input : new Request(input, init);
  const ctx = {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  return worker.fetch(req, { ...env, ...envOverride }, ctx);
}

describe("/auth/cli-login", () => {
  it("400s on bad port or state", async () => {
    const badPort = await fetchSelf(
      "https://example.com/auth/cli-login?port=80&state=abcdefghij",
      undefined,
      { DEV_LOGIN_ENABLED: "true" } as Partial<typeof env>,
    );
    expect(badPort.status).toBe(400);

    const badState = await fetchSelf(
      "https://example.com/auth/cli-login?port=12345&state=short",
      undefined,
      { DEV_LOGIN_ENABLED: "true" } as Partial<typeof env>,
    );
    expect(badState.status).toBe(400);
  });

  it("with DEV_LOGIN_ENABLED redirects to localhost with session", async () => {
    const state = "teststate123456";
    const res = await fetchSelf(
      `https://example.com/auth/cli-login?port=54321&state=${state}&login=cliuser`,
      undefined,
      { DEV_LOGIN_ENABLED: "true" } as Partial<typeof env>,
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc.startsWith("http://127.0.0.1:54321/")).toBe(true);
    const u = new URL(loc);
    expect(u.searchParams.get("state")).toBe(state);
    expect(u.searchParams.get("login")).toBe("cliuser");
    const session = u.searchParams.get("session");
    expect(session && session.length > 8).toBe(true);

    // Session exists in D1
    const row = await env.APP_DB.prepare(
      "SELECT id FROM user_session WHERE id = ?",
    )
      .bind(session)
      .first();
    expect(row).not.toBeNull();

    // Browser cookie also set for SPA convenience
    expect(res.headers.get("set-cookie") ?? "").toMatch(/gh_session=/);
  });

  it("without DEV_LOGIN_ENABLED starts OAuth and sets CLI cookies", async () => {
    const res = await fetchSelf(
      "https://example.com/auth/cli-login?port=54321&state=oauthstate1234",
    );
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc).toContain("github.com/login/oauth/authorize");
    const setCookie = res.headers.get("set-cookie") ?? "";
    // wrangler/test may join cookies; accept either header aggregation
    expect(setCookie.includes("gh_cli_port") || setCookie.includes("54321")).toBe(
      true,
    );
  });
});
