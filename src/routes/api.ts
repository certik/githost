import { Hono } from "hono";
import { and, desc, eq, inArray, isNull, like, or, sql } from "drizzle-orm";
import type { Env } from "../lib/env";
import { mirrorDb } from "../db/mirror";
import * as M from "../db/mirror/schema";
import { appDb } from "../db/app";
import * as A from "../db/app/schema";
import { gh } from "../lib/github-app";
import { runJob } from "../jobs/consumer";
import { getSyncChainStub } from "../durable-objects/sync-chain";
import { syncLog } from "../lib/sync-log";
import { currentUser, loadSession, requireSession } from "../lib/auth";
import { appUpdate } from "../lib/audit";

/**
 * JSON API consumed by the React SPA.
 *
 * Auth policy:
 *   - GET /api/me is anonymous so the SPA can render a sign-in state.
 *   - GET /api/prs is anonymous-readable, but anonymous callers are pinned to
 *     the top-50/offset-0 slice (independent of any `limit`/`offset` query
 *     param) and the response carries Cache-Control so Cloudflare's edge
 *     absorbs repeat hits. Authenticated callers retain full paging.
 *   - Everything else requires a session (`requireSession`). Enforced via a
 *     wildcard middleware below; individual handlers don't repeat it.
 */
export const apiRoutes = new Hono<{ Bindings: Env }>();

// Anonymous limits for /api/prs. Matches the SPA's default page size, which
// is also the only slice the public front page ever shows.
const ANON_PRS_LIMIT = 50;

// GET /api/me — who am I? (or null). Stays anonymous so the unauthenticated
// SPA can still render its header.
apiRoutes.get("/me", async (c) => {
  const user = await loadSession(c);
  return c.json({ user });
});

// GET /api/prs?state=open&limit=50&offset=0
//
// Anonymous callers: limit and offset are ignored — every anonymous response
// is the top ANON_PRS_LIMIT PRs at offset 0 (optionally filtered by `state`).
// This keeps the response deterministic per state value, which lets the edge
// cache it under `Cache-Control: public`. Authenticated callers keep the
// original paging contract.
apiRoutes.get("/prs", async (c) => {
  const session = await loadSession(c);
  const isAnon = !session;
  const state = c.req.query("state");
  const limit = isAnon
    ? ANON_PRS_LIMIT
    : Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);
  const offset = isAnon ? 0 : (parseInt(c.req.query("offset") ?? "0", 10) || 0);

  const db = mirrorDb(c.env.MIRROR_DB);
  const rows = await db.select({
    id: M.pr.id,
    number: M.pr.number,
    title: M.pr.title,
    state: M.pr.state,
    draft: M.pr.draft,
    merged: M.pr.merged,
    mergeable: M.pr.mergeable,
    mergeableState: M.pr.mergeableState,
    headRef: M.pr.headRef,
    baseRef: M.pr.baseRef,
    createdAt: M.pr.createdAt,
    updatedAt: M.pr.updatedAt,
    authorLogin: M.user.login,
  })
  .from(M.pr)
  .leftJoin(M.user, eq(M.user.id, M.pr.authorId))
  .where(state ? eq(M.pr.state, state) : sql`1=1`)
  .orderBy(desc(M.pr.updatedAt))
  .limit(limit)
  .offset(offset)
  .all();

  // Pull test-run rows for these PR ids from the app DB and zip them in.
  // Cross-DB so we do an in-memory join. Two rows max per PR (quick, exhaustive).
  // Also compute the upstream GitHub URL per PR so the SPA can link out.
  const repoUrl = `https://github.com/${c.env.UPSTREAM_OWNER}/${c.env.UPSTREAM_REPO}`;
  let items: Array<Omit<typeof rows[number], "createdAt" | "updatedAt"> & {
    createdAt: number;
    updatedAt: number;
    htmlUrl: string;
    quickTest: TestRunOut | null;
    exhaustiveTest: TestRunOut | null;
  }> = [];
  if (rows.length === 0) {
    items = [];
  } else {
    const prIds = rows.map((r) => r.id);
    const adb = appDb(c.env.APP_DB);
    const runs = await adb.select().from(A.prTestRun).where(inArray(A.prTestRun.prId, prIds)).all();

    const byPr = new Map<number, { quick?: typeof runs[number]; exhaustive?: typeof runs[number] }>();
    for (const r of runs) {
      const slot = byPr.get(r.prId) ?? {};
      if (r.kind === "quick") slot.quick = r;
      else if (r.kind === "exhaustive") slot.exhaustive = r;
      byPr.set(r.prId, slot);
    }
    items = rows.map((p) => ({
      ...p,
      // Drizzle returns timestamp_ms columns as Date objects which JSON
      // serializes to ISO strings; the SPA needs epoch ms for arithmetic
      // (relative-time formatting), so flatten here.
      createdAt: p.createdAt.getTime(),
      updatedAt: p.updatedAt.getTime(),
      htmlUrl: `${repoUrl}/pull/${p.number}`,
      quickTest: toTestRunOut(byPr.get(p.id)?.quick),
      exhaustiveTest: toTestRunOut(byPr.get(p.id)?.exhaustive),
    }));
  }

  if (isAnon) {
    // Edge-cache the anonymous response so Cloudflare absorbs repeat hits
    // without invoking the Worker. max-age covers browser caches; s-maxage
    // gives the edge a slightly longer grip. Authenticated callers stay
    // uncached because their requests can vary by user (future-proofing).
    c.header("Cache-Control", "public, max-age=30, s-maxage=60");
  }
  return c.json({ items, limit, offset });
});

