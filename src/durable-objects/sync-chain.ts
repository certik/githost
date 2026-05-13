import { DurableObject } from "cloudflare:workers";
import type { Env } from "../lib/env";
import { refreshPrsBatch, type BatchResult } from "../jobs/refresh-chain";
import { syncLog } from "../lib/sync-log";

/**
 * Durable Object that runs the resync chain as a sequence of alarm-driven
 * batches. Each alarm() invocation processes one page of upstream PRs and
 * then either schedules another alarm (for the next batch) or marks itself
 * idle.
 *
 * Why a DO and not Worker→Worker self-fetch:
 *
 *   Cloudflare blocks recursive Worker call depth at ~10 nested
 *   service-binding calls (the 11th invocation returns 500 before its
 *   handler runs). With self-fetch chaining each batch added one to the
 *   stack, so we'd cap out at ~200 PRs per refresh click.
 *
 *   DO alarms break the chain: when alarm() schedules its next firing via
 *   `setAlarm()`, that firing is a *fresh* invocation with no parent. There
 *   is no stack depth. The chain can run as many batches as it needs to
 *   (subject only to the storage state we keep here).
 *
 * Singleton: we use a single named instance ("singleton") for the whole
 * Worker — only one chain runs at a time. If /api/refresh is called while a
 * chain is already running, we no-op and let the in-flight chain finish.
 *
 * Storage keys (KV API on SQLite-backed DO):
 *   - status:     "idle" | "running" | "stopped"
 *   - page:       current upstream PR list page (1-indexed)
 *   - batches:    how many batches this chain has run
 *   - processed:  cumulative PRs synced
 *   - startedAt:  epoch ms when this chain kicked off
 *   - finishedAt: epoch ms when it last completed (only set when idle/stopped)
 *   - lastError:  last fatal error message, if any
 */

const ALARM_DELAY_MS = 500;        // gap between batches; let other requests through
const DEFAULT_MAX_BATCHES = 5;     // sane default — covers normal webhook drift
const HARD_MAX_BATCHES = 200;      // absolute ceiling regardless of caller request

