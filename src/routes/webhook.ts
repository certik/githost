import { Hono } from "hono";
import type { Env, JobMessage } from "../lib/env";
import { verifyGithubSignature } from "../lib/verify-webhook";

/**
 * Receives GitHub App webhooks. Pattern:
 *   1. Read the raw body (need it for HMAC).
 *   2. Verify X-Hub-Signature-256.
 *   3. Enqueue the event for async processing and return 200 immediately.
 *      GitHub disables webhooks that consistently take >10s — never do real work here.
 */
export const webhookRoutes = new Hono<{ Bindings: Env }>();

webhookRoutes.post("/github", async (c) => {
  const raw = await c.req.arrayBuffer();
  const sig = c.req.header("x-hub-signature-256");
  const ok = await verifyGithubSignature(c.env.GITHUB_WEBHOOK_SECRET, raw, sig ?? null);
  if (!ok) return c.text("bad signature", 401);

  const event = c.req.header("x-github-event") ?? "unknown";
  const deliveryId = c.req.header("x-github-delivery") ?? crypto.randomUUID();

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return c.text("invalid json", 400);
  }

  const msg: JobMessage = { type: "github.webhook", event, deliveryId, payload };
  await c.env.JOBS.send(msg);

  return c.json({ ok: true, deliveryId });
});