// Everything registered below this line requires a session.
apiRoutes.use("*", requireSession);

interface TestRunOut {
  status: "queued" | "running" | "passed" | "failed" | "skipped";
  headSha: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  logUrl: string | null;
  updatedAt: number;
}

function toTestRunOut(r: { status: string; headSha: string | null; startedAt: Date | null; finishedAt: Date | null; logUrl: string | null; updatedAt: Date } | undefined): TestRunOut | null {
  if (!r) return null;
  return {
    status: r.status as TestRunOut["status"],
    headSha: r.headSha,
    startedAt: r.startedAt ? r.startedAt.getTime() : null,
    finishedAt: r.finishedAt ? r.finishedAt.getTime() : null,
    logUrl: r.logUrl,
    updatedAt: r.updatedAt.getTime(),
  };
}

// PUT /api/prs/:number/tests/:kind
// Body: { status: "queued"|"running"|"passed"|"failed", headSha?, logUrl?, startedAt?, finishedAt? }
// Sets the latest test-run status for this PR. Idempotent; overwrites any
// previous row. Authenticated — intended to be called by your CI runner with
// a Worker-scoped session cookie or (future) a dedicated bot token.
apiRoutes.put("/prs/:number/tests/:kind", async (c) => {
  const number = parseInt(c.req.param("number"), 10);
  const kind = c.req.param("kind");
  if (kind !== "quick" && kind !== "exhaustive") {
    return c.text("kind must be 'quick' or 'exhaustive'", 400);
  }
  const body = await c.req.json<{
    status: "queued" | "running" | "passed" | "failed" | "skipped";
    headSha?: string;
    logUrl?: string;
    startedAt?: number;
    finishedAt?: number;
  }>().catch(() => null);
  if (!body || !["queued", "running", "passed", "failed", "skipped"].includes(body.status)) {
    return c.text("body.status must be one of queued|running|passed|failed|skipped", 400);
  }

  const mdb = mirrorDb(c.env.MIRROR_DB);
  const pr = await mdb.select({ id: M.pr.id }).from(M.pr).where(eq(M.pr.number, number)).get();
  if (!pr) return c.notFound();

  const now = new Date();
  const adb = appDb(c.env.APP_DB);
  await adb.insert(A.prTestRun).values({
    prId: pr.id,
    kind,
    status: body.status,
    headSha: body.headSha ?? null,
    startedAt: body.startedAt ? new Date(body.startedAt) : null,
    finishedAt: body.finishedAt ? new Date(body.finishedAt) : null,
    logUrl: body.logUrl ?? null,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [A.prTestRun.prId, A.prTestRun.kind],
    set: {
      status: body.status,
      headSha: body.headSha ?? null,
      startedAt: body.startedAt ? new Date(body.startedAt) : null,
      finishedAt: body.finishedAt ? new Date(body.finishedAt) : null,
      logUrl: body.logUrl ?? null,
      updatedAt: now,
    },
  }).run();

  return c.json({ ok: true });
});

