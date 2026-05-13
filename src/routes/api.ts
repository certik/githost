import { Hono } from "hono";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Env } from "../lib/env";
import { mirrorDb } from "../db/mirror";
import * as M from "../db/mirror/schema";
import { appDb } from "../db/app";
import * as A from "../db/app/schema";
import { gh } from "../lib/github-app";
import { runJob } from "../jobs/consumer";
import { refreshPrsBatch, nextChainUrl, MAX_CHAIN_DEPTH } from "../jobs/refresh-chain";
import { syncLog } from "../lib/sync-log";
import { currentUser, loadSession, requireSession } from "../lib/auth";
import { appUpdate } from "../lib/audit";

/**
 * Public-ish JSON API consumed by the React SPA.
 *
 * Auth policy:
 *   - GET endpoints (PR list/detail/diff) are anonymous-readable; that's by
 *     design — this is a read-mostly view of a public repo.
 *   - Mutations and anything that calls GitHub on our installation's behalf
/**
 * Public-ish JSON API consumed by the React SPA.
 *
 * Auth policy (private mode):
 *   - GET /api/me is anonymous-readable so the SPA can render a sign-in state.
 *   - Everything else requires a session (`requireSession`). This is enforced
 *     via a wildcard middleware below; individual handlers don't repeat it.
 */
export const apiRoutes = new Hono<{ Bindings: Env }>();

// GET /api/me — who am I? (or null). Stays anonymous so the unauthenticated
// SPA can still render its header.
apiRoutes.get("/me", async (c) => {
  const user = await loadSession(c);
  return c.json({ user });
});

// POST /api/internal/sync-batch?page=N&chain=K
//
// Internal endpoint that processes one page of the resync chain. Auth'd
// purely by a shared secret in the X-Internal-Secret header — never callable
// from a browser. The previous link (or POST /api/refresh) self-fetches this
// URL via ctx.waitUntil(fetch(...)). Each call runs in a brand-new Worker
// invocation with a fresh wall-clock + subrequest budget.
//
// Registered BEFORE the requireSession middleware below because it doesn't
// have a session cookie — the chain is server-to-server.
apiRoutes.post("/internal/sync-batch", async (c) => {
  const secret = c.req.header("x-internal-secret");
  if (!secret || secret !== c.env.WORKER_INTERNAL_SECRET) {
    await syncLog(c.env, "warn", "sync.internal.unauthorized", "rejected /api/internal/sync-batch (bad secret)", {
      ip: c.req.header("cf-connecting-ip") ?? null,
    });
    return c.text("forbidden", 403);
  }
  const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10) || 1);
  const chain = Math.max(0, parseInt(c.req.query("chain") ?? "0", 10) || 0);

  if (chain > MAX_CHAIN_DEPTH) {
    await syncLog(c.env, "warn", "sync.chain.stopped",
      `chain depth ${chain} exceeded MAX_CHAIN_DEPTH=${MAX_CHAIN_DEPTH}; stopping`, { page, chain });
    return c.json({ ok: true, stopped: "max-chain-depth" });
  }

  let result;
  try {
    result = await refreshPrsBatch(c.env, page);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await syncLog(c.env, "error", "sync.batch.error", `page ${page}: ${message}`, {
      page, chain, stack: err instanceof Error ? err.stack : undefined,
    });
    return c.json({ ok: false, error: message }, 500);
  }

  await syncLog(c.env, result.failed > 0 ? "warn" : "info", "sync.batch.done",
    `page=${page} chain=${chain} scanned=${result.scanned} processed=${result.processed} skipped=${result.skipped} failed=${result.failed} reason=${result.reason}`,
    { ...result, chain },
  );

  if (result.hasMore) {
    const origin = new URL(c.req.url).origin;
    const next = nextChainUrl(origin, result, chain);
    c.executionCtx.waitUntil(spawnChainLink(c.env, next, chain));
  }

  return c.json({ ok: true, ...result, chain });
});

// Everything registered below this line requires a session.
apiRoutes.use("*", requireSession);

