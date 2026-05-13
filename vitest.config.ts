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
            // A real (test-only) RSA 2048 PKCS#8 private key. The github-app
            // helper signs a JWT with this before exchanging it for an
            // installation token; with an invalid key, the JWT step throws
            // before MSW gets a chance to intercept the token-exchange request.
            // This key is committed to a test config — it's never used to
            // authenticate against real GitHub.
            GITHUB_APP_PRIVATE_KEY:
              "-----BEGIN PRIVATE KEY-----\n" +
              "MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQDtSrW8dTuAmgN+\n" +
              "9woMxdvASqpvTmWfUvn4euaAZW+A/G/a+qq+BQQTGvh+8t7OVg8FKNLyJdRdw8lU\n" +
              "jrZGIHJSGlfU8UHOiS3VXnwex7yIYEm+pNYlMKroNwOxBSds+yyTkKLZ1y/A0PSK\n" +
              "5OUm/wjC0QWg1lEIcpPCeT6xGCFLNRTdRNzNSydV7xzUJRw44AbNl2yLt8ta0F1v\n" +
              "bLfDpLrUxquC5Kldqf1w/0t076tdn5BUdRBFUhFiYVnCoaJBUSTPLNr1XbP+bb9A\n" +
              "SBbAe6ucXH4EwrBic7hmIR2ECc9gyH/Lp9w9zsnAlY/6IwyfxBc89PLMF/IUik6Q\n" +
              "FKzGoAdLAgMBAAECggEAWRwcQWh47uNneq+E26UV0BF6DZCQQxOjAbgNhZwSEos5\n" +
              "6i8GHZO+ovoW5X2JRE03GMXq6bphFNEocxOgyZb3t3NjFnl/L/N9/cmcrOZvG3ul\n" +
              "Ve2K6a5sEAZQ4ZJA6wEsDUJclZfku/D8VIh+sXVGsfpStcKl7Zkxee+UJmccYaQV\n" +
              "U2SUcvPB391gdvj3f7BdB03YPVbfCyt25Qb2sJ8ObA9jrOObBAftlt08otA5gJpa\n" +
              "VTNAL1/yLTmy3LWoH52ySi+N+pNMJbkTfulJjdx+qqSritcGpYa06TmYQj+lBcDI\n" +
              "RJMJEPcIrxg3xLDWICqy77EF42wz6SdBtrkrXX5SMQKBgQD2ovXM0zZtbJT71+Ez\n" +
              "axC5zl7NmDafYhtebDJJiTuPjs0jJc1FHkhZAsa7/jlGu9brMYHlMXWWNaXxfupu\n" +
              "oXEfmLoDHq9ejJSgo+0CsAF2mIhcbL6nTBSgDqh02JMNZY26EwOgW1GfLDYZ5rfG\n" +
              "HjBrcjvj0V2EWBVix+5JuC2Q8wKBgQD2TO3b1laKYQXULKvHAwxCMWFWqAm5KnQr\n" +
              "zus2h9L0lu8vghPTIpb0rC/EAMHE+cjyh+zMX2NDO1ZqL0Kb6SB1+FHovYFxN6sR\n" +
              "e9eCymD3eeWFbOzljy9wjNPbdrJA5pApM2v+riKnLpopCmpHW+yIc+YnqIrQ310U\n" +
              "0+e+/dQGSQKBgQDp9EVDyWsMu35Ls0l9c+dGydsmHWhbIj4iAHJnTRVBpU00NQyV\n" +
              "rxcj0D1iYNJGJbLGIY09MwB+v18tSJ3q2ZusRDzW7smd366w/y65aOnKbQCU49aq\n" +
              "bcH23lCvni1H/PhG9PhwqY8wdUjQownalhKKKa9j+NtDyiZnMI36Qgp/PwKBgQCA\n" +
              "cJ2ZhqyafP4NJz5tCana2uVnyzlG1ly+e6ktRqc75XnVzH+KGv+dmC1QiRSDI78m\n" +
              "urtB2HxrEwZ9WSfjJi9HVbdhJ3HZGK6c73fzPJZUd7y5V5QyIfkbOFVCnSNXtOR4\n" +
              "l9g5d5WamTLLNCM4EzfF8KqVA89gHRrtQZQYhUWMAQKBgQC8dBPFsiEm2Gb5NAxU\n" +
              "vunJyMIjqbdHOjJMa3zDQdR1nr5OoNyg2kTqubILkAqi1DY/arJOCBHssmfhgLr5\n" +
              "wbGHZq19s7eO28DGeZzcaRKFjfiMPKGSJxgW8APYcmioTH/MnwMChBABIqe8bvQI\n" +
              "+ZBU6Tw+37cZG0I5gKnF1+4LKA==\n" +
              "-----END PRIVATE KEY-----\n",
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
          // SyncChain DO binding for refresh tests. Miniflare auto-discovers
          // the class via the script entry, so we just declare the namespace.
          durableObjects: {
            SYNC_CHAIN: { className: "SyncChain" },
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
