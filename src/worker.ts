import { Hono } from "hono";
import type { Env } from "./lib/env";
import { webhookRoutes } from "./routes/webhook";
import { apiRoutes } from "./routes/api";
import { authRoutes } from "./routes/auth";
import { handleScheduled } from "./scheduled";
import { loadSession } from "./lib/auth";

// DO class export — required for the runtime to instantiate the binding
// declared in wrangler.toml.
export { SyncChain } from "./durable-objects/sync-chain";

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", (c) => c.json({ ok: true, ts: new Date().toISOString() }));

app.route("/webhook", webhookRoutes);
app.route("/api", apiRoutes);
app.route("/auth", authRoutes);

/**
 * Catch-all: serve the SPA's static assets. Private-mode gate lives here.
 *
 * Behavior:
 *   - Anything under /auth/* or /healthz is exempt (the login flow itself must
 *     be reachable to an unauthenticated user). These are handled by their
 *     own routes above; reaching the catch-all means they didn't match.
 *   - For any other path, require a valid session. If missing:
 *       * HTML / document navigations  → 302 to /auth/login
 *       * Everything else (XHR/fetch, asset requests) → 401 JSON
 *   - With `run_worker_first = true` set in wrangler.toml the Worker runs for
 *     every request, so this gate covers the SPA's HTML AND its JS/CSS assets.
 *     That's intentional: we don't want unauthenticated users to even see the
 *     SPA's source/structure.
 */
app.all("*", async (c) => {
  const user = await loadSession(c);
  if (!user) {
    const accept = c.req.header("accept") ?? "";
    const dest = c.req.header("sec-fetch-dest") ?? "";
    const isDocumentNav = dest === "document" || accept.includes("text/html");
    if (isDocumentNav) return c.redirect("/auth/login", 302);
    return c.json({ error: "authentication required" }, 401);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    await handleScheduled(event, env, ctx);
  },
};
