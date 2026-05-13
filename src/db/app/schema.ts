import { sqliteTable, integer, text, index, uniqueIndex, primaryKey } from "drizzle-orm/sqlite-core";

/**
 * App DB: irreplaceable, locally-authored data.
 *
 * Safety conventions in this schema:
 *  - Soft delete via `deleted_at` (queries should filter `deleted_at IS NULL`).
 *  - Every write goes through code that also appends to `audit_log`.
 *  - OAuth tokens are stored encrypted (AES-GCM) — see src/lib/crypto.ts.
 */

export const appUser = sqliteTable("app_user", {
  id: text("id").primaryKey(),                              // UUID
  ghUserId: integer("gh_user_id").notNull(),
  login: text("login").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (t) => ({
  ghIdx: uniqueIndex("app_user_gh_idx").on(t.ghUserId),
}));

export const userSession = sqliteTable("user_session", {
  id: text("id").primaryKey(),                              // random opaque token
  userId: text("user_id").notNull().references(() => appUser.id, { onDelete: "cascade" }),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  userAgent: text("user_agent"),
}, (t) => ({
  userIdx: index("user_session_user_idx").on(t.userId),
  expIdx: index("user_session_exp_idx").on(t.expiresAt),
}));

export const oauthToken = sqliteTable("oauth_token", {
  userId: text("user_id").primaryKey().references(() => appUser.id, { onDelete: "cascade" }),
  ciphertext: text("ciphertext").notNull(),                 // base64
  iv: text("iv").notNull(),                                 // base64
  scope: text("scope"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const aiReview = sqliteTable("ai_review", {
  id: text("id").primaryKey(),                              // UUID
  repoId: integer("repo_id").notNull(),                     // FK to mirror.repo (logical, cross-DB)
  prId: integer("pr_id").notNull(),                         // FK to mirror.pr   (logical, cross-DB)
  prNumber: integer("pr_number").notNull(),
  headSha: text("head_sha").notNull(),
  model: text("model").notNull(),
  status: text("status").notNull().default("pending"),      // "pending" | "ready" | "posted" | "discarded" | "failed"
  summary: text("summary"),
  commentsJson: text("comments_json"),                      // serialized array of {path,line,body}
  errorMessage: text("error_message"),
  postedUpstreamAt: integer("posted_upstream_at", { mode: "timestamp_ms" }),
  upstreamReviewId: integer("upstream_review_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
}, (t) => ({
  prIdx: index("ai_review_pr_idx").on(t.prId),
  shaIdx: index("ai_review_sha_idx").on(t.headSha),
  statusIdx: index("ai_review_status_idx").on(t.status),
}));

export const labelLocal = sqliteTable("label_local", {
  id: text("id").primaryKey(),                              // UUID
  repoId: integer("repo_id").notNull(),
  name: text("name").notNull(),
  color: text("color"),
  description: text("description"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
}, (t) => ({
  repoNameIdx: uniqueIndex("label_local_repo_name_idx").on(t.repoId, t.name),
}));

export const prLocalLabel = sqliteTable("pr_local_label", {
  prId: integer("pr_id").notNull(),
  labelId: text("label_id").notNull().references(() => labelLocal.id, { onDelete: "cascade" }),
  createdBy: text("created_by").references(() => appUser.id),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.prId, t.labelId] }),
}));

export const savedView = sqliteTable("saved_view", {
  id: text("id").primaryKey(),                              // UUID
  userId: text("user_id").notNull().references(() => appUser.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  filterJson: text("filter_json").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
}, (t) => ({
  userIdx: index("saved_view_user_idx").on(t.userId),
}));

export const auditLog = sqliteTable("audit_log", {
  id: text("id").primaryKey(),                              // UUID
  actor: text("actor").notNull(),                           // app_user.id | "system" | "bot:<app-id>"
  tableName: text("table_name").notNull(),
  rowId: text("row_id").notNull(),
  op: text("op").notNull(),                                 // "insert" | "update" | "delete"
  beforeJson: text("before_json"),
  afterJson: text("after_json"),
  ts: integer("ts", { mode: "timestamp_ms" }).notNull(),
}, (t) => ({
  tableRowIdx: index("audit_log_table_row_idx").on(t.tableName, t.rowId),
  tsIdx: index("audit_log_ts_idx").on(t.ts),
}));
