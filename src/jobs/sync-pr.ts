import type { Env } from "../lib/env";
import { mirrorDb } from "../db/mirror";
import * as M from "../db/mirror/schema";
import { gh } from "../lib/github-app";
import { sql } from "drizzle-orm";

/**
 * Fetch a single PR from GitHub and upsert it (idempotent).
 * We rely on GitHub's stable numeric `id` as the primary key.
 *
 * The installation id is read from a single-row config table or env. For this
 * scaffold we assume there's exactly one installation configured at deploy time
 * — production code should look it up per repo from the `installation` event.
 */
export async function syncPr(env: Env, _repoId: number, number: number): Promise<void> {
  const installationId = Number(env.UPSTREAM_OWNER) || 0; // placeholder
  // TODO: replace with a real lookup table once `installation` events are wired.
  // For now this falls through to GitHub's anonymous fetch (works for public repos)
  // if installationId is 0 by using a separate code path — kept simple here.

  const res = await fetch(
    `https://api.github.com/repos/${env.UPSTREAM_OWNER}/${env.UPSTREAM_REPO}/pulls/${number}`,
    { headers: { "User-Agent": "githost", Accept: "application/vnd.github+json" } },
  );
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

  // NB: `_repoId` and `installationId` are reserved for when we wire up multi-repo
  // and installation-token auth via gh(); kept here to keep the call sites stable.
  void _repoId; void installationId; void gh;
}