// GET /api/prs?state=open&limit=50&offset=0
apiRoutes.get("/prs", async (c) => {
  const state = c.req.query("state");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);
  const offset = parseInt(c.req.query("offset") ?? "0", 10) || 0;

  const db = mirrorDb(c.env.MIRROR_DB);
  const rows = await db.select({
    id: M.pr.id,
    number: M.pr.number,
    title: M.pr.title,
    state: M.pr.state,
    draft: M.pr.draft,
    merged: M.pr.merged,
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
  let items: Array<typeof rows[number] & {
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
      htmlUrl: `${repoUrl}/pull/${p.number}`,
      quickTest: toTestRunOut(byPr.get(p.id)?.quick),
      exhaustiveTest: toTestRunOut(byPr.get(p.id)?.exhaustive),
    }));
  }

  return c.json({ items, limit, offset });
});

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
// Kicks off the server-side resync chain. The first batch is awaited inline
// so the caller's response reflects "the most-recently-updated PRs are now
// synced" before we return. If the first batch reports `hasMore`, we schedule
// the next link in the chain via `ctx.waitUntil(fetch(internalUrl))` — a new
// Worker invocation with its own 30s + 50-subreq budget. The chain keeps
// itself going until it hits the watermark or end-of-list.
//
// Only `resource: "prs"` is wired up so far; "issues" / "comments" fall back
// to the legacy fire-and-forget runJob path (to be migrated next).
apiRoutes.post("/refresh", requireSession, async (c) => {
  type Body = { resource?: "prs" | "issues" | "comments" };
  const body: Body = await c.req.json<Body>().catch(() => ({} as Body));
  const resource = body.resource ?? "prs";

  if (resource !== "prs") {
    runJob({ type: "sync.full", resource }, c.env, c.executionCtx);
    return c.json({ ok: true, queued: resource });
  }

  await syncLog(c.env, "info", "sync.refresh.start", `manual refresh by ${currentUser(c).login}`, {
    actor: currentUser(c).login,
  });

  const result = await refreshPrsBatch(c.env, 1);
  await syncLog(c.env, result.failed > 0 ? "warn" : "info", "sync.batch.done",
    `page=1 scanned=${result.scanned} processed=${result.processed} skipped=${result.skipped} failed=${result.failed} reason=${result.reason}`,
    { ...result } as Record<string, unknown>,
  );

  if (result.hasMore) {
    const origin = new URL(c.req.url).origin;
    const next = nextChainUrl(origin, result, 1);
    c.executionCtx.waitUntil(spawnChainLink(c.env, next, 1));
  }

  return c.json({
    ok: true,
    page: result.page,
    processed: result.processed,
    skipped: result.skipped,
    failed: result.failed,
    hasMore: result.hasMore,
  });
});

// POST /api/internal/sync-batch is defined above (anonymous, secret-auth'd).

// GET /api/logs?limit=200&level=error&event=sync.pr.error
// Returns recent sync_log rows, newest first. Allowlist-gated by requireSession.
apiRoutes.get("/logs", async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") ?? "200", 10) || 200, 1000);
  const level = c.req.query("level");
  const event = c.req.query("event");

  const db = appDb(c.env.APP_DB);
  const conds: ReturnType<typeof eq>[] = [];
  if (level) conds.push(eq(A.syncLog.level, level));
  if (event) conds.push(eq(A.syncLog.event, event));

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

/**
 * Fire the next link of the chain via our `SELF` service binding. Using a
 * service binding (not plain `fetch(publicUrl)`) is required because CF
 * blocks Worker→same-Worker public URL calls to prevent infinite loops;
 * those return 404 because the request lands on Static Assets instead of
 * the Worker handler. `env.SELF.fetch(url, init)` re-enters our own Worker
 * with a fresh wall-clock + subrequest budget.
 *
 * We `await r.arrayBuffer()` to drain the response — without this, the
 * connection may be torn down before the receiver finishes processing.
 */
async function spawnChainLink(env: Env, url: string, fromChainDepth: number): Promise<void> {
  try {
    const r = await env.SELF.fetch(url, {
      method: "POST",
      headers: {
        "x-internal-secret": env.WORKER_INTERNAL_SECRET,
        "content-type": "application/json",
      },
      body: "{}",
    });
    await r.arrayBuffer();
    if (!r.ok) {
      await syncLog(env, "error", "sync.chain.spawn-failed",
        `next link returned ${r.status}`, { url, fromChainDepth, status: r.status });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await syncLog(env, "error", "sync.chain.spawn-failed",
      `self-fetch threw: ${message}`, { url, fromChainDepth });
  }
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
