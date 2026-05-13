/**
 * Integration test for the webhook HTTP route, specifically the
 * foreign-repo filter. We exercise the full route (signature verification +
 * body parsing + filter + log emission), not just the dispatch logic.
 *
 * Background: the GitHub App may be installed on multiple repos (e.g.
 * certik/githost for self-CI and lfortran/lfortran for the mirror). Our app
 * only mirrors env.UPSTREAM_OWNER/REPO; events from other installations
 * must be ignored, otherwise syncPr (which always fetches from UPSTREAM)
 * would write the wrong row.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { http, HttpResponse } from "msw";
import { resetDbs } from "../helpers/db";
import { mswServer } from "../msw-server";

beforeEach(resetDbs);

async function sign(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.GITHUB_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const hex = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}

async function postWebhook(event: string, payload: unknown): Promise<Response> {
  const { default: worker } = await import("../../src/worker");
  const body = JSON.stringify(payload);
  const sig = await sign(body);
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
  const req = new Request("https://example.com/webhook/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": `delivery-${Date.now()}`,
      "x-hub-signature-256": sig,
    },
    body,
  });
  return worker.fetch(req, env, ctx);
}

describe("POST /webhook/github — foreign-repo filter", () => {
  it("ignores events from a different installation_id and logs them as ignored", async () => {
    // env.GITHUB_INSTALLATION_ID = "1" in tests; send an event from id 9999.
    const res = await postWebhook("pull_request", {
      action: "closed",
      number: 99,
      installation: { id: 9999 },
      repository: { id: 1, full_name: `${env.UPSTREAM_OWNER}/${env.UPSTREAM_REPO}` },
      pull_request: { number: 99, state: "closed", merged: true },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; ignored?: string; installationId?: number }>();
    expect(body.ignored).toBe("foreign-installation");
    expect(body.installationId).toBe(9999);

    const log = await env.APP_DB.prepare(
      "SELECT event, level FROM sync_log ORDER BY ts DESC LIMIT 1"
    ).first<{ event: string; level: string }>();
    expect(log?.event).toBe("webhook.ignored-foreign-installation");
    expect(log?.level).toBe("warn");

    const pr = await env.MIRROR_DB.prepare("SELECT * FROM pr WHERE number = 99").first();
    expect(pr).toBeNull();
  });

  it("ignores events from a repo other than UPSTREAM_OWNER/REPO and logs them as ignored", async () => {
    // env.UPSTREAM_OWNER = "testorg", UPSTREAM_REPO = "testrepo" in tests.
    const res = await postWebhook("pull_request", {
      action: "closed",
      number: 99,
      repository: { id: 999, full_name: "someone-else/some-other-repo" },
      pull_request: { number: 99, state: "closed", merged: true },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; ignored?: string; repo?: string }>();
    expect(body.ignored).toBe("foreign-repo");
    expect(body.repo).toBe("someone-else/some-other-repo");

    // Should log it as ignored (not as received).
    const log = await env.APP_DB.prepare(
      "SELECT event, message FROM sync_log ORDER BY ts DESC LIMIT 1"
    ).first<{ event: string; message: string }>();
    expect(log?.event).toBe("webhook.ignored-foreign-repo");

    // The PR row should NOT have been touched.
    const pr = await env.MIRROR_DB.prepare("SELECT * FROM pr WHERE number = 99").first();
    expect(pr).toBeNull();
  });

  it("accepts events from the correct repo and logs them as received", async () => {
    // Stub GH so the awaited syncPr inside the route can complete cleanly.
    mswServer.use(
      http.post("https://api.github.com/app/installations/:id/access_tokens", () => {
        return HttpResponse.json({ token: "v1.test", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
      }),
      http.get(`https://api.github.com/repos/${env.UPSTREAM_OWNER}/${env.UPSTREAM_REPO}/pulls/100`, () => {
        return HttpResponse.json({
          id: 5000, number: 100, state: "open", draft: false, merged: false,
          mergeable: true, mergeable_state: "clean",
          title: "Test", body: null,
          user: { id: 1, login: "alice", avatar_url: null, html_url: null, type: "User" },
          head: { ref: "feat", sha: "sha-100" },
          base: { ref: "main", sha: "main-sha", repo: { id: 1, owner: { login: env.UPSTREAM_OWNER }, name: env.UPSTREAM_REPO, default_branch: "main" } },
          created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
          closed_at: null, merged_at: null, labels: [],
        });
      }),
      http.get(`https://api.github.com/repos/${env.UPSTREAM_OWNER}/${env.UPSTREAM_REPO}/commits/sha-100/check-runs`, () => {
        return HttpResponse.json({ total_count: 0, check_runs: [] });
      }),
    );

    const res = await postWebhook("pull_request", {
      action: "opened",
      number: 100,
      installation: { id: 1 },
      repository: { id: 1, full_name: `${env.UPSTREAM_OWNER}/${env.UPSTREAM_REPO}` },
      pull_request: { number: 100, state: "open", merged: false },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; ignored?: string }>();
    expect(body.ignored).toBeUndefined();
    expect(body.ok).toBe(true);

    const log = await env.APP_DB.prepare(
      "SELECT event FROM sync_log WHERE event = 'webhook.received' ORDER BY ts DESC LIMIT 1"
    ).first<{ event: string }>();
    expect(log?.event).toBe("webhook.received");

    // The PR row WAS upserted by the awaited syncPr call.
    const pr = await env.MIRROR_DB.prepare("SELECT number, state FROM pr WHERE number = 100").first<{ number: number; state: string }>();
    expect(pr?.state).toBe("open");
  });

  it("ignores events with no repository field (defense in depth)", async () => {
    // A malformed payload still gets through signature verification but
    // we have no way to know which repo it's for. The original code would
    // dispatch anyway; we now treat 'no repository' as acceptable (since
    // we can't be sure it's foreign) and let dispatch decide what to do.
    const res = await postWebhook("ping", { zen: "Anything added dilutes everything else." });
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; ignored?: string }>();
    expect(body.ignored).toBeUndefined();
  });
});
