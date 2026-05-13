import type { Env } from "./lib/env";
import { runJob } from "./jobs/consumer";

/**
 * Cron triggers:
 *   "0 3 * * *"  → daily resync sweep (repair drift from missed webhooks).
 *
 * Backups are performed by a GitHub Actions workflow (`wrangler d1 export`),
 * not by the Worker — see `.github/workflows/backup.yml` (added once CI is set
 * up). This keeps the free plan working without R2.
 */
export async function handleScheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
  if (event.cron === "0 3 * * *") {
    runJob({ type: "sync.full", resource: "prs" }, env, ctx);
    runJob({ type: "sync.full", resource: "issues" }, env, ctx);
    runJob({ type: "sync.full", resource: "comments" }, env, ctx);
  }
}
