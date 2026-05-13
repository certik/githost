import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function mirrorDb(d1: D1Database) {
  return drizzle(d1, { schema, casing: "snake_case" });
}

export type MirrorDb = ReturnType<typeof mirrorDb>;
export * as mirror from "./schema";
