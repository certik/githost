/**
 * Truncate every user table in both D1s, leaving the schema intact.
 * Called from `beforeEach` in each integration suite.
 *
 * SQLite enforces FOREIGN KEY constraints, so we must delete child rows before
 * parent rows. The order below mirrors the dependency graph in the two
 * schemas (mirror/0001_init.sql, app/0001_init.sql). When you add a new table
 * with FKs, add it to the appropriate list ABOVE its parent.
 *
 * If a table doesn't exist (e.g. an integration test loads a subset of
 * migrations) the DELETE is silently skipped.
 */
import { env } from "cloudflare:test";

const MIRROR_ORDER = [
  "comment",         // → pr, issue, user, repo
  "label_upstream",  // → pr (CASCADE)
  "pr",              // → repo, user
  "issue",           // → repo, user
  "user",
  "repo",
  "sync_cursor",
];

const APP_ORDER = [
  "audit_log",
  "oauth_token",     // → app_user (CASCADE)
  "pr_local_label",  // → app_user, label_local (CASCADE)
  "saved_view",      // → app_user (CASCADE)
  "user_session",    // → app_user (CASCADE)
  "ai_review",
  "label_local",
  "app_user",
  // future tables (no FK) — order within group doesn't matter, but keep them here:
  "pr_test_run",
  "check_kind_map",
  "sync_log",
];

export async function resetDbs(): Promise<void> {
  await truncate(env.MIRROR_DB, MIRROR_ORDER);
  await truncate(env.APP_DB, APP_ORDER);
}

async function truncate(db: D1Database, tables: readonly string[]): Promise<void> {
  // Find which tables actually exist (some test runs skip later migrations).
  const existing = new Set<string>();
  const rows = await db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table'"
  ).all<{ name: string }>();
  for (const { name } of rows.results ?? []) existing.add(name);

  for (const name of tables) {
    if (existing.has(name)) {
      await db.prepare(`DELETE FROM "${name}"`).run();
    }
  }
}