// GET /api/prs/:number
apiRoutes.get("/prs/:number", async (c) => {
  const number = parseInt(c.req.param("number"), 10);
  const db = mirrorDb(c.env.MIRROR_DB);
  const row = await db.select().from(M.pr).where(eq(M.pr.number, number)).get();
  if (!row) return c.notFound();

  const adb = appDb(c.env.APP_DB);
  const reviews = await adb.select().from(A.aiReview)
    .where(and(eq(A.aiReview.prId, row.id), isNull(A.aiReview.deletedAt)))
    .orderBy(desc(A.aiReview.createdAt))
    .all();

  const localLabels = await adb.select({ name: A.labelLocal.name, color: A.labelLocal.color })
    .from(A.prLocalLabel)
    .innerJoin(A.labelLocal, eq(A.labelLocal.id, A.prLocalLabel.labelId))
    .where(and(eq(A.prLocalLabel.prId, row.id), isNull(A.labelLocal.deletedAt)))
    .all();

  return c.json({ pr: row, reviews, localLabels });
});

// GET /api/prs/:number/diff — cached in KV keyed by base..head SHA.
apiRoutes.get("/prs/:number/diff", async (c) => {
  const number = parseInt(c.req.param("number"), 10);
  const db = mirrorDb(c.env.MIRROR_DB);
  const row = await db.select().from(M.pr).where(eq(M.pr.number, number)).get();
  if (!row) return c.notFound();
  if (!row.baseSha || !row.headSha) return c.text("diff unavailable: missing SHAs", 409);

  const key = `${c.env.UPSTREAM_OWNER}/${c.env.UPSTREAM_REPO}/${row.baseSha}..${row.headSha}`;
  const cached = await c.env.DIFF_CACHE.get(key);
  if (cached !== null) {
    return new Response(cached, { headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  // TODO: pick installationId once known (see github-app installation flow).
  const installationId = parseInt(c.env.GITHUB_INSTALLATION_ID, 10);
  const res = await gh(c.env, {
    installationId,
    path: `/repos/${c.env.UPSTREAM_OWNER}/${c.env.UPSTREAM_REPO}/pulls/${number}`,
    headers: { Accept: "application/vnd.github.v3.diff" },
  });
  if (!res.ok) return c.text(await res.text(), res.status as 400);
  const text = await res.text();
  // KV entries default to no expiration; cap at 30 days so abandoned PR caches don't pile up.
  c.executionCtx.waitUntil(c.env.DIFF_CACHE.put(key, text, { expirationTtl: 30 * 24 * 60 * 60 }));
  return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } });
});

// POST /api/refresh  { resource?: "prs" | "issues" | "comments" }
//
// Kicks off the resync chain via the SyncChain Durable Object. The DO runs
// one batch at a time via setAlarm(), so the chain can process arbitrarily
// many PRs without hitting CF's Worker→Worker call-depth cap (~10).
//
// Returns immediately. The actual sync runs in the background as the DO
// fires its alarms. Progress is visible at /api/logs (and in the /logs UI).
//
// Only `resource: "prs"` uses the DO chain; "issues" / "comments" fall back
// to the legacy fire-and-forget runJob path (to be migrated next).
apiRoutes.post("/refresh", requireSession, async (c) => {
  type Body = { resource?: "prs" | "issues" | "comments"; maxBatches?: number; forceCount?: number };
  const body: Body = await c.req.json<Body>().catch(() => ({} as Body));
  const resource = body.resource ?? "prs";

  if (resource !== "prs") {
    runJob({ type: "sync.full", resource }, c.env, c.executionCtx);
    return c.json({ ok: true, queued: resource });
  }

  await syncLog(c.env, "info", "sync.refresh.start",
    `manual refresh by ${currentUser(c).login} (maxBatches=${body.maxBatches ?? "default"}, forceCount=${body.forceCount ?? "default"})`, {
      actor: currentUser(c).login,
      maxBatches: body.maxBatches,
      forceCount: body.forceCount,
    });

  const stub = getSyncChainStub(c.env);
  const r = await stub.fetch("https://do/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      maxBatches: body.maxBatches,
      forceCount: body.forceCount,
    }),
  });
  const data = await r.json<{ ok: boolean; alreadyRunning?: boolean; scheduled?: boolean; page?: number; batches?: number; maxBatches?: number; forceCount?: number }>();
  return c.json(data);
});

// GET /api/refresh/status — current state of the resync chain DO. Lets the
// UI poll progress while the chain runs.
apiRoutes.get("/refresh/status", async (c) => {
  const stub = getSyncChainStub(c.env);
  const r = await stub.fetch("https://do/status");
  return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } });
});

// POST /api/refresh/reset — admin escape hatch to clear stuck DO state.
apiRoutes.post("/refresh/reset", async (c) => {
  const stub = getSyncChainStub(c.env);
  const r = await stub.fetch("https://do/reset", { method: "POST" });
  return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } });
});

