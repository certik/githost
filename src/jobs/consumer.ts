import type { Env, JobMessage } from "../lib/env";
import { syncPr } from "./sync-pr";
import { fullResync } from "./full-resync";
import { runAiReview } from "./ai-review";

/**
 * Fire a background job from inside any request/cron handler.
 *
 * On Workers Free (no Queues), this schedules the job via `ctx.waitUntil()` so
 * the current response can return immediately while the job continues running.
 * The Worker runtime keeps the request alive until all `waitUntil` promises
 * settle (subject to per-plan wall-clock budgets).
 *
 * Switching to Queues later means changing only this function:
 *     ctx.waitUntil(env.JOBS.send(msg));
 */
export function runJob(msg: JobMessage, env: Env, ctx: ExecutionContext): void {
  ctx.waitUntil(dispatch(msg, env, ctx).catch((err) => {
    console.error("[job] failed", msg.type, err);
  }));
}

/**
 * Synchronously await a job — used by the cron scheduler and by the few API
 * endpoints that want to surface failures to the caller (e.g. `POST /api/...`
 * synchronous flows).
 */
export async function runJobAwait(msg: JobMessage, env: Env, ctx: ExecutionContext): Promise<void> {
  await dispatch(msg, env, ctx);
}

export async function dispatch(msg: JobMessage, env: Env, ctx: ExecutionContext): Promise<void> {
  switch (msg.type) {
    case "github.webhook":
      return handleWebhook(msg, env, ctx);
    case "sync.pr":
      return syncPr(env, msg.repoId, msg.number);
    case "sync.issue":
      // Same idea as syncPr; not implemented in this scaffold.
      return;
    case "sync.full":
      return fullResync(env, msg.resource, ctx);
    case "ai.review":
      return runAiReview(env, msg.aiReviewId);
  }
}

/**
 * Map an inbound webhook to one or more follow-up jobs. Idempotent — both
 * webhook redeliveries and overlapping resyncs are safe.
 */
async function handleWebhook(
  msg: Extract<JobMessage, { type: "github.webhook" }>,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const p = msg.payload as {
    repository?: { id?: number };
    pull_request?: { number?: number };
    issue?: { number?: number; pull_request?: unknown };
  };
  const repoId = p.repository?.id;
  if (!repoId) return;

  switch (msg.event) {
    case "pull_request":
    case "pull_request_review":
    case "pull_request_review_comment": {
      const num = p.pull_request?.number;
      if (num) runJob({ type: "sync.pr", repoId, number: num }, env, ctx);
      break;
    }
    case "issue_comment":
    case "issues": {
      const num = p.issue?.number;
      if (!num) break;
      // GitHub conflates issue & PR comments; if `issue.pull_request` is set, treat as PR.
      if (p.issue?.pull_request) runJob({ type: "sync.pr", repoId, number: num }, env, ctx);
      else runJob({ type: "sync.issue", repoId, number: num }, env, ctx);
      break;
    }
    default:
      break;
  }
}
