import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { Env } from "../lib/env";
import { appDb } from "../db/app";
import * as A from "../db/app/schema";
import { encryptString, randomId } from "../lib/crypto";
import { SESSION_COOKIE, sessionCookie } from "../lib/auth";

/**
 * GitHub OAuth (user auth) flow.
 *
 *   GET  /auth/login    → 302 to github.com/login/oauth/authorize
 *   GET  /auth/callback → exchanges code for token, creates app_user + session, sets cookie
 *   POST /auth/logout   → invalidates the session
 *
 * Note: a GitHub App can do user OAuth too — same App, separate "client secret".
 * For local-only/single-user setups, prefer putting the whole app behind Cloudflare Access
 * and skip this entirely.
 */
export const authRoutes = new Hono<{ Bindings: Env }>();

const STATE_COOKIE = "gh_oauth_state";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

authRoutes.get("/login", (c) => {
  const state = randomId(16);
  const cb = new URL(c.req.url);
  cb.pathname = "/auth/callback";
  cb.search = "";

  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", c.env.GITHUB_OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", cb.toString());
  url.searchParams.set("state", state);
  url.searchParams.set("scope", "read:user");

  c.header(
    "Set-Cookie",
    `${STATE_COOKIE}=${state}; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax`,
  );
  return c.redirect(url.toString(), 302);
});

authRoutes.get("/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const expected = readCookie(c.req.header("cookie"), STATE_COOKIE);
  if (!code || !state || state !== expected) return c.text("bad state", 400);

  // Exchange code -> token
  const tokRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: c.env.GITHUB_OAUTH_CLIENT_ID,
      client_secret: c.env.GITHUB_OAUTH_CLIENT_SECRET,
      code,
    }),
  });
  if (!tokRes.ok) return c.text("oauth exchange failed", 502);
  const tok = await tokRes.json<{ access_token?: string; scope?: string; error?: string }>();
  if (!tok.access_token) return c.text(`oauth: ${tok.error ?? "no token"}`, 502);

  // Identify user
  const meRes = await fetch("https://api.github.com/user", {
    headers: { Authorization: `token ${tok.access_token}`, "User-Agent": "githost", Accept: "application/vnd.github+json" },
  });
  if (!meRes.ok) return c.text("github /user failed", 502);
  const me = await meRes.json<{ id: number; login: string }>();

  // Upsert user, store token encrypted, create session.
  const adb = appDb(c.env.APP_DB);
  const now = new Date();
  const existing = await adb.select().from(A.appUser).where(eq(A.appUser.ghUserId, me.id)).get();
  const userId = existing?.id ?? crypto.randomUUID();
  if (!existing) {
    await adb.insert(A.appUser).values({ id: userId, ghUserId: me.id, login: me.login, createdAt: now }).run();
  }

  const enc = await encryptString(c.env.TOKEN_ENCRYPTION_KEY, tok.access_token);
  await adb.insert(A.oauthToken)
    .values({ userId, ciphertext: enc.ciphertext, iv: enc.iv, scope: tok.scope ?? null, updatedAt: now })
    .onConflictDoUpdate({
      target: A.oauthToken.userId,
      set: { ciphertext: enc.ciphertext, iv: enc.iv, scope: tok.scope ?? null, updatedAt: now },
    })
    .run();

  const sessionId = randomId(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  await adb.insert(A.userSession).values({
    id: sessionId, userId, expiresAt, createdAt: now,
    userAgent: c.req.header("user-agent") ?? null,
  }).run();

  c.header("Set-Cookie", sessionCookie(sessionId, SESSION_TTL_SECONDS));
  c.header("Set-Cookie", `${STATE_COOKIE}=; Max-Age=0; Path=/`, { append: true });
  return c.redirect("/", 302);
});

authRoutes.post("/logout", async (c) => {
  const sid = readCookie(c.req.header("cookie"), SESSION_COOKIE);
  if (sid) {
    const adb = appDb(c.env.APP_DB);
    await adb.delete(A.userSession).where(eq(A.userSession.id, sid)).run();
  }
  c.header("Set-Cookie", sessionCookie("", 0));
  return c.json({ ok: true });
});

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return undefined;
}