export class SyncChain extends DurableObject<Env> {
  /**
   * HTTP entry point. Called via `env.SYNC_CHAIN.get(id).fetch(...)`. We
   * route by URL path so the binding-call sites don't need to know about
   * DO method names.
   */
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    switch (url.pathname) {
      case "/start":  return this.handleStart(req);
      case "/status": return this.handleStatus();
      case "/reset":  return this.handleReset();
      default:        return new Response("not found", { status: 404 });
    }
  }

  private async handleStart(req: Request): Promise<Response> {
    const status = (await this.ctx.storage.get<string>("status")) ?? "idle";
    if (status === "running") {
      const page = await this.ctx.storage.get<number>("page");
      const batches = await this.ctx.storage.get<number>("batches");
      const maxBatches = await this.ctx.storage.get<number>("maxBatches");
      return Response.json({ ok: true, alreadyRunning: true, page, batches, maxBatches });
    }

    // Caller can request a higher (or lower) batch cap. We clamp to
    // [1, HARD_MAX_BATCHES] so a buggy caller can't make us run forever.
    let requestedMax: number | undefined;
    try {
      const body = await req.json<{ maxBatches?: number }>();
      requestedMax = typeof body?.maxBatches === "number" ? body.maxBatches : undefined;
    } catch { /* no body / non-JSON is fine */ }
    const maxBatches = Math.min(HARD_MAX_BATCHES, Math.max(1, requestedMax ?? DEFAULT_MAX_BATCHES));

    await this.ctx.storage.put({
      status: "running",
      page: 1,
      batches: 0,
      processed: 0,
      maxBatches,
      startedAt: Date.now(),
      finishedAt: null,
      lastError: null,
    });
    // Fire the first alarm a few ms out so this response can return promptly.
    await this.ctx.storage.setAlarm(Date.now() + 50);
    return Response.json({ ok: true, scheduled: true, maxBatches });
  }

  private async handleStatus(): Promise<Response> {
    const status = await this.ctx.storage.get<string>("status") ?? "idle";
    const page = await this.ctx.storage.get<number>("page") ?? null;
    const batches = await this.ctx.storage.get<number>("batches") ?? 0;
    const processed = await this.ctx.storage.get<number>("processed") ?? 0;
    const maxBatches = await this.ctx.storage.get<number>("maxBatches") ?? DEFAULT_MAX_BATCHES;
    const startedAt = await this.ctx.storage.get<number>("startedAt") ?? null;
    const finishedAt = await this.ctx.storage.get<number>("finishedAt") ?? null;
    const lastError = await this.ctx.storage.get<string | null>("lastError") ?? null;
    return Response.json({ status, page, batches, processed, maxBatches, startedAt, finishedAt, lastError });
  }

  /** Admin escape hatch — wipes state. Lets us recover from a stuck DO. */
  private async handleReset(): Promise<Response> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    await syncLog(this.env, "warn", "sync.chain.reset", "DO state wiped via /reset", {});
    return Response.json({ ok: true });
  }

  /**
   * Called by the runtime when our scheduled alarm fires. This is a *fresh*
   * Worker invocation — no parent, no stack depth. We run one batch and
   * either schedule the next alarm or mark ourselves idle.
   */
  async alarm(): Promise<void> {
    const page = (await this.ctx.storage.get<number>("page")) ?? 1;
    const batches = (await this.ctx.storage.get<number>("batches")) ?? 0;
    const processed = (await this.ctx.storage.get<number>("processed")) ?? 0;
    const maxBatches = (await this.ctx.storage.get<number>("maxBatches")) ?? DEFAULT_MAX_BATCHES;

    if (batches >= maxBatches) {
      await this.ctx.storage.put({
        status: "idle",
        finishedAt: Date.now(),
      });
      await syncLog(this.env, "info", "sync.chain.cap-reached",
        `batch cap reached at ${batches} batches (limit=${maxBatches})`,
        { batches, page, maxBatches });
      return;
    }

    let result: BatchResult;
    try {
      result = await refreshPrsBatch(this.env, page);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.ctx.storage.put({
        status: "stopped",
        finishedAt: Date.now(),
        lastError: message,
      });
      await syncLog(this.env, "error", "sync.batch.error",
        `page ${page}: ${message}`, {
          page, batches, stack: err instanceof Error ? err.stack : undefined,
        });
      return;
    }

    const newBatches = batches + 1;
    const newProcessed = processed + result.processed;

    await syncLog(this.env, result.failed > 0 ? "warn" : "info", "sync.batch.done",
      `page=${page} batches=${newBatches} scanned=${result.scanned} processed=${result.processed} skipped=${result.skipped} failed=${result.failed} reason=${result.reason}`,
      { ...result, batches: newBatches, totalProcessed: newProcessed } as Record<string, unknown>,
    );

    if (result.hasMore) {
      const nextPage = result.reason === "page-not-drained" ? page : page + 1;
      await this.ctx.storage.put({
        page: nextPage,
        batches: newBatches,
        processed: newProcessed,
      });
      await this.ctx.storage.setAlarm(Date.now() + ALARM_DELAY_MS);
    } else {
      await this.ctx.storage.put({
        status: "idle",
        page: page,
        batches: newBatches,
        processed: newProcessed,
        finishedAt: Date.now(),
      });
      await syncLog(this.env, "info", "sync.chain.done",
        `chain complete: ${newBatches} batches, ${newProcessed} PRs synced (reason=${result.reason})`,
        { batches: newBatches, processed: newProcessed, reason: result.reason });
    }
  }
}

/**
 * Helper: get the singleton DO stub. Used by the API layer so call sites
 * don't repeat the id.idFromName / get dance.
 */
export function getSyncChainStub(env: Env): DurableObjectStub {
  const id = env.SYNC_CHAIN.idFromName("singleton");
  return env.SYNC_CHAIN.get(id);
}
