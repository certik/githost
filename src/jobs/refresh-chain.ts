import type { Env } from "../lib/env";
import { mirrorDb } from "../db/mirror";
import * as M from "../db/mirror/schema";
import { gh } from "../lib/github-app";
import { inArray } from "drizzle-orm";
import { syncPr } from "./sync-pr";
import { syncLog } from "../lib/sync-log";

/**
 * One batch of the resync chain. Walks one page of GitHub's PR list, syncs
 * only the items whose `updated_at` is newer than what we have in the mirror
 * DB, and reports how much remains via `hasMore`.
 *
 * The CALLER is responsible for advancing the chain (e.g. the SyncChain
 * Durable Object schedules another alarm if `hasMore` is true). This module
 * is intentionally side-effect-free w.r.t. the chain's next step — it just
 * processes one page and returns.
 *
 * Why batches:
 *   - Workers Free gives 30s wall-clock and 50 subrequests per invocation.
 *   - Each syncPr makes 2 subrequests (PR detail + check-runs).
 *   - 1 list fetch + up to 20 syncs = 41 subrequests = fits comfortably.
 *
 * Watermark optimization: if every item on a page is already current, all
 * older items are too (the list is sorted updated_at DESC), so we return
 * `hasMore: false` and the caller terminates without paging further.
 */

export const REFRESH_PER_PAGE = 50;
export const MAX_SYNCS_PER_BATCH = 20;

export interface BatchResult {
  page: number;
  scanned: number;     // items returned by GitHub on this page
  processed: number;   // PRs we actually re-fetched + upserted
  skipped: number;     // PRs that were already current in the mirror
  failed: number;      // syncPr() throws that we caught (logged)
  forcedConsumed: number; // how many of `processed` were forced refreshes
  hasMore: boolean;    // true iff caller should run another batch
  reason: string;      // why we stopped (for the log)
}

/**
 * Process one page of upstream PRs.
 *
 * `forceRemaining` is the running count of items the caller wants synced
 * regardless of the watermark — typically 50 (= `REFRESH_PER_PAGE`), one
 * page worth, so a Manual Refresh always re-fetches what's visible on the
 * main UI. The forced budget is consumed left-to-right (newest first) so
 * the most-recently-touched PRs are guaranteed-current after one click,
 * even if their mirror.updated_at hasn't actually drifted.
 *
 * Items beyond the forced budget go through the normal watermark check
 * (skip if mirror is current, sync otherwise). Once both the forced budget
 * is exhausted AND a page is fully current, the chain stops.
 */
export async function refreshPrsBatch(env: Env, page: number, forceRemaining = 0): Promise<BatchResult> {
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
    return { page, scanned: 0, processed: 0, skipped: 0, failed: 0, forcedConsumed: 0, hasMore: false, reason: "end-of-list" };
  }

  // Look up the mirror rows for these PRs in one query so we can compare
  // updated_at + check whether we still need to populate mergeable. Drizzle/D1
  // handles the parameterized IN.
  const db = mirrorDb(env.MIRROR_DB);
  const ids = items.map((i) => i.id);
  const known = await db.select({
    id: M.pr.id,
    updatedAt: M.pr.updatedAt,
    state: M.pr.state,
    merged: M.pr.merged,
    mergeable: M.pr.mergeable,
  })
    .from(M.pr)
    .where(inArray(M.pr.id, ids))
    .all();
  const knownById = new Map(known.map((r) => [r.id, r]));

  // Decide which items need a re-fetch. Reasons:
  //  - forced (top of upstream list, within the caller's force budget)
  //  - new (not in mirror yet)
  //  - GitHub updated_at > mirror updated_at (real upstream change)
  //  - open + not-merged with mergeable IS NULL: backfill freshly-added
  //    mergeable field. Once populated, the row hits the normal watermark
  //    on subsequent passes.
  const stale: Array<{ number: number; id: number; forced: boolean }> = [];
  let forcedThisPage = 0;
  for (const item of items) {
    const forced = forcedThisPage < forceRemaining;
    if (forced) {
      stale.push({ number: item.number, id: item.id, forced: true });
      forcedThisPage++;
      continue;
    }
    const have = knownById.get(item.id);
    const itemUpdated = new Date(item.updated_at);
    if (!have) {
      stale.push({ number: item.number, id: item.id, forced: false });
      continue;
    }
    if (have.updatedAt.getTime() < itemUpdated.getTime()) {
      stale.push({ number: item.number, id: item.id, forced: false });
      continue;
    }
    if (have.state === "open" && !have.merged && have.mergeable === null) {
      stale.push({ number: item.number, id: item.id, forced: false });
      continue;
    }
  }

  // Cap syncs per batch to stay under the subrequest budget. The unprocessed
  // ones will surface again on the next chain run because they're still stale.
  const toSync = stale.slice(0, MAX_SYNCS_PER_BATCH);
  let processed = 0;
  let failed = 0;
  let forcedConsumed = 0;

  // Sync in parallel — Promise.allSettled so one PR failure doesn't kill the
  // batch (we log it and move on).
  const results = await Promise.allSettled(
    toSync.map(async (s) => {
      try {
        await syncPr(env, 0, s.number);
        return { ok: true as const, number: s.number, forced: s.forced };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await syncLog(env, "error", "sync.pr.error", `pr #${s.number}: ${message}`, {
          prNumber: s.number,
          page,
          stack: err instanceof Error ? err.stack : undefined,
        });
        return { ok: false as const, number: s.number, forced: s.forced, message };
      }
    }),
  );
  for (const r of results) {
    if (r.status === "fulfilled" && r.value.ok) {
      processed++;
      if (r.value.forced) forcedConsumed++;
    } else {
      failed++;
    }
  }

  // skipped = items that we looked at on this page but did not enqueue
  // (watermark says they're current). Forced items never count as skipped.
  const skipped = items.length - stale.length;

  // Stop conditions (evaluated top-to-bottom; first match wins):
  //  1. End of list (we got less than a full page → no more pages exist).
  //  2. Stale items left over after the per-batch cap → re-run THIS page
  //     (page-not-drained). Checked before watermark so a forced budget
  //     that exceeds MAX_SYNCS_PER_BATCH correctly tells the chain to
  //     come back to this page.
  //  3. Forced budget exhausted AND nothing else stale on this page →
  //     watermark hit, everything older is current.
  //  4. Full page consumed, stale items still expected on next page →
  //     advance.
  const forceLeftAfterPage = forceRemaining - forcedThisPage;
  let hasMore: boolean;
  let reason: string;
  if (items.length < REFRESH_PER_PAGE) {
    hasMore = false;
    reason = "end-of-list";
  } else if (stale.length > toSync.length) {
    hasMore = true;
    reason = "page-not-drained";
  } else if (forceLeftAfterPage <= 0 && stale.length === forcedThisPage) {
    hasMore = false;
    reason = "watermark-hit";
  } else {
    hasMore = true;
    reason = "next-page";
  }

  return { page, scanned: items.length, processed, skipped, failed, forcedConsumed, hasMore, reason };
}
