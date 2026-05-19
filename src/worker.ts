import { Hono } from "hono";
import type { Env } from "./lib/env";
import { webhookRoutes } from "./routes/webhook";
import { apiRoutes } from "./routes/api";
import { authRoutes } from "./routes/auth";
import { handleScheduled } from "./scheduled";

// DO class export — required for the runtime to instantiate the binding
// declared in wrangler.toml.
export { SyncChain } from "./durable-objects/sync-chain";

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", (c) => c.json({ ok: true, ts: new Date().toISOString() }));

app.route("/webhook", webhookRoutes);
app.route("/api", apiRoutes);
app.route("/auth", authRoutes);

/**
 * Catch-all: serve the SPA's static assets. The front page is intentionally
 * public — anyone can load index.html plus its JS/CSS bundle and see the
 * top-N PR list rendered from `GET /api/prs` (anonymous-readable, see
 * `routes/api.ts`). The SPA itself decides what to render based on
 * `GET /api/me`, and the SPA's interactive paths (PR detail, diff, refresh,
 * logs, post-review, branches) all hit endpoints that still require a
 * session, so anonymous users get the read-only landing experience.
 */
app.all("*", async (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    await handleScheduled(event, env, ctx);
  },
};
