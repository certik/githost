import { sqliteTable, integer, text, primaryKey, index, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Mirror DB: a cache of upstream GitHub state. Safe to wipe and re-sync.
 *
 * Conventions:
 *  - Primary keys are GitHub's numeric `id` (stable, globally unique per resource).
 *  - `raw_json` holds the last full payload, useful for forensic / replay.
 *  - Timestamps are unix-ms integers (`mode: "timestamp_ms"` in Drizzle).
 *  - Idempotent upserts use `ON CONFLICT(id) DO UPDATE`.
 */

export const repo = sqliteTable("repo", {
  id: integer("id").primaryKey(),
  owner: text("owner").notNull(),
  name: text("name").notNull(),
  defaultBranch: text("default_branch"),
  etag: text("etag"),
  lastFullSyncAt: integer("last_full_sync_at", { mode: "timestamp_ms" }),
}, (t) => ({
  ownerNameIdx: uniqueIndex("repo_owner_name_idx").on(t.owner, t.name),
}));

export const user = sqliteTable("user", {
  id: integer("id").primaryKey(),
  login: text("login").notNull(),
  avatarUrl: text("avatar_url"),
  htmlUrl: text("html_url"),
  isBot: integer("is_bot", { mode: "boolean" }).notNull().default(false),
}, (t) => ({
  loginIdx: uniqueIndex("user_login_idx").on(t.login),
}));

export const pr = sqliteTable("pr", {
  id: integer("id").primaryKey(),
  repoId: integer("repo_id").notNull().references(() => repo.id),
  number: integer("number").notNull(),
  state: text("state").notNull(),                          // "open" | "closed"
  draft: integer("draft", { mode: "boolean" }).notNull().default(false),
  merged: integer("merged", { mode: "boolean" }).notNull().default(false),
  title: text("title").notNull(),
  body: text("body"),
  authorId: integer("author_id").references(() => user.id),
  headRef: text("head_ref"),
  headSha: text("head_sha"),
  baseRef: text("base_ref"),
  baseSha: text("base_sha"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  closedAt: integer("closed_at", { mode: "timestamp_ms" }),
  mergedAt: integer("merged_at", { mode: "timestamp_ms" }),
  rawJson: text("raw_json"),
}, (t) => ({
  repoNumberIdx: uniqueIndex("pr_repo_number_idx").on(t.repoId, t.number),
  updatedIdx: index("pr_updated_idx").on(t.updatedAt),
  stateIdx: index("pr_state_idx").on(t.state),
}));

export const issue = sqliteTable("issue", {
  id: integer("id").primaryKey(),
  repoId: integer("repo_id").notNull().references(() => repo.id),
  number: integer("number").notNull(),
  state: text("state").notNull(),                          // "open" | "closed"
  title: text("title").notNull(),
  body: text("body"),
  authorId: integer("author_id").references(() => user.id),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  closedAt: integer("closed_at", { mode: "timestamp_ms" }),
  rawJson: text("raw_json"),
}, (t) => ({
  repoNumberIdx: uniqueIndex("issue_repo_number_idx").on(t.repoId, t.number),
  updatedIdx: index("issue_updated_idx").on(t.updatedAt),
}));

export const comment = sqliteTable("comment", {
  id: integer("id").primaryKey(),
  repoId: integer("repo_id").notNull().references(() => repo.id),
  kind: text("kind").notNull(),                            // "issue" | "review" | "review_comment"
  prId: integer("pr_id").references(() => pr.id),
  issueId: integer("issue_id").references(() => issue.id),
  authorId: integer("author_id").references(() => user.id),
  body: text("body"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  rawJson: text("raw_json"),
}, (t) => ({
  prIdx: index("comment_pr_idx").on(t.prId),
  issueIdx: index("comment_issue_idx").on(t.issueId),
}));

export const labelUpstream = sqliteTable("label_upstream", {
  prId: integer("pr_id").notNull().references(() => pr.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  color: text("color"),
}, (t) => ({
  pk: primaryKey({ columns: [t.prId, t.name] }),
}));

/**
 * Resync cursors. `kind` examples: "prs", "issues", "comments".
 * `value` is the ISO-8601 timestamp passed as GitHub's `since` query param.
 */
export const syncCursor = sqliteTable("sync_cursor", {
  kind: text("kind").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
