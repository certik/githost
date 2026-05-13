import type { Env } from "../lib/env";
import { mirrorDb } from "../db/mirror";
import * as M from "../db/mirror/schema";
import { appDb } from "../db/app";
import * as A from "../db/app/schema";
import { gh } from "../lib/github-app";
import { mapCheckToKind, type CheckMapping } from "../lib/check-mapper";
import { aggregateChecks, type GhCheckRun } from "../lib/check-aggregator";
import { and, eq, sql } from "drizzle-orm";

/**
 * Fetch a single PR from GitHub and upsert it (idempotent).
 * Uses an authenticated installation-token request so we get full rate limits
 * (5000 req/hour per installation) and access to private repos.
 *
 * We rely on GitHub's stable numeric `id` as the primary key.
 */
export async function syncPr(env: Env, _repoId: number, number: number): Promise<void> {
  const installationId = parseInt(env.GITHUB_INSTALLATION_ID, 10);

  const res = await gh(env, {
    installationId,
    path: `/repos/${env.UPSTREAM_OWNER}/${env.UPSTREAM_REPO}/pulls/${number}`,
  });
  if (!res.ok) throw new Error(`fetch pr #${number}: ${res.status} ${await res.text()}`);
  const data = await res.json<any>();

  const db = mirrorDb(env.MIRROR_DB);

  // Upsert author + repo so FK constraints hold.
  await db.insert(M.repo)
    .values({ id: data.base.repo.id, owner: data.base.repo.owner.login, name: data.base.repo.name, defaultBranch: data.base.repo.default_branch })
    .onConflictDoUpdate({ target: M.repo.id, set: { defaultBranch: data.base.repo.default_branch } })
    .run();

  if (data.user) {
    await db.insert(M.user)
      .values({ id: data.user.id, login: data.user.login, avatarUrl: data.user.avatar_url, htmlUrl: data.user.html_url, isBot: data.user.type === "Bot" })
      .onConflictDoUpdate({ target: M.user.id, set: { login: data.user.login, avatarUrl: data.user.avatar_url, htmlUrl: data.user.html_url } })
      .run();
  }

  await db.insert(M.pr)
    .values({
      id: data.id,
      repoId: data.base.repo.id,
      number: data.number,
      state: data.state,
      draft: !!data.draft,
      merged: !!data.merged,
      title: data.title ?? "",
      body: data.body ?? null,
      authorId: data.user?.id ?? null,
      headRef: data.head?.ref ?? null,
      headSha: data.head?.sha ?? null,
      baseRef: data.base?.ref ?? null,
      baseSha: data.base?.sha ?? null,
      createdAt: new Date(data.created_at),
      updatedAt: new Date(data.updated_at),
      closedAt: data.closed_at ? new Date(data.closed_at) : null,
      mergedAt: data.merged_at ? new Date(data.merged_at) : null,
      rawJson: JSON.stringify(data),
    })
    .onConflictDoUpdate({
      target: M.pr.id,
      set: {
        state: data.state,
        draft: !!data.draft,
        merged: !!data.merged,
        title: data.title ?? "",
        body: data.body ?? null,
        headRef: data.head?.ref ?? null,
        headSha: data.head?.sha ?? null,
        baseRef: data.base?.ref ?? null,
        baseSha: data.base?.sha ?? null,
        updatedAt: new Date(data.updated_at),
        closedAt: data.closed_at ? new Date(data.closed_at) : null,
        mergedAt: data.merged_at ? new Date(data.merged_at) : null,
        rawJson: JSON.stringify(data),
      },
    })
    .run();

  // Replace upstream labels for this PR (simple, correct on update).
  await db.delete(M.labelUpstream).where(sql`pr_id = ${data.id}`).run();
  for (const l of data.labels ?? []) {
    await db.insert(M.labelUpstream).values({ prId: data.id, name: l.name, color: l.color }).run();
  }

  // Pull GitHub check runs for this PR's head SHA and bucket them per
  // check_kind_map. Each bucket aggregates to one pr_test_run row.
  if (data.head?.sha) {
    await syncPrChecks(env, data.id, data.head.sha);
  }

  // NB: `_repoId` is reserved for when we wire up multi-repo support.
  void _repoId;
}

/**
 * Fetch GitHub check runs for `headSha` and update pr_test_run accordingly.
 *
 * For each kind in (quick, exhaustive):
 *   - aggregate matching check runs into one status
 *   - upsert pr_test_run row, OR delete the existing row if no checks match
 *     (keeps the UI in sync with upstream — no stale colors)
 *
 * Silent on a 404 from GitHub (the SHA may have just been force-pushed away).
 */
async function syncPrChecks(env: Env, prId: number, headSha: string): Promise<void> {
  const installationId = parseInt(env.GITHUB_INSTALLATION_ID, 10);
  const res = await gh(env, {
    installationId,
    path: `/repos/${env.UPSTREAM_OWNER}/${env.UPSTREAM_REPO}/commits/${headSha}/check-runs?per_page=100`,
  });
  if (!res.ok) {
    if (res.status === 404) return;
    throw new Error(`check-runs for ${headSha}: ${res.status} ${await res.text()}`);
  }
  const data = await res.json<{ check_runs: GhCheckRun[] }>();

  const adb = appDb(env.APP_DB);
  const mappingRows = await adb.select().from(A.checkKindMap).all();
  const mappings: CheckMapping[] = mappingRows.map((m) => ({
    pattern: m.pattern, kind: m.kind, matchType: m.matchType, priority: m.priority,
  }));

  const buckets: Record<"quick" | "exhaustive", GhCheckRun[]> = { quick: [], exhaustive: [] };
  for (const run of data.check_runs ?? []) {
    const kind = mapCheckToKind(run.name, mappings);
    if (kind === "quick" || kind === "exhaustive") buckets[kind].push(run);
  }

  const now = new Date();
  for (const kind of ["quick", "exhaustive"] as const) {
    const status = aggregateChecks(buckets[kind]);
    if (status === null) {
      // No matching checks — drop any stale row so the UI shows an empty ring.
      await adb.delete(A.prTestRun)
        .where(and(eq(A.prTestRun.prId, prId), eq(A.prTestRun.kind, kind)))
        .run();
      continue;
    }
    await adb.insert(A.prTestRun).values({
      prId, kind, status, headSha, updatedAt: now,
    }).onConflictDoUpdate({
      target: [A.prTestRun.prId, A.prTestRun.kind],
      set: { status, headSha, updatedAt: now },
    }).run();
  }
}
