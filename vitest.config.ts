import path from "node:path";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

/**
 * Vitest configured to run inside the Cloudflare Workers runtime via
 * `@cloudflare/vitest-pool-workers`. Each test file boots a real workerd
 * instance with the bindings from `wrangler.toml` (MIRROR_DB, APP_DB, KV, …).
 *
 * Migrations: `readD1Migrations()` loads our SQL files at config time and
 * binds them as `TEST_MIRROR_MIGRATIONS` / `TEST_APP_MIGRATIONS`. A setup
 * file (`test/setup.ts`) calls `applyD1Migrations()` once per file, so each
 * test starts with the schema applied and (per Vitest pool isolation) its
 * own isolated D1 state.
 */
export default defineConfig(async () => {
  const mirrorMigrations = await readD1Migrations(path.join(__dirname, "migrations/mirror"));
  const appMigrations = await readD1Migrations(path.join(__dirname, "migrations/app"));

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            TEST_MIRROR_MIGRATIONS: mirrorMigrations,
            TEST_APP_MIGRATIONS: appMigrations,
            GITHUB_APP_ID: "1",
            GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----",
            GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
            GITHUB_OAUTH_CLIENT_ID: "test-client-id",
            GITHUB_OAUTH_CLIENT_SECRET: "test-client-secret",
            SESSION_SECRET: "dGVzdC1zZXNzaW9uLXNlY3JldC1jaGFuZ2UtbWUtcGxlYXNlLi4uLi4=",
            // 32 bytes of 0x42, base64-encoded. Must be exactly 32 bytes when
            // decoded (AES-GCM 256-bit key); the production secret is rotated
            // separately via `wrangler secret put`.
            TOKEN_ENCRYPTION_KEY: "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=",
            ALLOWED_GITHUB_LOGINS: "alice,bob",
            UPSTREAM_OWNER: "testorg",
            UPSTREAM_REPO: "testrepo",
            GITHUB_INSTALLATION_ID: "1",
            // Force off by default. The tests for /auth/dev-login that need
            // it enabled pass an env override into worker.fetch directly.
            DEV_LOGIN_ENABLED: "",
          },
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/setup.ts"],
    },
  };
});
