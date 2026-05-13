import type { Env } from "./env";
import { appDb } from "../db/app";
import * as A from "../db/app/schema";
import { sql } from "drizzle-orm";

/**
 * Append-only operational log shared by the resync chain + cron + webhook
 * handlers. Surfaces in the UI at /logs so we can spot missed webhooks and
 * sync failures without `wrangler tail`.
 *
 * Retention: the table is capped at LOG_RETENTION_ROWS by a probabilistic
 * prune on every write (1-in-N chance) to keep the steady-state write cost
 * to one INSERT per log call.
 */

export type LogLevel = "info" | "warn" | "error";

const LOG_RETENTION_ROWS = 1000;
const PRUNE_PROBABILITY = 0.02;             // ~1 prune per ~50 writes

export async function syncLog(
  env: Env,
  level: LogLevel,
  event: string,
  message: string,
  context?: Record<string, unknown>,
): Promise<void> {
  try {
    const db = appDb(env.APP_DB);
    await db.insert(A.syncLog).values({
      ts: new Date(),
      level,
      event,
      message,
      context: context ? JSON.stringify(context) : null,
    }).run();

    // Mirror to console for `wrangler tail`. Errors go to console.error so
    // they're visibly highlighted; everything else to console.log.
    const out = level === "error" ? console.error : console.log;
    out(`[sync ${level}] ${event}: ${message}`, context ?? "");

    if (Math.random() < PRUNE_PROBABILITY) {
      // Keep at most LOG_RETENTION_ROWS rows; delete the oldest.
      await db.run(sql`
        DELETE FROM sync_log
        WHERE id IN (
          SELECT id FROM sync_log
          ORDER BY ts DESC
          LIMIT -1 OFFSET ${LOG_RETENTION_ROWS}
        )
      `);
    }
  } catch (err) {
    // Logging must never throw — it's diagnostic. Fall back to console.
    console.error("[sync-log] failed to write log row", err, { level, event, message });
  }
}
