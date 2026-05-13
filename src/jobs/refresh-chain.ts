import type { Env } from "../lib/env";
import { mirrorDb } from "../db/mirror";
import * as M from "../db/mirror/schema";
import { gh } from "../lib/github-app";
import { inArray } from "drizzle-orm";
import { syncPr } from "./sync-pr";
import { syncLog } from "../lib/sync-log";

/**
 * Server-driven resync that walks the upstream PR list one page at a time and
 * only re-fetches PRs whose `updated_at` on GitHub is newer than what we have
 * in the mirror DB. Each call to `refreshPrsBatch` processes exactly one
 * page and returns whether further work is needed; the caller (the internal
 * /api/internal/sync-batch endpoint) is responsible for spawning the next
 * link in the chain via `ctx.waitUntil(fetch(selfUrl))`.
 *
 * Why batch-per-invocation instead of looping in one Worker invocation?
 *   - Workers Free gives 30s wall-clock and 50 subrequests per request.
 *   - Each syncPr makes 2 subrequests (PR detail + check-runs).
 *   - 1 list fetch + up to 20 syncs = 41 subrequests = fits comfortably.
 *   - Spawning the next link via self-fetch creates a fresh invocation with a
 *     fresh budget, so the chain can run as long as it needs to.
 *
 * Watermark optimization: if every item on this page is already current in
 * the mirror, all older items are too (the list is `sort=updated&desc`), so
 * we return `hasMore: false` and the chain terminates without paging further.
 */

export const REFRESH_PER_PAGE = 50;
export const MAX_SYNCS_PER_BATCH = 20;
export const MAX_CHAIN_DEPTH = 25;          // 25 * 50 = 1250 PRs covered per chain

export interface BatchResult {
  page: number;
  scanned: number;     // items returned by GitHub on this page
  processed: number;   // PRs we actually re-fetched + upserted
  skipped: number;     // PRs that were already current in the mirror
  failed: number;      // syncPr() throws that we caught (logged)
  hasMore: boolean;    // true iff caller should schedule next page
  reason: string;      // why we stopped (for the log)
}

export async function refreshPrsBatch(env: Env, page: number): Promise<BatchResult> {
  const installationId = parseInt(env.GITHUB_INSTALLATION_ID, 10);
  const owner = env.UPSTREAM_OWNER;
  const repo = env.UPSTREAM_REPO;

  const listPath = `/repos/${owner}/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=${REFRESH_PER_PAGE}&page=${page}`;
  const res = await gh(env, { installationId, path: listPath });
  if (!res.ok) {
    const msg = `list page ${page}: ${res.status} ${await res.text()}`;
    await syncLog(env, "error", "sync.batch.error", msg, { page });
    throw new Error(msg);
  }
  const items = await res.json<Array<{
    id: number; number: number; updated_at: string;
  }>>();

  if (items.length === 0) {
    return { page, scanned: 0, processed: 0, skipped: 0, failed: 0, hasMore: false, reason: "end-of-list" };
  }

  // Look up the mirror rows for these PRs in one query so we can compare
  // updated_at without N round-trips. Drizzle/D1 handles the parameterized IN.
  const db = mirrorDb(env.MIRROR_DB);
  const ids = items.map((i) => i.id);
  const known = await db.select({ id: M.pr.id, updatedAt: M.pr.updatedAt })
    .from(M.pr)
    .where(inArray(M.pr.id, ids))
    .all();
  const knownById = new Map(known.map((r) => [r.id, r.updatedAt]));

  // Decide which items need a re-fetch.
  const stale: Array<{ number: number; id: number }> = [];
  for (const item of items) {
    const have = knownById.get(item.id);
    const itemUpdated = new Date(item.updated_at);
    if (!have || have.getTime() < itemUpdated.getTime()) {
      stale.push({ number: item.number, id: item.id });
    }
  }

  // Cap syncs per batch to stay under the subrequest budget. The unprocessed
  // ones will surface again on the next chain run because they're still stale.
  const toSync = stale.slice(0, MAX_SYNCS_PER_BATCH);
  let processed = 0;
  let failed = 0;

  // Sync in parallel — Promise.allSettled so one PR failure doesn't kill the
  // batch (we log it and move on).
  const results = await Promise.allSettled(
    toSync.map(async (s) => {
      try {
        await syncPr(env, 0, s.number);
        return { ok: true as const, number: s.number };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await syncLog(env, "error", "sync.pr.error", `pr #${s.number}: ${message}`, {
          prNumber: s.number,
          page,
          stack: err instanceof Error ? err.stack : undefined,
        });
        return { ok: false as const, number: s.number, message };
      }
    }),
  );
  for (const r of results) {
    if (r.status === "fulfilled" && r.value.ok) processed++;
    else failed++;
  }

  const skipped = items.length - stale.length;

  // Stop conditions:
  //  1. End of list (we got less than a full page → no more pages exist).
  //  2. Whole page was current AND we didn't have to cap (no leftover stale)
  //     → watermark hit; everything older is also current.
  //  3. We hit the per-batch sync cap → there are more stale items on THIS
  //     page; the chain should retry the same page to drain them.
  let hasMore: boolean;
  let reason: string;
  if (items.length < REFRESH_PER_PAGE) {
    hasMore = false;
    reason = "end-of-list";
  } else if (stale.length === 0) {
    hasMore = false;
    reason = "watermark-hit";
  } else if (stale.length > toSync.length) {
    hasMore = true;
    reason = "page-not-drained";
  } else {
    hasMore = true;
    reason = "next-page";
  }

  return { page, scanned: items.length, processed, skipped, failed, hasMore, reason };
}

/**
 * Build the URL the chain self-fetches to advance one link. We honor the
 * current request's origin so this works in dev (localhost), preview, and
 * prod without env config.
 *
 * If a batch returned `hasMore: true` with reason "page-not-drained", we
 * re-run the same page; otherwise advance.
 */
export function nextChainUrl(origin: string, result: BatchResult, chainDepth: number): string {
  const next = result.reason === "page-not-drained" ? result.page : result.page + 1;
  return `${origin}/api/internal/sync-batch?page=${next}&chain=${chainDepth + 1}`;
}
