/**
 * Test-time bindings declared in vitest.config.ts. Augments the Cloudflare:test
 * Env so `env.TEST_MIRROR_MIGRATIONS` etc. are typed.
 */
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    TEST_MIRROR_MIGRATIONS: import("cloudflare:test").D1Migration[];
    TEST_APP_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
