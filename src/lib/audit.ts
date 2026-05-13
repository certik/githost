import { sql } from "drizzle-orm";
import type { AppDb } from "../db/app";
import * as A from "../db/app/schema";

/**
 * Audit-logged writes against the app DB.
 *
 * Every mutation captures (table, row_id, op, before_json, after_json, actor, ts)
 * into `audit_log`. We use this to:
 *   - reconstruct deleted/edited rows (soft-delete is the *primary* protection;
 *     audit_log lets us undo true updates too).
 *   - answer "who changed X and when?" queries.
 *   - feed an audit UI later (`GET /api/audit?table=ai_review&row_id=...`).
 *
 * Pattern: wrap inserts/updates/soft-deletes through these helpers instead of
 * calling Drizzle's `.insert()/.update()/.delete()` directly on app-DB tables.
 * (Reads stay on the regular Drizzle API.)
 */

type Actor = string; // app_user.id, "system", "bot:<app-id>"

/** Generic insert into an app-DB table, with audit log row appended. */
export async function appInsert<R extends { id: string | number }>(
  adb: AppDb,
  table: any,
  tableName: string,
  row: R,
  actor: Actor,
): Promise<R> {
  await adb.insert(table).values(row as any).run();
  await adb.insert(A.auditLog).values({
    id: crypto.randomUUID(),
    actor,
    tableName,
    rowId: String((row as any).id),
    op: "insert",
    beforeJson: null,
    afterJson: JSON.stringify(row),
    ts: new Date(),
  }).run();
  return row;
}

/**
 * Update by primary key, audit-logged. Reads the row before & after; the audit
 * row captures the full before/after state for reconstruction.
 */
export async function appUpdate<T extends Record<string, unknown>>(
  adb: AppDb,
  table: any,
  tableName: string,
  pkColumn: any,
  pkValue: string | number,
  patch: T,
  actor: Actor,
): Promise<void> {
  const before = await adb.select().from(table).where(sql`${pkColumn} = ${pkValue}`).get();
  await adb.update(table).set(patch as any).where(sql`${pkColumn} = ${pkValue}`).run();
  const after = await adb.select().from(table).where(sql`${pkColumn} = ${pkValue}`).get();

  await adb.insert(A.auditLog).values({
    id: crypto.randomUUID(),
    actor,
    tableName,
    rowId: String(pkValue),
    op: "update",
    beforeJson: before ? JSON.stringify(before) : null,
    afterJson: after ? JSON.stringify(after) : null,
    ts: new Date(),
  }).run();
}

/**
 * Soft-delete by primary key (sets `deleted_at`), audit-logged.
 * The table must have a `deleted_at` column.
 */
export async function appSoftDelete(
  adb: AppDb,
  table: any,
  tableName: string,
  pkColumn: any,
  pkValue: string | number,
  actor: Actor,
): Promise<void> {
  const before = await adb.select().from(table).where(sql`${pkColumn} = ${pkValue}`).get();
  if (!before) return;
  await adb.update(table)
    .set({ deletedAt: new Date() } as any)
    .where(sql`${pkColumn} = ${pkValue}`)
    .run();

  await adb.insert(A.auditLog).values({
    id: crypto.randomUUID(),
    actor,
    tableName,
    rowId: String(pkValue),
    op: "delete",
    beforeJson: JSON.stringify(before),
    afterJson: null,
    ts: new Date(),
  }).run();
}
