import type { Env, JobMessage } from "../lib/env";
import { syncPr } from "./sync-pr";
import { fullResync } from "./full-resync";
import { runAiReview } from "./ai-review";

/**
 * Queue consumer entry point. Wrangler delivers messages in batches; we process
 * each independently and mark failures so the runtime can retry per-message.
 *
 * Idempotency is the responsibility of each handler — we may see duplicates due
 * to GitHub redeliveries and queue retries.
 */
export async function handleQueue(batch: MessageBatch<JobMessage>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    try {
      await dispatch(msg.body, env);
      msg.ack();
    } catch (err) {
      console.error("[queue] handler error", msg.body.type, err);
      msg.retry();
    }
  }
}

async function dispatch(msg: JobMessage, env: Env): Promise<void> {
  switch (msg.type) {
    case "github.webhook":
      return handleWebhook(msg, env);
    case "sync.pr":
      return syncPr(env, msg.repoId, msg.number);
    case "sync.issue":
      // Same idea as syncPr; not implemented in this scaffold.
      return;
    case "sync.full":
      return fullResync(env, msg.resource);
    case "ai.review":
      return runAiReview(env, msg.aiReviewId);
  }
}

/**
 * Map an inbound webhook to one or more follow-up jobs.
 * We deliberately don't try to write the DB directly here — instead we enqueue
 * a targeted resync (e.g. sync.pr) so the same code path handles both webhook-
 * driven and manual updates, keeping behavior consistent and idempotent.
 */
async function handleWebhook(
  msg: Extract<JobMessage, { type: "github.webhook" }>,
  env: Env,
): Promise<void> {
  const p = msg.payload as { repository?: { id?: number }; pull_request?: { number?: number }; issue?: { number?: number; pull_request?: unknown } };
  const repoId = p.repository?.id;
  if (!repoId) return;

  switch (msg.event) {
    case "pull_request":
    case "pull_request_review":
    case "pull_request_review_comment": {
      const num = p.pull_request?.number ?? (p as any).pull_request?.number;
      if (num) await env.JOBS.send({ type: "sync.pr", repoId, number: num });
      break;
    }
    case "issue_comment":
    case "issues": {
      const num = p.issue?.number;
      if (!num) break;
      // GitHub conflates issue & PR comments; if `issue.pull_request` is set, treat as PR.
      if (p.issue?.pull_request) await env.JOBS.send({ type: "sync.pr", repoId, number: num });
      else await env.JOBS.send({ type: "sync.issue", repoId, number: num });
      break;
    }
    default:
      // Unhandled event — fine, ignored.
      break;
  }
}