// GET /api/logs?limit=200&level=error&event=sync.pr.error&q=substring
// Returns recent sync_log rows, newest first. Allowlist-gated by requireSession.
// `q` does a case-insensitive substring search across event, message, and
// context columns — useful for finding all rows mentioning a PR number or
// event type (e.g. q=pull_request matches both event='pull_request' and any
// webhook.received row whose message contains 'pull_request').
apiRoutes.get("/logs", async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") ?? "200", 10) || 200, 1000);
  const level = c.req.query("level");
  const event = c.req.query("event");
  const q = c.req.query("q");

  const db = appDb(c.env.APP_DB);
  const conds = [];
  if (level) conds.push(eq(A.syncLog.level, level));
  if (event) conds.push(eq(A.syncLog.event, event));
  if (q) {
    const pattern = `%${q}%`;
    // SQLite LIKE is case-insensitive on ASCII by default — good enough for
    // event/message/context grep. No FTS5 needed at this scale.
    conds.push(or(
      like(A.syncLog.event, pattern),
      like(A.syncLog.message, pattern),
      like(A.syncLog.context, pattern),
    )!);
  }

  const rows = await db.select().from(A.syncLog)
    .where(conds.length ? and(...conds) : sql`1=1`)
    .orderBy(desc(A.syncLog.ts))
    .limit(limit)
    .all();

  return c.json({
    items: rows.map((r) => ({
      id: r.id,
      ts: r.ts.getTime(),
      level: r.level,
      event: r.event,
      message: r.message,
      context: r.context ? safeParseJson(r.context) : null,
    })),
  });
});

function safeParseJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

// POST /api/branches  { name: "feature/x", from: "main" | "<sha>" }
apiRoutes.post("/branches", requireSession, async (c) => {
  const body = await c.req.json<{ name: string; from: string }>();
  if (!body?.name || !body?.from) return c.text("name and from required", 400);
  const installationId = parseInt(c.env.GITHUB_INSTALLATION_ID, 10);

  // 1. Resolve `from` to a SHA.
  let sha = body.from;
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    const r = await gh(c.env, {
      installationId,
      path: `/repos/${c.env.UPSTREAM_OWNER}/${c.env.UPSTREAM_REPO}/git/ref/heads/${encodeURIComponent(body.from)}`,
    });
    if (!r.ok) return c.text(`resolve from: ${await r.text()}`, r.status as 400);
    sha = (await r.json<{ object: { sha: string } }>()).object.sha;
  }

  // 2. Create the new ref.
  const r = await gh(c.env, {
    installationId,
    method: "POST",
    path: `/repos/${c.env.UPSTREAM_OWNER}/${c.env.UPSTREAM_REPO}/git/refs`,
    body: { ref: `refs/heads/${body.name}`, sha },
  });
  if (!r.ok) return c.text(await r.text(), r.status as 400);
  return c.json(await r.json());
});

// POST /api/prs/:number/post-review  { aiReviewId, event: "COMMENT" | "REQUEST_CHANGES" | "APPROVE" }
apiRoutes.post("/prs/:number/post-review", requireSession, async (c) => {
  const number = parseInt(c.req.param("number"), 10);
  const body = await c.req.json<{ aiReviewId: string; event: "COMMENT" | "REQUEST_CHANGES" | "APPROVE" }>();
  const installationId = parseInt(c.env.GITHUB_INSTALLATION_ID, 10);
  const user = currentUser(c);

  const adb = appDb(c.env.APP_DB);
  const review = await adb.select().from(A.aiReview).where(eq(A.aiReview.id, body.aiReviewId)).get();
  if (!review || review.deletedAt) return c.notFound();
  if (review.status === "posted") return c.json({ ok: true, alreadyPosted: true, upstreamReviewId: review.upstreamReviewId });

  const comments = review.commentsJson ? JSON.parse(review.commentsJson) as Array<{ path: string; line: number; body: string }> : [];
  const r = await gh(c.env, {
    installationId,
    method: "POST",
    path: `/repos/${c.env.UPSTREAM_OWNER}/${c.env.UPSTREAM_REPO}/pulls/${number}/reviews`,
    body: { commit_id: review.headSha, body: review.summary ?? "", event: body.event, comments },
  });
  if (!r.ok) return c.text(await r.text(), r.status as 400);

  const data = await r.json<{ id: number }>();
  await appUpdate(
    adb,
    A.aiReview,
    "ai_review",
    A.aiReview.id,
    body.aiReviewId,
    { status: "posted", postedUpstreamAt: new Date(), upstreamReviewId: data.id, updatedAt: new Date() },
    user.id,
  );

  return c.json({ ok: true, upstreamReviewId: data.id });
});
