/**
 * Per-file setup: apply migrations to both D1 databases, and wire up the
 * shared MSW server for outbound-HTTP mocking.
 *
 * - `applyD1Migrations` is idempotent (tracks applied migrations in the
 *   `d1_migrations` table) so it's safe to run on every file.
 * - MSW is started once per test file with `onUnhandledRequest: "error"`,
 *   so any outbound fetch from worker code that isn't explicitly mocked
 *   in the test fails loudly.
 * - Per-test handlers added via `server.use(...)` are reset after each test.
 */
import { applyD1Migrations, env } from "cloudflare:test";
import { afterAll, afterEach, beforeAll } from "vitest";
import { mswServer } from "./msw-server";

await applyD1Migrations(env.MIRROR_DB, env.TEST_MIRROR_MIGRATIONS);
await applyD1Migrations(env.APP_DB, env.TEST_APP_MIGRATIONS);

beforeAll(() => mswServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());
