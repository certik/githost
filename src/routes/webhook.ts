import { Hono } from "hono";
import type { Env, JobMessage } from "../lib/env";
import { verifyGithubSignature } from "../lib/verify-webhook";
import { runJob, runJobAwait } from "../jobs/consumer";
import { syncLog } from "../lib/sync-log";

/**
 * Receives GitHub App webhooks. Pattern:
 *   1. Read the raw body (need it for HMAC).
 *   2. Verify X-Hub-Signature-256.
 *   3. Log the delivery (event, action, delivery_id, PR/issue number)
 *      to sync_log so we have a paper trail at /logs.
 *   4. For PR / issue events, AWAIT the sync inline so the D1 commit
 *      happens before we return 200. ctx.waitUntil has been observed
 *      to get cancelled mid-flight on Workers Free (the same bug that
 *      bit /api/refresh originally) — awaiting eliminates that risk.
 *      GitHub disables webhooks consistently exceeding 10s; a single
 *      syncPr is 1-2s so we have plenty of margin.
 *   5. For CI events (check_run / workflow_run) which can fan out to
 *      multiple PR syncs and fire many times during a CI run, keep
 *      fire-and-forget — losing the occasional CI status update is
 *      survivable (Manual Refresh recovers), and we don't want to risk
 *      blowing GitHub's 10s timeout on a workflow_run that touches 5+
 *      PRs at once.
 */
export const webhookRoutes = new Hono<{ Bindings: Env }>();

webhookRoutes.post("/github", async (c) => {
  const raw = await c.req.arrayBuffer();
  const sig = c.req.header("x-hub-signature-256");
  const ok = await verifyGithubSignature(c.env.GITHUB_WEBHOOK_SECRET, raw, sig ?? null);
  if (!ok) {
    await syncLog(c.env, "warn", "webhook.bad-signature", "rejected webhook with bad signature", {
      event: c.req.header("x-github-event") ?? null,
      deliveryId: c.req.header("x-github-delivery") ?? null,
    });
    return c.text("bad signature", 401);
  }

  const event = c.req.header("x-github-event") ?? "unknown";
  const deliveryId = c.req.header("x-github-delivery") ?? crypto.randomUUID();

  let payload: any;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return c.text("invalid json", 400);
  }

  // Defensive repo filter. The App may be installed on multiple repos (e.g.
  // certik/githost for self-CI), but we only mirror env.UPSTREAM_OWNER/REPO.
  // Ignoring foreign events prevents accidental cross-repo data corruption
  // (syncPr always fetches from UPSTREAM, so a foreign-repo PR number would
  // hit the wrong row in our mirror).
  const repoFullName = payload?.repository?.full_name ?? null;
  const expectedRepo = `${c.env.UPSTREAM_OWNER}/${c.env.UPSTREAM_REPO}`;
  if (repoFullName && repoFullName !== expectedRepo) {
    await syncLog(c.env, "info", "webhook.ignored-foreign-repo",
      `ignoring event=${event} from repo=${repoFullName} (expected ${expectedRepo})`, {
        event, deliveryId, repo: repoFullName, expected: expectedRepo,
      });
    return c.json({ ok: true, ignored: "foreign-repo", repo: repoFullName });
  }

  // Log every accepted delivery so we can correlate observed UI behavior
  // with what GitHub actually sent (visible at /logs).
  const action = payload?.action ?? null;
  const prNumber = payload?.pull_request?.number ?? payload?.issue?.number ?? null;
  await syncLog(c.env, "info", "webhook.received",
    `event=${event} action=${action ?? "n/a"}${prNumber ? ` pr/issue=#${prNumber}` : ""} repo=${repoFullName ?? "?"}`, {
      event, action, deliveryId,
      prNumber,
      repo: repoFullName,
      merged: payload?.pull_request?.merged ?? null,
      state: payload?.pull_request?.state ?? payload?.issue?.state ?? null,
    });

  // PR + issue events are awaited inline so the D1 upsert is committed
  // before we 200 GitHub. CI events stay async to keep response times
  // bounded for fan-outs.
  if (event === "pull_request" || event === "pull_request_review" || event === "pull_request_review_comment"
      || event === "issues" || event === "issue_comment") {
    try {
      const msg: JobMessage = { type: "github.webhook", event, deliveryId, payload };
      await runJobAwait(msg, c.env, c.executionCtx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await syncLog(c.env, "error", "webhook.failed",
        `event=${event} delivery=${deliveryId}: ${message}`, {
          event, action, deliveryId, prNumber,
          stack: err instanceof Error ? err.stack : undefined,
        });
      // Returning 500 makes GitHub retry the delivery — which is what we want.
      return c.json({ ok: false, error: message }, 500);
    }
    return c.json({ ok: true, deliveryId });
  }

  // CI events: stay fire-and-forget. waitUntil best-effort; if it gets
  // cancelled the worst case is a stale CI status until the next webhook.
  const msg: JobMessage = { type: "github.webhook", event, deliveryId, payload };
  runJob(msg, c.env, c.executionCtx);
  return c.json({ ok: true, deliveryId });
});
