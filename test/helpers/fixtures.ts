/**
 * Seed mirror DB fixtures so API tests can assert without going through the
 * GitHub-sync code paths.
 */
import { env } from "cloudflare:test";

export interface PrFixture {
  id: number;
  number: number;
  state?: "open" | "closed";
  draft?: boolean;
  merged?: boolean;
  title?: string;
  headSha?: string;
  baseSha?: string;
}

export async function seedRepo(id = 1, owner = "testorg", name = "testrepo"): Promise<void> {
  await env.MIRROR_DB.prepare(
    "INSERT OR IGNORE INTO repo (id, owner, name, default_branch) VALUES (?, ?, ?, 'main')"
  ).bind(id, owner, name).run();
}

export async function seedPr(p: PrFixture): Promise<void> {
  await seedRepo();
  const now = Date.now();
  await env.MIRROR_DB.prepare(
    `INSERT INTO pr (id, repo_id, number, state, draft, merged, title, head_sha, base_sha,
                      created_at, updated_at)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    p.id,
    p.number,
    p.state ?? "open",
    p.draft ? 1 : 0,
    p.merged ? 1 : 0,
    p.title ?? `Test PR #${p.number}`,
    p.headSha ?? null,
    p.baseSha ?? null,
    now,
    now,
  ).run();
}
