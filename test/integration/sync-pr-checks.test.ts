/**
 * Integration test: syncPr pulls check runs from GitHub and writes
 * pr_test_run rows. Uses MSW to mock the two outbound calls.
 *
 * Covers the user-facing behavior: "click Manual refresh → see colored dots".
 */
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { http, HttpResponse } from "msw";
import { resetDbs } from "../helpers/db";
import { mswServer } from "../msw-server";
import { syncPr } from "../../src/jobs/sync-pr";

beforeEach(resetDbs);

const OWNER = "testorg";
const REPO = "testrepo";

/**
 * Seed check_kind_map with the same defaults migration 0004 applies in prod.
 */
async function seedDefaultMappings(): Promise<void> {
  const now = Date.now();
  const stmt = env.APP_DB.prepare(
    "INSERT INTO check_kind_map (id, pattern, kind, match_type, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  );
  for (const m of [
    ["m1", "Quick checks / *",      "quick",      "glob", 100],
    ["m2", "Exhaustive checks / *", "exhaustive", "glob", 100],
    ["m3", "Test LLVM * (*)",       "exhaustive", "glob",  50],
  ] as const) {
    await stmt.bind(m[0], m[1], m[2], m[3], m[4], now).run();
  }
}

/** Minimal PR payload syncPr expects from GET /repos/.../pulls/:n. */
function mockPullPayload(opts: { number: number; id: number; headSha: string }) {
  return {
    id: opts.id,
    number: opts.number,
    state: "open",
    draft: false,
    merged: false,
    title: `Test PR ${opts.number}`,
    body: null,
    user: { id: 1001, login: "alice", avatar_url: null, html_url: null, type: "User" },
    head: { ref: "feature", sha: opts.headSha },
    base: { ref: "main",   sha: "main-sha", repo: { id: 1, owner: { login: OWNER }, name: REPO, default_branch: "main" } },
    created_at: "2026-05-13T00:00:00Z",
    updated_at: "2026-05-13T00:00:00Z",
    closed_at: null,
    merged_at: null,
    labels: [],
  };
}

interface ApiPr {
  number: number;
  quickTest: { status: string; headSha: string | null } | null;
  exhaustiveTest: { status: string; headSha: string | null } | null;
}

async function getPr(number: number): Promise<ApiPr | undefined> {
  const { default: worker } = await import("../../src/worker");
  // Create a fresh app_user + session for each call. Use crypto.randomUUID-
  // derived ghUserId so repeat calls in the same test don't collide on the
  // unique index.
  const userId = crypto.randomUUID();
  const sessionId = `s-${crypto.randomUUID()}`;
  const ghUserId = Math.floor(Math.random() * 2_000_000_000);
  const now = Date.now();
  await env.APP_DB.prepare(
    "INSERT INTO app_user (id, gh_user_id, login, created_at) VALUES (?, ?, ?, ?)"
  ).bind(userId, ghUserId, `t${ghUserId}`, now).run();
  await env.APP_DB.prepare(
    "INSERT INTO user_session (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)"
  ).bind(sessionId, userId, now + 60_000, now).run();

  const req = new Request("https://example.com/api/prs", {
    headers: { cookie: `gh_session=${sessionId}` },
  });
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
  const res = await worker.fetch(req, env, ctx);
  const body = await res.json<{ items: ApiPr[] }>();
  return body.items.find((p) => p.number === number);
}

describe("syncPr → pr_test_run via check runs", () => {
  it("buckets and aggregates check runs into quick (passed) and exhaustive (queued) using workflow names", async () => {
    await seedDefaultMappings();
    const headSha = "sha-100";
    const QUICK_WF_ID = 1001;
    const EXH_WF_ID = 1002;

    mswServer.use(
      http.post("https://api.github.com/app/installations/:id/access_tokens", () => {
        return HttpResponse.json({ token: "v1.test", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
      }),
      http.get(`https://api.github.com/repos/${OWNER}/${REPO}/pulls/100`, () => {
        return HttpResponse.json(mockPullPayload({ number: 100, id: 1000, headSha }));
      }),
      http.get(`https://api.github.com/repos/${OWNER}/${REPO}/actions/runs`, () => {
        return HttpResponse.json({
          workflow_runs: [
            { id: QUICK_WF_ID, name: "Quick checks" },
            { id: EXH_WF_ID,   name: "Exhaustive checks" },
          ],
        });
      }),
      http.get(`https://api.github.com/repos/${OWNER}/${REPO}/commits/${headSha}/check-runs`, () => {
        return HttpResponse.json({
          total_count: 4,
          check_runs: [
            { name: "LFortran CI (OS=ubuntu-latest, LLVM=11)", status: "completed", conclusion: "success",
              html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/${QUICK_WF_ID}/job/9001` },
            { name: "Build LFortran to WASM and Upload",       status: "completed", conclusion: "success",
              html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/${QUICK_WF_ID}/job/9002` },
            { name: "Test LLVM 19 (ubuntu-latest)",            status: "queued",    conclusion: null,
              html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/${EXH_WF_ID}/job/9003` },
            { name: "Test LLVM 22 (macos-latest)",             status: "completed", conclusion: "success",
              html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/${EXH_WF_ID}/job/9004` },
          ],
        });
      }),
    );

    await syncPr(env, 1, 100);

    const pr = await getPr(100);
    expect(pr?.quickTest?.status).toBe("passed");
    expect(pr?.quickTest?.headSha).toBe(headSha);
    expect(pr?.exhaustiveTest?.status).toBe("queued");
  });

  it("flips a passed PR to failed on a new sync when checks fail", async () => {
    await seedDefaultMappings();
    const headSha = "sha-200";
    const QUICK_WF_ID = 2001;

    const pull = http.get(`https://api.github.com/repos/${OWNER}/${REPO}/pulls/200`, () => {
      return HttpResponse.json(mockPullPayload({ number: 200, id: 2000, headSha }));
    });
    const tokens = http.post("https://api.github.com/app/installations/:id/access_tokens", () => {
      return HttpResponse.json({ token: "v1.test", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    });
    const runs = http.get(`https://api.github.com/repos/${OWNER}/${REPO}/actions/runs`, () => {
      return HttpResponse.json({ workflow_runs: [{ id: QUICK_WF_ID, name: "Quick checks" }] });
    });

    mswServer.use(
      tokens, pull, runs,
      http.get(`https://api.github.com/repos/${OWNER}/${REPO}/commits/${headSha}/check-runs`, () => {
        return HttpResponse.json({ total_count: 1, check_runs: [
          { name: "LFortran CI (OS=ubuntu-latest, LLVM=11)", status: "completed", conclusion: "success",
            html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/${QUICK_WF_ID}/job/8001` },
        ]});
      }),
    );
    await syncPr(env, 1, 200);
    expect((await getPr(200))?.quickTest?.status).toBe("passed");

    mswServer.resetHandlers();
    mswServer.use(
      tokens, pull, runs,
      http.get(`https://api.github.com/repos/${OWNER}/${REPO}/commits/${headSha}/check-runs`, () => {
        return HttpResponse.json({ total_count: 1, check_runs: [
          { name: "LFortran CI (OS=ubuntu-latest, LLVM=11)", status: "completed", conclusion: "failure",
            html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/${QUICK_WF_ID}/job/8001` },
        ]});
      }),
    );
    await syncPr(env, 1, 200);
    expect((await getPr(200))?.quickTest?.status).toBe("failed");
  });

  it("deletes a stale row when no checks bucket into the kind anymore", async () => {
    await seedDefaultMappings();
    const headSha = "sha-300";
    const QUICK_WF_ID = 3001;

    // Seed a stale 'exhaustive' row directly.
    await env.APP_DB.prepare(
      "INSERT INTO pr_test_run (pr_id, kind, status, head_sha, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(3000, "exhaustive", "failed", "old-sha", Date.now()).run();

    mswServer.use(
      http.post("https://api.github.com/app/installations/:id/access_tokens", () => {
        return HttpResponse.json({ token: "v1.test", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
      }),
      http.get(`https://api.github.com/repos/${OWNER}/${REPO}/pulls/300`, () => {
        return HttpResponse.json(mockPullPayload({ number: 300, id: 3000, headSha }));
      }),
      http.get(`https://api.github.com/repos/${OWNER}/${REPO}/actions/runs`, () => {
        return HttpResponse.json({ workflow_runs: [{ id: QUICK_WF_ID, name: "Quick checks" }] });
      }),
      http.get(`https://api.github.com/repos/${OWNER}/${REPO}/commits/${headSha}/check-runs`, () => {
        // Only quick-bucket checks; nothing matches the exhaustive glob.
        return HttpResponse.json({ total_count: 1, check_runs: [
          { name: "LFortran CI (OS=ubuntu-latest, LLVM=11)", status: "completed", conclusion: "success",
            html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/${QUICK_WF_ID}/job/7001` },
        ]});
      }),
    );
    await syncPr(env, 1, 300);

    const pr = await getPr(300);
    expect(pr?.quickTest?.status).toBe("passed");
    expect(pr?.exhaustiveTest).toBeNull();         // stale row got deleted
  });

  it("ignores check runs whose workflow name doesn't match any mapping", async () => {
    await seedDefaultMappings();
    const headSha = "sha-400";
    const DOCS_WF_ID = 4001;

    mswServer.use(
      http.post("https://api.github.com/app/installations/:id/access_tokens", () => {
        return HttpResponse.json({ token: "v1.test", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
      }),
      http.get(`https://api.github.com/repos/${OWNER}/${REPO}/pulls/400`, () => {
        return HttpResponse.json(mockPullPayload({ number: 400, id: 4000, headSha }));
      }),
      http.get(`https://api.github.com/repos/${OWNER}/${REPO}/actions/runs`, () => {
        return HttpResponse.json({ workflow_runs: [{ id: DOCS_WF_ID, name: "Documentation" }] });
      }),
      http.get(`https://api.github.com/repos/${OWNER}/${REPO}/commits/${headSha}/check-runs`, () => {
        return HttpResponse.json({ total_count: 3, check_runs: [
          { name: "Build docs",   status: "completed", conclusion: "success",
            html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/${DOCS_WF_ID}/job/6001` },
          { name: "Publish",      status: "completed", conclusion: "success",
            html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/${DOCS_WF_ID}/job/6002` },
        ]});
      }),
    );
    await syncPr(env, 1, 400);

    const pr = await getPr(400);
    expect(pr?.quickTest).toBeNull();
    expect(pr?.exhaustiveTest).toBeNull();
  });

  it("matches the lfortran image fixture: 6 Quick checks workflow jobs all pass → quick=passed", async () => {
    await seedDefaultMappings();
    const headSha = "sha-500";
    const QUICK_WF_ID = 5001;

    const names = [
      "Build LFortran to WASM and Upload",
      "LFortran CI (OS=macos-latest, LLVM=11)",
      "LFortran CI (OS=macos-latest, LLVM=21)",
      "LFortran CI (OS=ubuntu-latest, LLVM=11)",
      "LFortran CI (OS=ubuntu-latest, LLVM=21)",
      "LFortran CI (OS=windows-2025, LLVM=11)",
    ];

    mswServer.use(
      http.post("https://api.github.com/app/installations/:id/access_tokens", () => {
        return HttpResponse.json({ token: "v1.test", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
      }),
      http.get(`https://api.github.com/repos/${OWNER}/${REPO}/pulls/500`, () => {
        return HttpResponse.json(mockPullPayload({ number: 500, id: 5000, headSha }));
      }),
      http.get(`https://api.github.com/repos/${OWNER}/${REPO}/actions/runs`, () => {
        return HttpResponse.json({ workflow_runs: [{ id: QUICK_WF_ID, name: "Quick checks" }] });
      }),
      http.get(`https://api.github.com/repos/${OWNER}/${REPO}/commits/${headSha}/check-runs`, () => {
        return HttpResponse.json({
          total_count: names.length,
          check_runs: names.map((name, i) => ({
            name,
            status: "completed",
            conclusion: "success",
            html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/${QUICK_WF_ID}/job/${5100 + i}`,
          })),
        });
      }),
    );
    await syncPr(env, 1, 500);

    const pr = await getPr(500);
    expect(pr?.quickTest?.status).toBe("passed");
    expect(pr?.exhaustiveTest).toBeNull();    // no exhaustive checks for this PR
  });
});
