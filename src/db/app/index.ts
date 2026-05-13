import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function appDb(d1: D1Database) {
  return drizzle(d1, { schema, casing: "snake_case" });
}

export type AppDb = ReturnType<typeof appDb>;
export * as app from "./schema";
