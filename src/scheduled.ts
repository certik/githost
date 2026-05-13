import type { Env } from "./lib/env";

/**
 * Cron handler. Currently DISABLED — `wrangler.toml` has no `crons` set, so
 * this is never invoked in production. Kept as a stub so re-enabling later
 * (e.g. a backstop resync trigger) is a one-line change in wrangler.toml.
 *
 * Rationale: while we're hardening webhook + manual-refresh reliability, a
 * cron would silently paper over missed webhooks and hide bugs. Once the
 * core path is rock-solid we can add cron as belt-and-suspenders.
 */
export async function handleScheduled(_event: ScheduledEvent, _env: Env, _ctx: ExecutionContext): Promise<void> {
  // intentionally empty
}
