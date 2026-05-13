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

  // Allowlist check — only permit logins enumerated in ALLOWED_GITHUB_LOGINS.
  // Empty/missing var means "no one"; an explicit "*" means "anyone" (not
  // recommended for production).
  const allowed = (c.env.ALLOWED_GITHUB_LOGINS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const isAllowed = allowed.includes("*") || allowed.includes(me.login.toLowerCase());
  if (!isAllowed) {
    return c.html(
      `<!doctype html>
<html><head><meta charset="utf-8"><title>Access denied</title></head>
<body style="font-family: system-ui, sans-serif; padding: 2rem; max-width: 600px; margin: auto; color: #111;">
  <h1 style="color: #b91c1c;">Access denied</h1>
  <p>Your GitHub account <strong>@${me.login}</strong> is not authorized to use this instance.</p>
  <p>If you think this is a mistake, contact the administrator and ask them to add your login to <code>ALLOWED_GITHUB_LOGINS</code>.</p>
  <p><a href="https://github.com/settings/applications">Revoke this app's access to your GitHub account</a></p>
</body></html>`,
      403,
    );
  }

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

/**
 * Static "signed out" splash page. Served as a regular Worker HTML response —
 * not part of the SPA — so logging out can drop the React tree (and its
 * cached PR data) without forcing the user through the GitHub OAuth round-trip
 * just to confirm they're signed out.
 *
 * Lives under /auth/* so it's reachable anonymously (the worker gate exempts
 * /auth/*).
 */
authRoutes.get("/signed-out", (c) => {
  return c.html(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Signed out — githost</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; padding: 4rem 2rem; max-width: 480px; margin: auto; color: #18181b; background: #fafafa; }
    h1 { font-size: 1.5rem; margin: 0 0 0.5rem; }
    p { color: #52525b; margin: 0 0 2rem; }
    a.btn { display: inline-block; padding: 0.5rem 1rem; background: #18181b; color: white; text-decoration: none; border-radius: 0.375rem; font-size: 0.9rem; }
    a.btn:hover { background: #27272a; }
  </style>
</head>
<body>
  <h1>You're signed out</h1>
  <p>Your session has ended. Click below to sign in again.</p>
  <a class="btn" href="/auth/login">Sign in with GitHub</a>
</body>
</html>`);
});

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return undefined;
}
