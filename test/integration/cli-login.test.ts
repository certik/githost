/**
 * /auth/cli-device — device-code handshake used by `githost login`.
 * No local TCP listener; browser opens a verification URL and the CLI polls.
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

describe("/auth/cli-device", () => {
  it("start returns device + user codes and verification URL", async () => {
    const res = await fetchSelf("https://example.com/auth/cli-device/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login: "cliuser" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      device_code: string;
      user_code: string;
      verification_uri_complete: string;
      interval: number;
      expires_in: number;
    };
    expect(body.device_code.length).toBeGreaterThan(8);
    expect(body.user_code.length).toBeGreaterThan(4);
    expect(body.verification_uri_complete).toContain("user_code=");
    expect(body.verification_uri_complete).toContain(body.user_code);
    expect(body.interval).toBe(1);
    expect(body.expires_in).toBeGreaterThan(60);
  });

  it("poll is pending until browser authorizes, then complete", async () => {
    const start = await fetchSelf("https://example.com/auth/cli-device/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login: "cliuser" }),
    });
    const { device_code, user_code, verification_uri_complete } = (await start.json()) as {
      device_code: string;
      user_code: string;
      verification_uri_complete: string;
    };

    const pending = await fetchSelf("https://example.com/auth/cli-device/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code }),
    });
    expect(pending.status).toBe(200);
    expect(await pending.json()).toEqual({ status: "pending" });

    // Browser hits verification URL with DEV_LOGIN_ENABLED → mints session.
    const browser = await fetchSelf(verification_uri_complete, undefined, {
      DEV_LOGIN_ENABLED: "true",
    } as Partial<typeof env>);
    expect(browser.status).toBe(200);
    const html = await browser.text();
    expect(html).toContain("CLI authorized");
    expect(html).toContain("@cliuser");
    expect(browser.headers.get("set-cookie") ?? "").toMatch(/gh_session=/);

    const done = await fetchSelf("https://example.com/auth/cli-device/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code }),
    });
    expect(done.status).toBe(200);
    const complete = (await done.json()) as {
      status: string;
      session: string;
      login: string;
    };
    expect(complete.status).toBe("complete");
    expect(complete.login).toBe("cliuser");
    expect(complete.session.length).toBeGreaterThan(8);

    const row = await env.APP_DB.prepare(
      "SELECT id FROM user_session WHERE id = ?",
    )
      .bind(complete.session)
      .first();
    expect(row).not.toBeNull();

    // user_code was part of the flow
    expect(user_code.length).toBeGreaterThan(0);
  });

  it("poll without device_code is 400", async () => {
    const res = await fetchSelf("https://example.com/auth/cli-device/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("unknown device_code is expired", async () => {
    const res = await fetchSelf("https://example.com/auth/cli-device/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: "does-not-exist" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "expired" });
  });

  it("missing user_code on GET is 400", async () => {
    const res = await fetchSelf("https://example.com/auth/cli-device");
    expect(res.status).toBe(400);
  });

  it("without DEV_LOGIN_ENABLED starts OAuth and sets user_code cookie", async () => {
    const start = await fetchSelf("https://example.com/auth/cli-device/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const { user_code, verification_uri_complete } = (await start.json()) as {
      user_code: string;
      verification_uri_complete: string;
    };

    const res = await fetchSelf(verification_uri_complete, undefined, {
      DEV_LOGIN_ENABLED: "false",
      GITHUB_OAUTH_CLIENT_ID: "test-client-id",
    } as Partial<typeof env>);
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc).toContain("github.com/login/oauth/authorize");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie.includes("gh_cli_user_code") || setCookie.includes(user_code)).toBe(
      true,
    );
  });
});
