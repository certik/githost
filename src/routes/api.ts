import { Hono } from "hono";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Env } from "../lib/env";
import { mirrorDb } from "../db/mirror";
import * as M from "../db/mirror/schema";
import { appDb } from "../db/app";
import * as A from "../db/app/schema";
import { gh } from "../lib/github-app";
import { runJob } from "../jobs/consumer";
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

  return c.json({ items: rows, limit, offset });
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

// POST /api/refresh  { resource: "prs" | "issues" | "comments" }  → enqueue full resync
apiRoutes.post("/refresh", requireSession, async (c) => {
  type Body = { resource?: "prs" | "issues" | "comments" };
  const body: Body = await c.req.json<Body>().catch(() => ({} as Body));
  const resource = body.resource ?? "prs";
  runJob({ type: "sync.full", resource }, c.env, c.executionCtx);
  return c.json({ ok: true, queued: resource });
});

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
