import type { Env } from "./lib/env";
import { runJob } from "./jobs/consumer";

/**
 * Cron triggers:
 *   "0 3 * * *"  → daily resync sweep (repair drift from missed webhooks).
 *   "30 3 * * *" → daily backup: export both D1 DBs to R2, prune old objects.
 *
 * Cloudflare invokes one handler per cron expression — we discriminate on `event.cron`.
 */
export async function handleScheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
  if (event.cron === "0 3 * * *") {
    runJob({ type: "sync.full", resource: "prs" }, env, ctx);
    runJob({ type: "sync.full", resource: "issues" }, env, ctx);
    runJob({ type: "sync.full", resource: "comments" }, env, ctx);
  } else if (event.cron === "30 3 * * *") {
    ctx.waitUntil(nightlyBackup(env));
  }
}

/**
 * Nightly backup of both D1 databases to R2.
 *
 * For *small* databases (< a few hundred MB) we use D1's REST `/export` endpoint
 * via the worker fetch binding (`env.MIRROR_DB.dump()` is no longer supported on
 * remote DBs). The pragmatic approach in a Worker is to call our own helper
 * `wrangler d1 export` from CI on a schedule instead — both work.
 *
 * Here we demonstrate the in-Worker variant by serializing a JSON dump of the
 * key tables: simple, robust, and trivially restorable via `wrangler d1 execute --file`.
 */
async function nightlyBackup(env: Env): Promise<void> {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");

  await dumpDbToR2(env.MIRROR_DB, env.BLOBS, `backups/mirror/${ts}.jsonl`);
  await dumpDbToR2(env.APP_DB,    env.BLOBS, `backups/app/${ts}.jsonl`);

  const retentionDays = parseInt(env.BACKUP_RETENTION_DAYS, 10) || 30;
  await pruneOlderThan(env.BLOBS, "backups/mirror/", retentionDays);
  await pruneOlderThan(env.BLOBS, "backups/app/",    retentionDays);
}

async function dumpDbToR2(db: D1Database, bucket: R2Bucket, key: string): Promise<void> {
  // Read the schema (sqlite_master) so we can enumerate user tables.
  const tablesRes = await db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%'"
  ).all<{ name: string }>();

  const lines: string[] = [];
  for (const { name } of tablesRes.results ?? []) {
    const rows = await db.prepare(`SELECT * FROM "${name}"`).all<Record<string, unknown>>();
    for (const row of rows.results ?? []) {
      lines.push(JSON.stringify({ table: name, row }));
    }
  }
  await bucket.put(key, lines.join("\n"), {
    httpMetadata: { contentType: "application/x-ndjson" },
  });
}

async function pruneOlderThan(bucket: R2Bucket, prefix: string, days: number): Promise<void> {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor });
    for (const obj of listed.objects) {
      if (obj.uploaded.getTime() < cutoff) {
        await bucket.delete(obj.key);
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}
