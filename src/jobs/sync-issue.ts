import type { Env } from "../lib/env";
import { mirrorDb } from "../db/mirror";
import * as M from "../db/mirror/schema";
import { gh } from "../lib/github-app";
import { eq } from "drizzle-orm";

/**
 * Fetch a single issue from GitHub and upsert it (idempotent).
 * Mirror of syncPr; GitHub's REST API exposes issues and PRs separately
 * but they share much of the schema. Comments are captured via the PR/issue
 * resync paths; not duplicated here.
 */
export async function syncIssue(env: Env, _repoId: number, number: number): Promise<void> {
  const installationId = parseInt(env.GITHUB_INSTALLATION_ID, 10);

  const res = await gh(env, {
    installationId,
    path: `/repos/${env.UPSTREAM_OWNER}/${env.UPSTREAM_REPO}/issues/${number}`,
  });
  if (!res.ok) throw new Error(`fetch issue #${number}: ${res.status} ${await res.text()}`);
  const data = await res.json<any>();

  // `/issues/:n` also returns PRs (issues + PRs share number-space). Skip if PR.
  if (data.pull_request) return;

  const db = mirrorDb(env.MIRROR_DB);

  if (data.user) {
    await db.insert(M.user)
      .values({ id: data.user.id, login: data.user.login, avatarUrl: data.user.avatar_url, htmlUrl: data.user.html_url, isBot: data.user.type === "Bot" })
      .onConflictDoUpdate({ target: M.user.id, set: { login: data.user.login, avatarUrl: data.user.avatar_url, htmlUrl: data.user.html_url } })
      .run();
  }

  // The /issues/:n payload doesn't include repository.id directly; look up via
  // (owner, name). syncPr almost always populates this row first, so it exists.
  const repoRow = await db
    .select({ id: M.repo.id })
    .from(M.repo)
    .where(eq(M.repo.owner, env.UPSTREAM_OWNER))
    .get();
  if (!repoRow) throw new Error(`syncIssue: repo row missing for ${env.UPSTREAM_OWNER}/${env.UPSTREAM_REPO}; run a PR sync first`);

  await db.insert(M.issue)
    .values({
      id: data.id,
      repoId: repoRow.id,
      number: data.number,
      state: data.state,
      title: data.title ?? "",
      body: data.body ?? null,
      authorId: data.user?.id ?? null,
      createdAt: new Date(data.created_at),
      updatedAt: new Date(data.updated_at),
      closedAt: data.closed_at ? new Date(data.closed_at) : null,
      rawJson: JSON.stringify(data),
    })
    .onConflictDoUpdate({
      target: M.issue.id,
      set: {
        state: data.state,
        title: data.title ?? "",
        body: data.body ?? null,
        updatedAt: new Date(data.updated_at),
        closedAt: data.closed_at ? new Date(data.closed_at) : null,
        rawJson: JSON.stringify(data),
      },
    })
    .run();

  void _repoId;
}
