/**
 * Worker bindings, secrets, and plain vars.
 * Keep this file as the single source of truth; route handlers should depend on `Env`
 * rather than reading from `process.env` (which doesn't exist on Workers anyway).
 */
export interface Env {
  // D1 databases
  MIRROR_DB: D1Database;
  APP_DB: D1Database;

  // R2 bucket for cached diffs + nightly DB exports
  BLOBS: R2Bucket;

  // Queue producer binding (the consumer is wired via wrangler.toml -> exported `queue` handler)
  JOBS: Queue<JobMessage>;

  // Static assets (the React SPA built into web/dist)
  ASSETS: Fetcher;

  // Plain vars
  UPSTREAM_OWNER: string;
  UPSTREAM_REPO: string;
  BACKUP_RETENTION_DAYS: string;

  // Secrets (set via `wrangler secret put` or .dev.vars locally)
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_OAUTH_CLIENT_ID: string;
  GITHUB_OAUTH_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string;
}

/**
 * Discriminated union of every kind of background job. Adding a new job type =
 * extend this union and add a handler in src/jobs/consumer.ts.
 */
export type JobMessage =
  | { type: "github.webhook"; event: string; deliveryId: string; payload: unknown }
  | { type: "sync.pr"; repoId: number; number: number }
  | { type: "sync.issue"; repoId: number; number: number }
  | { type: "sync.full"; resource: "prs" | "issues" | "comments" }
  | { type: "ai.review"; aiReviewId: string };
