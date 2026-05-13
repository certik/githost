import type { Context, MiddlewareHandler } from "hono";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Env } from "./env";
import { appDb } from "../db/app";
import * as A from "../db/app/schema";

export const SESSION_COOKIE = "gh_session";

export interface AuthUser {
  id: string;          // app_user.id (UUID)
  ghUserId: number;
  login: string;
}

/**
 * Look up the current user from the `gh_session` cookie. Returns null if there's
 * no cookie, the session doesn't exist, or the session has expired.
 *
 * Caches the lookup on the Hono context so multiple middleware/handler reads
 * inside a single request only hit D1 once.
 */
export async function loadSession(c: Context<{ Bindings: Env }>): Promise<AuthUser | null> {
  const cached = c.get("user" as never) as AuthUser | undefined;
  if (cached !== undefined) return cached;

  const sid = readCookie(c.req.header("cookie"), SESSION_COOKIE);
  if (!sid) {
    c.set("user" as never, null as never);
    return null;
  }

  const adb = appDb(c.env.APP_DB);
  const row = await adb
    .select({
      id: A.appUser.id,
      ghUserId: A.appUser.ghUserId,
      login: A.appUser.login,
    })
    .from(A.userSession)
    .innerJoin(A.appUser, eq(A.appUser.id, A.userSession.userId))
    .where(and(eq(A.userSession.id, sid), gt(A.userSession.expiresAt, new Date())))
    .get();

  const user = row ?? null;
  c.set("user" as never, user as never);
  return user;
}

/**
 * Hono middleware: 401 if there's no valid session. Use on routes that mutate
 * state or act on the user's behalf against GitHub.
 */
export const requireSession: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const user = await loadSession(c);
  if (!user) return c.json({ error: "authentication required" }, 401);
  await next();
};

/**
 * Fetch the user from the context after `requireSession` has run. Type-narrowed:
 * if `requireSession` was in the chain, this is non-null.
 */
export function currentUser(c: Context<{ Bindings: Env }>): AuthUser {
  const u = c.get("user" as never) as AuthUser | null | undefined;
  if (!u) throw new Error("currentUser called without requireSession");
  return u;
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return undefined;
}

/**
 * Helper used by routes/auth.ts to issue a Set-Cookie. Centralized so
 * options stay consistent across login + logout.
 */
export function sessionCookie(value: string, maxAgeSeconds: number): string {
  const parts = [`${SESSION_COOKIE}=${value}`];
  parts.push(`Max-Age=${maxAgeSeconds}`);
  parts.push("Path=/");
  parts.push("HttpOnly");
  parts.push("Secure");
  parts.push("SameSite=Lax");
  return parts.join("; ");
}
