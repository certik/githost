import type { Config } from "drizzle-kit";

export default {
  schema: "./src/db/mirror/schema.ts",
  out: "./migrations/mirror",
  dialect: "sqlite",
  driver: "d1-http",
  casing: "snake_case",
} satisfies Config;
