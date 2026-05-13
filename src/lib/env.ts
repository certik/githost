/**
 * Worker bindings, secrets, and plain vars.
 * Keep this file as the single source of truth; route handlers should depend on `Env`
 * rather than reading from `process.env` (which doesn't exist on Workers anyway).
 */
export interface Env {
  // D1 databases
  MIRROR_DB: D1Database;
  APP_DB: D1Database;

  // KV namespace for cached PR diffs (small, bounded)
  DIFF_CACHE: KVNamespace;

  // Static assets (the React SPA built into web/dist)
  ASSETS: Fetcher;

  // Plain vars
  UPSTREAM_OWNER: string;
  UPSTREAM_REPO: string;
  GITHUB_INSTALLATION_ID: string;
  ALLOWED_GITHUB_LOGINS: string;

  // Secrets (set via `wrangler secret put` or .dev.vars locally)
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_OAUTH_CLIENT_ID: string;
  GITHUB_OAUTH_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string;

  // Shared secret used to authenticate the server's self-fetch chain
  // (POST /api/internal/sync-batch). Set via `wrangler secret put
  // WORKER_INTERNAL_SECRET`. Random opaque string, never sent to clients.
  WORKER_INTERNAL_SECRET: string;

  // Service binding pointing at ourselves. Used by the resync chain to
  // spawn follow-up batch invocations without going through public routing
  // (which would 404 due to CF's anti-loop protection). See wrangler.toml.
  SELF: Fetcher;

  // Local-dev only — when set to "true", GET /auth/dev-login creates a session
  // and signs you in as the user named in the `login` query param (default
  // "dev"). Should ONLY be set in .dev.vars (which is git-ignored) — never in
  // wrangler.toml [vars] and never via `wrangler secret put`. In production
  // this is undefined, so /auth/dev-login 404s.
  DEV_LOGIN_ENABLED?: string;
}

/**
 * Discriminated union of every kind of background job. Adding a new job type =
 * extend this union and add a handler in src/jobs/consumer.ts.
 *
 * NOTE: On the Workers Free plan we don't have Queues, so jobs run via
 * `ctx.waitUntil(dispatch(msg, env, ctx))` in the same Worker invocation that
 * produced them. The discriminated-union/dispatch pattern is preserved so we
 * can move to real Queues later by switching the producer site only.
 */
export type JobMessage =
  | { type: "github.webhook"; event: string; deliveryId: string; payload: unknown }
  | { type: "sync.pr"; repoId: number; number: number }
  | { type: "sync.issue"; repoId: number; number: number }
  | { type: "sync.full"; resource: "prs" | "issues" | "comments" }
  | { type: "ai.review"; aiReviewId: string };
