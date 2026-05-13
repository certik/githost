import type { Env } from "../lib/env";
import { runJob, runJobAwait } from "./consumer";
import { mirrorDb } from "../db/mirror";
import * as M from "../db/mirror/schema";
import { eq } from "drizzle-orm";

/**
 * Full resync sweep with cursor support. Uses GitHub's `since` semantics where
 * available so subsequent runs are cheap. Each individual PR/issue update is
 * fanned out via `runJob` so we don't block this invocation, but we limit
 * pages-per-sweep to stay within the free-plan budget.
 */
export async function fullResync(
  env: Env,
  resource: "prs" | "issues" | "comments",
  ctx: ExecutionContext,
): Promise<void> {
  const db = mirrorDb(env.MIRROR_DB);
  const cursorRow = await db.select().from(M.syncCursor).where(eq(M.syncCursor.kind, resource)).get();
  const since = cursorRow?.value;

  const owner = env.UPSTREAM_OWNER;
  const name = env.UPSTREAM_REPO;
  const base = `https://api.github.com/repos/${owner}/${name}`;

  let url: string | null;
  switch (resource) {
    case "prs":     url = `${base}/pulls?state=all&sort=updated&direction=desc&per_page=50`; break;
    case "issues":  url = `${base}/issues?state=all&sort=updated&direction=desc&per_page=50${since ? `&since=${encodeURIComponent(since)}` : ""}`; break;
    case "comments":url = `${base}/issues/comments?sort=updated&direction=desc&per_page=100${since ? `&since=${encodeURIComponent(since)}` : ""}`; break;
  }

  let newestUpdatedAt: string | undefined;
  let safety = 10; // page cap per sweep — cron runs nightly, full backfill happens over a few nights

  while (url && safety-- > 0) {
    const res = await fetch(url, { headers: { "User-Agent": "githost", Accept: "application/vnd.github+json" } });
    if (!res.ok) throw new Error(`resync ${resource}: ${res.status}`);
    const items = await res.json<any[]>();
    for (const item of items) {
      newestUpdatedAt ??= item.updated_at;
      if (resource === "prs" || (resource === "issues" && !item.pull_request)) {
        // Run inline (await) so we don't accumulate hundreds of waitUntil promises
        // in a single invocation. Each upsert is one HTTP + one D1 write.
        await runJobAwait(
          { type: resource === "prs" ? "sync.pr" : "sync.issue", repoId: item.base?.repo?.id ?? item.repository_id ?? 0, number: item.number },
          env, ctx,
        );
      } else if (resource === "issues" && item.pull_request) {
        await runJobAwait({ type: "sync.pr", repoId: 0, number: item.number }, env, ctx);
      }
      // 'comments' fan-out left as an exercise — typically we just re-pull the
      // owning PR/issue and let syncPr/syncIssue refresh the comment set.
    }
    url = parseNextLink(res.headers.get("link"));
    if (since && items.length && items[items.length - 1]!.updated_at < since) break;
  }

  if (newestUpdatedAt) {
    await db.insert(M.syncCursor)
      .values({ kind: resource, value: newestUpdatedAt, updatedAt: new Date() })
      .onConflictDoUpdate({ target: M.syncCursor.kind, set: { value: newestUpdatedAt, updatedAt: new Date() } })
      .run();
  }

  // `runJob` import kept available for non-cron callers; quiet the linter.
  void runJob;
}

function parseNextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (m) return m[1] ?? null;
  }
  return null;
}
