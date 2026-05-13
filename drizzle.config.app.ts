import type { Config } from "drizzle-kit";

export default {
  schema: "./src/db/app/schema.ts",
  out: "./migrations/app",
  dialect: "sqlite",
  driver: "d1-http",
  casing: "snake_case",
} satisfies Config;
