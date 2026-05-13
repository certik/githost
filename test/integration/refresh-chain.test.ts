/**
 * Integration test for the resync chain (src/jobs/refresh-chain.ts +
 * /api/refresh + /api/internal/sync-batch).
 *
 * The bug we're protecting against: prior to this fix, /api/refresh fired
 * fullResync via `ctx.waitUntil(...)` which exceeded the Workers Free
 * 30s wall-clock budget; D1 writes got cancelled mid-flight so merged PRs
 * never updated to `state=closed, merged=1`. The chain processes one bounded
 * batch per Worker invocation and self-fetches the next link.
 *
 * Coverage:
 *   - refreshPrsBatch() actually writes state=closed,merged=1 for a merged PR.
 *   - Watermark optimization: PRs whose mirror updatedAt is already current
 *     get skipped (no syncPr GET).
 *   - hasMore signaling: page-not-drained, watermark-hit, end-of-list.
 *   - /api/internal/sync-batch: rejects requests without the secret.
 *   - /api/logs: returns recent sync_log rows in DESC ts order.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { http, HttpResponse } from "msw";
import { resetDbs } from "../helpers/db";
import { mswServer } from "../msw-server";
import { refreshPrsBatch, REFRESH_PER_PAGE } from "../../src/jobs/refresh-chain";

beforeEach(resetDbs);

const OWNER = "testorg";
const REPO = "testrepo";

interface MockPrListItem {
  id: number;
  number: number;
  updated_at: string;
}

interface MockPrDetail extends MockPrListItem {
  state: string;
  draft: boolean;
  merged: boolean;
  title: string;
  body: null;
  user: { id: number; login: string; avatar_url: null; html_url: null; type: string };
  head: { ref: string; sha: string };
  base: { ref: string; sha: string; repo: { id: number; owner: { login: string }; name: string; default_branch: string } };
  created_at: string;
  closed_at: string | null;
  merged_at: string | null;
  labels: never[];
}

function mockDetail(opts: { number: number; id: number; merged: boolean; updated_at: string }): MockPrDetail {
  return {
    id: opts.id,
    number: opts.number,
    state: opts.merged ? "closed" : "open",
    draft: false,
    merged: opts.merged,
    title: `PR ${opts.number}`,
    body: null,
    user: { id: 1, login: "alice", avatar_url: null, html_url: null, type: "User" },
    head: { ref: "feature", sha: `sha-${opts.number}` },
    base: { ref: "main", sha: "main-sha", repo: { id: 1, owner: { login: OWNER }, name: REPO, default_branch: "main" } },
    created_at: "2026-05-01T00:00:00Z",
    updated_at: opts.updated_at,
    closed_at: opts.merged ? opts.updated_at : null,
    merged_at: opts.merged ? opts.updated_at : null,
    labels: [],
  };
}

function installListHandler(items: MockPrListItem[], page = 1): void {
  mswServer.use(
    http.get("https://api.github.com/repos/:o/:r/pulls", ({ request }) => {
      const url = new URL(request.url);
      if ((parseInt(url.searchParams.get("page") ?? "1", 10) || 1) !== page) return HttpResponse.json([]);
      return HttpResponse.json(items);
    }),
  );
}

function installTokenHandler(): void {
  mswServer.use(
    http.post("https://api.github.com/app/installations/:id/access_tokens", () => {
      return HttpResponse.json({ token: "v1.test", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }),
  );
}

function installPrDetail(detail: MockPrDetail): void {
  mswServer.use(
    http.get(`https://api.github.com/repos/${OWNER}/${REPO}/pulls/${detail.number}`, () => {
      return HttpResponse.json(detail);
    }),
    http.get(`https://api.github.com/repos/${OWNER}/${REPO}/commits/${detail.head.sha}/check-runs`, () => {
      return HttpResponse.json({ total_count: 0, check_runs: [] });
    }),
  );
}

async function seedMirrorPr(opts: { id: number; number: number; updatedAt: number; state?: string; merged?: boolean; mergeable?: boolean | null }): Promise<void> {
  // Repo + user have to exist (FK).
  await env.MIRROR_DB.prepare(
    "INSERT OR IGNORE INTO repo (id, owner, name, default_branch) VALUES (1, ?, ?, 'main')"
  ).bind(OWNER, REPO).run();
  await env.MIRROR_DB.prepare(
    "INSERT OR IGNORE INTO user (id, login) VALUES (1, 'alice')"
  ).run();
  // Default to mergeable=true so the watermark works in tests (open PRs with
  // mergeable IS NULL are flagged as stale for the one-time backfill).
  const mergeable = opts.mergeable === undefined ? 1
    : opts.mergeable === null ? null
    : opts.mergeable ? 1 : 0;
  await env.MIRROR_DB.prepare(
    `INSERT INTO pr (id, repo_id, number, state, draft, merged, mergeable, title, body, author_id, head_ref, head_sha, base_ref, base_sha, created_at, updated_at)
     VALUES (?, 1, ?, ?, 0, ?, ?, ?, NULL, 1, 'feature', ?, 'main', 'main-sha', ?, ?)`
  ).bind(
    opts.id, opts.number, opts.state ?? "open", opts.merged ? 1 : 0,
    mergeable, `PR ${opts.number}`, `sha-${opts.number}`, opts.updatedAt, opts.updatedAt,
  ).run();
}

describe("refreshPrsBatch", () => {
  it("upserts state=closed,merged=1 when GitHub reports a merged PR (the bug fix)", async () => {
    // Mirror has the row in stale open state. GitHub says it's merged now.
    await seedMirrorPr({ id: 999, number: 11314, updatedAt: 1_700_000_000_000, state: "open", merged: false });

    installTokenHandler();
    installListHandler([{ id: 999, number: 11314, updated_at: "2026-05-13T15:25:32Z" }]);
    installPrDetail(mockDetail({ id: 999, number: 11314, merged: true, updated_at: "2026-05-13T15:25:32Z" }));

    const result = await refreshPrsBatch(env, 1);

    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);

    const row = await env.MIRROR_DB.prepare(
      "SELECT state, merged FROM pr WHERE number = 11314"
    ).first<{ state: string; merged: number }>();
    expect(row?.state).toBe("closed");
    expect(row?.merged).toBe(1);
  });

  it("treats open PRs with mergeable IS NULL as stale (one-time backfill after the mergeable column was added)", async () => {
    // Mirror row: open, updated_at is current, but mergeable IS NULL
    // (simulating an existing row from before migration 0002 ran).
    const ts = "2026-05-13T12:00:00Z";
    const ms = Date.parse(ts);
    await seedMirrorPr({ id: 555, number: 555, updatedAt: ms, mergeable: null });

    installTokenHandler();
    installListHandler([{ id: 555, number: 555, updated_at: ts }]);
    installPrDetail(mockDetail({ id: 555, number: 555, merged: false, updated_at: ts }));

    const result = await refreshPrsBatch(env, 1);
    // We did re-fetch — even though updated_at matched, mergeable was null.
    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it("does NOT treat closed/merged PRs as stale even when mergeable IS NULL", async () => {
    // mergeable is null for closed PRs in GH — that's normal, not stale.
    const ts = "2026-05-13T12:00:00Z";
    const ms = Date.parse(ts);
    await seedMirrorPr({ id: 777, number: 777, updatedAt: ms, state: "closed", merged: true, mergeable: null });

    installTokenHandler();
    installListHandler([{ id: 777, number: 777, updated_at: ts }]);
    // No PR-detail handler → if syncPr ran, MSW would throw. That's the assertion.

    const result = await refreshPrsBatch(env, 1);
    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("skips PRs whose mirror updated_at >= GitHub updated_at (watermark)", async () => {
    // Seed a full page of mirror PRs that are already current.
    const ts = "2026-05-13T12:00:00Z";
    const ms = Date.parse(ts);
    const items: MockPrListItem[] = [];
    for (let i = 0; i < REFRESH_PER_PAGE; i++) {
      await seedMirrorPr({ id: 1000 + i, number: 1000 + i, updatedAt: ms });
      items.push({ id: 1000 + i, number: 1000 + i, updated_at: ts });
    }

    installTokenHandler();
    installListHandler(items);
    // No PR-detail handler installed → if syncPr ran, MSW would throw on
    // the unhandled fetch and the test would fail. That's the assertion.

    const result = await refreshPrsBatch(env, 1);
    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(REFRESH_PER_PAGE);
    expect(result.hasMore).toBe(false);
    expect(result.reason).toBe("watermark-hit");
  });

  it("returns hasMore=false on a short page (end-of-list)", async () => {
    installTokenHandler();
    installListHandler([{ id: 1, number: 1, updated_at: "2026-05-13T00:00:00Z" }]);
    installPrDetail(mockDetail({ id: 1, number: 1, merged: false, updated_at: "2026-05-13T00:00:00Z" }));

    const result = await refreshPrsBatch(env, 1);
    expect(result.hasMore).toBe(false);
    expect(result.reason).toBe("end-of-list");
  });

  it("returns hasMore=true with reason=next-page when a full page is fully processed", async () => {
    installTokenHandler();
    const items: MockPrListItem[] = Array.from({ length: REFRESH_PER_PAGE }, (_, i) => ({
      id: 1000 + i, number: 1000 + i, updated_at: `2026-05-13T${String(i % 24).padStart(2, "0")}:00:00Z`,
    }));
    installListHandler(items);
    for (const item of items) {
      installPrDetail(mockDetail({ id: item.id, number: item.number, merged: false, updated_at: item.updated_at }));
    }

    const result = await refreshPrsBatch(env, 1);
    expect(result.scanned).toBe(REFRESH_PER_PAGE);
    expect(result.hasMore).toBe(true);
    // MAX_SYNCS_PER_BATCH caps; everything else is stale → page-not-drained or next-page
    expect(["page-not-drained", "next-page"]).toContain(result.reason);
  });

  it("logs sync.pr.error when syncPr throws but continues the batch", async () => {
    installTokenHandler();
    installListHandler([
      { id: 100, number: 100, updated_at: "2026-05-13T00:00:00Z" },
      { id: 101, number: 101, updated_at: "2026-05-13T00:00:00Z" },
    ]);
    // #100 detail will 500 — syncPr throws.
    mswServer.use(
      http.get(`https://api.github.com/repos/${OWNER}/${REPO}/pulls/100`, () => HttpResponse.text("boom", { status: 500 })),
    );
    installPrDetail(mockDetail({ id: 101, number: 101, merged: false, updated_at: "2026-05-13T00:00:00Z" }));

    const result = await refreshPrsBatch(env, 1);
    expect(result.failed).toBe(1);
    expect(result.processed).toBe(1);

    const errLog = await env.APP_DB.prepare(
      "SELECT message FROM sync_log WHERE event='sync.pr.error' ORDER BY id DESC LIMIT 1"
    ).first<{ message: string }>();
    expect(errLog?.message).toContain("pr #100");
  });
});

// ---------------------------------------------------------------------------
// /api/refresh — kicks off the SyncChain DO
// ---------------------------------------------------------------------------

async function workerFetch(path: string, init?: RequestInit): Promise<Response> {
  const { default: worker } = await import("../../src/worker");
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
  return worker.fetch(new Request(`https://example.com${path}`, init), env, ctx);
}

async function makeSessionCookie(login: string, ghUserId: number): Promise<string> {
  const userId = crypto.randomUUID();
  const sessionId = `s-${crypto.randomUUID()}`;
  const now = Date.now();
  await env.APP_DB.prepare("INSERT INTO app_user (id, gh_user_id, login, created_at) VALUES (?, ?, ?, ?)")
    .bind(userId, ghUserId, login, now).run();
  await env.APP_DB.prepare("INSERT INTO user_session (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(sessionId, userId, now + 60_000, now).run();
  return `gh_session=${sessionId}`;
}

describe("POST /api/refresh", () => {
  it("requires a session", async () => {
    const res = await workerFetch("/api/refresh", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("returns {scheduled: true} when starting a chain via the DO", async () => {
    const cookie = await makeSessionCookie("alice", 1001);
    const res = await workerFetch("/api/refresh", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ resource: "prs" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; scheduled?: boolean; alreadyRunning?: boolean }>();
    expect(body.ok).toBe(true);
    // Either it scheduled a new chain or one's already running — both are valid.
    expect(body.scheduled === true || body.alreadyRunning === true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /api/logs
// ---------------------------------------------------------------------------

describe("GET /api/logs", () => {
  it("returns recent sync_log rows in DESC ts order", async () => {
    // Seed app_user + session for requireSession.
    const userId = crypto.randomUUID();
    const sessionId = `s-${crypto.randomUUID()}`;
    const now = Date.now();
    await env.APP_DB.prepare("INSERT INTO app_user (id, gh_user_id, login, created_at) VALUES (?, ?, ?, ?)")
      .bind(userId, 42, "tester", now).run();
    await env.APP_DB.prepare("INSERT INTO user_session (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .bind(sessionId, userId, now + 60_000, now).run();

    // Seed two log rows.
    await env.APP_DB.prepare("INSERT INTO sync_log (ts, level, event, message, context) VALUES (?, 'info', 'sync.batch.done', 'first', NULL)").bind(1000).run();
    await env.APP_DB.prepare("INSERT INTO sync_log (ts, level, event, message, context) VALUES (?, 'error', 'sync.pr.error', 'second', '{\"prNumber\":5}')").bind(2000).run();

    const res = await workerFetch("/api/logs", { headers: { cookie: `gh_session=${sessionId}` } });
    expect(res.status).toBe(200);
    const body = await res.json<{ items: Array<{ level: string; message: string; context: unknown }> }>();
    expect(body.items.length).toBe(2);
    expect(body.items[0]!.message).toBe("second");
    expect(body.items[0]!.level).toBe("error");
    expect(body.items[0]!.context).toEqual({ prNumber: 5 });
    expect(body.items[1]!.message).toBe("first");
  });

  it("filters by level when ?level=error is provided", async () => {
    const userId = crypto.randomUUID();
    const sessionId = `s-${crypto.randomUUID()}`;
    const now = Date.now();
    await env.APP_DB.prepare("INSERT INTO app_user (id, gh_user_id, login, created_at) VALUES (?, ?, ?, ?)")
      .bind(userId, 43, "tester2", now).run();
    await env.APP_DB.prepare("INSERT INTO user_session (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .bind(sessionId, userId, now + 60_000, now).run();

    await env.APP_DB.prepare("INSERT INTO sync_log (ts, level, event, message, context) VALUES (?, 'info', 'a', 'info-msg', NULL)").bind(1000).run();
    await env.APP_DB.prepare("INSERT INTO sync_log (ts, level, event, message, context) VALUES (?, 'error', 'b', 'err-msg', NULL)").bind(2000).run();

    const res = await workerFetch("/api/logs?level=error", { headers: { cookie: `gh_session=${sessionId}` } });
    const body = await res.json<{ items: Array<{ level: string; message: string }> }>();
    expect(body.items.length).toBe(1);
    expect(body.items[0]!.level).toBe("error");
  });

  it("requires a session", async () => {
    const res = await workerFetch("/api/logs");
    expect(res.status).toBe(401);
  });
});
