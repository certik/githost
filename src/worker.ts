import { Hono } from "hono";
import type { Env } from "./lib/env";
import { webhookRoutes } from "./routes/webhook";
import { apiRoutes } from "./routes/api";
import { authRoutes } from "./routes/auth";
import { handleScheduled } from "./scheduled";

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", (c) => c.json({ ok: true, ts: new Date().toISOString() }));

app.route("/webhook", webhookRoutes);
app.route("/api", apiRoutes);
app.route("/auth", authRoutes);

// SPA fallback: any non-API route that doesn't match a static asset gets index.html.
// (With `not_found_handling = "single-page-application"` in wrangler.toml, the Assets
// binding handles client-side routes by serving index.html.)
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    await handleScheduled(event, env, ctx);
  },
};
