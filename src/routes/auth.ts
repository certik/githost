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
/** Set by GET /auth/cli-device when production OAuth is needed. */
const CLI_USER_CODE_COOKIE = "gh_cli_user_code";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

function cookiePair(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

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

  c.header("Set-Cookie", cookiePair(STATE_COOKIE, state, 600));
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
  c.header("Set-Cookie", cookiePair(STATE_COOKIE, "", 0), { append: true });

  // CLI device-code login: authorize the pending device after GitHub OAuth.
  const cliUserCode = readCookie(c.req.header("cookie"), CLI_USER_CODE_COOKIE);
  if (cliUserCode) {
    c.header("Set-Cookie", cookiePair(CLI_USER_CODE_COOKIE, "", 0), { append: true });
    const deviceCode = await c.env.DIFF_CACHE.get(`cli-usr:${cliUserCode.toUpperCase()}`);
    if (deviceCode) {
      const pending = await loadDevice(c.env, deviceCode);
      if (pending && Date.now() <= pending.expiresAt) {
        pending.sessionId = sessionId;
        pending.login = me.login;
        await saveDevice(c.env, deviceCode, pending);
        return c.html(
          `<!doctype html><html><body style="font-family:system-ui;padding:2rem">
           <h1>CLI authorized</h1>
           <p>Logged in as <strong>@${me.login}</strong>.</p>
           <p>Return to the terminal — <code>githost login</code> should finish shortly.</p>
           </body></html>`,
        );
      }
    }
  }

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
 * Local-dev escape hatch: skip GitHub OAuth, create a session, redirect to /.
 *
 *   GET /auth/dev-login                  → log in as user "dev"
 *   GET /auth/dev-login?login=alice      → log in as user "alice"
 *
 * Gated entirely on `env.DEV_LOGIN_ENABLED === "true"`. That var is only ever
 * set in `.dev.vars` (which is git-ignored). In production the var is
 * undefined and this endpoint 404s — see the tests in
 * `test/integration/dev-login.test.ts`.
 *
 * Bypasses the ALLOWED_GITHUB_LOGINS allowlist by design: in local dev you
 * want to mint whatever login is convenient.
 */
/** Shared: mint app_user + session for a local login name. Returns session id. */
async function mintDevSession(
  env: Env,
  login: string,
  userAgent: string | null,
): Promise<{ sessionId: string; login: string }> {
  const adb = appDb(env.APP_DB);
  const now = new Date();
  const existing = await adb.select().from(A.appUser).where(eq(A.appUser.login, login)).get();
  const userId = existing?.id ?? crypto.randomUUID();
  if (!existing) {
    // Use a deterministic-ish gh_user_id so dev rows are stable across re-runs.
    // 100000000+ is well above real GitHub user ids in our test data range.
    const ghUserId = 100000000 + Math.floor(Math.random() * 1000000);
    await adb.insert(A.appUser).values({ id: userId, ghUserId, login, createdAt: now }).run();
  }

  const sessionId = randomId(32);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await adb.insert(A.userSession).values({
    id: sessionId, userId, expiresAt, createdAt: now,
    userAgent,
  }).run();
  return { sessionId, login };
}

authRoutes.get("/dev-login", async (c) => {
  if (c.env.DEV_LOGIN_ENABLED !== "true") return c.notFound();

  const login = (c.req.query("login") ?? "dev").slice(0, 39);  // GitHub login max length
  const { sessionId } = await mintDevSession(
    c.env,
    login,
    c.req.header("user-agent") ?? null,
  );

  c.header("Set-Cookie", sessionCookie(sessionId, 30 * 24 * 60 * 60));
  return c.redirect("/", 302);
});

/**
 * CLI device-code login (no local TCP server — freestanding CLI friendly).
 *
 *   POST /auth/cli-device/start  { login?: string }
 *     → { device_code, user_code, verification_uri_complete, interval, expires_in }
 *
 *   GET  /auth/cli-device?user_code=XXXX
 *     Browser: mint/confirm session and mark the device authorized.
 *
 *   POST /auth/cli-device/poll   { device_code }
 *     → { status: "pending" } | { status: "complete", session, login }
 */

type CliDevicePending = {
  userCode: string;
  preferredLogin: string | null;
  sessionId: string | null;
  login: string | null;
  expiresAt: number;
};

const CLI_DEVICE_TTL_SEC = 600;

async function loadDevice(env: Env, deviceCode: string): Promise<CliDevicePending | null> {
  const raw = await env.DIFF_CACHE.get(`cli-dev:${deviceCode}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CliDevicePending;
  } catch {
    return null;
  }
}

async function saveDevice(env: Env, deviceCode: string, pending: CliDevicePending): Promise<void> {
  const ttl = Math.max(30, Math.floor((pending.expiresAt - Date.now()) / 1000));
  await env.DIFF_CACHE.put(`cli-dev:${deviceCode}`, JSON.stringify(pending), {
    expirationTtl: ttl,
  });
}

authRoutes.post("/cli-device/start", async (c) => {
  const body = await c.req.json<{ login?: string }>().catch(() => ({} as { login?: string }));
  const deviceCode = randomId(32);
  const userCode = randomId(8).toUpperCase();
  const preferredLogin = (body.login ?? c.env.DEV_AUTO_LOGIN_USER ?? "dev").slice(0, 39);
  const pending: CliDevicePending = {
    userCode,
    preferredLogin,
    sessionId: null,
    login: null,
    expiresAt: Date.now() + CLI_DEVICE_TTL_SEC * 1000,
  };
  await saveDevice(c.env, deviceCode, pending);
  await c.env.DIFF_CACHE.put(`cli-usr:${userCode}`, deviceCode, {
    expirationTtl: CLI_DEVICE_TTL_SEC,
  });

  const origin = new URL(c.req.url).origin;
  const verification_uri = `${origin}/auth/cli-device`;
  const verification_uri_complete = `${verification_uri}?user_code=${encodeURIComponent(userCode)}`;
  return c.json({
    device_code: deviceCode,
    user_code: userCode,
    verification_uri,
    verification_uri_complete,
    interval: 1,
    expires_in: CLI_DEVICE_TTL_SEC,
  });
});

authRoutes.post("/cli-device/poll", async (c) => {
  const body = await c.req.json<{ device_code?: string }>().catch(() => null);
  const deviceCode = body?.device_code?.trim() ?? "";
  if (!deviceCode) return c.json({ error: "device_code required" }, 400);
  const pending = await loadDevice(c.env, deviceCode);
  if (!pending) return c.json({ status: "expired" });
  if (Date.now() > pending.expiresAt) return c.json({ status: "expired" });
  if (!pending.sessionId) return c.json({ status: "pending" });
  return c.json({
    status: "complete",
    session: pending.sessionId,
    login: pending.login ?? "?",
  });
});

authRoutes.get("/cli-device", async (c) => {
  const userCode = (c.req.query("user_code") ?? "").trim().toUpperCase();
  if (!userCode) {
    return c.html(
      `<!doctype html><html><body style="font-family:system-ui;padding:2rem">
       <h1>CLI login</h1>
       <p>Missing <code>user_code</code>. Run <code>githost login</code> and open the printed URL.</p>
       </body></html>`,
      400,
    );
  }

  const deviceCode = await c.env.DIFF_CACHE.get(`cli-usr:${userCode}`);
  if (!deviceCode) {
    return c.html(
      `<!doctype html><html><body style="font-family:system-ui;padding:2rem">
       <h1>Code expired</h1>
       <p>User code <strong>${userCode}</strong> is unknown or expired. Run <code>githost login</code> again.</p>
       </body></html>`,
      404,
    );
  }
  const pending = await loadDevice(c.env, deviceCode);
  if (!pending || Date.now() > pending.expiresAt) {
    return c.html(
      `<!doctype html><html><body style="font-family:system-ui;padding:2rem">
       <h1>Code expired</h1>
       <p>Run <code>githost login</code> again.</p>
       </body></html>`,
      404,
    );
  }

  // Already authorized.
  if (pending.sessionId) {
    return c.html(
      `<!doctype html><html><body style="font-family:system-ui;padding:2rem">
       <h1>CLI authorized</h1>
       <p>Logged in as <strong>@${pending.login ?? "?"}</strong>. You can close this tab.</p>
       </body></html>`,
    );
  }

  // Prefer an existing browser session; otherwise mint via dev-login.
  const cookieSid = readCookie(c.req.header("cookie"), SESSION_COOKIE);
  let sessionId: string | null = null;
  let login: string | null = null;

  if (cookieSid) {
    const adb = appDb(c.env.APP_DB);
    const row = await adb
      .select({ id: A.userSession.id, login: A.appUser.login })
      .from(A.userSession)
      .innerJoin(A.appUser, eq(A.appUser.id, A.userSession.userId))
      .where(eq(A.userSession.id, cookieSid))
      .get();
    if (row) {
      sessionId = row.id;
      login = row.login;
    }
  }

  if (!sessionId && c.env.DEV_LOGIN_ENABLED === "true") {
    const preferred = (pending.preferredLogin ?? "dev").slice(0, 39);
    const minted = await mintDevSession(
      c.env,
      preferred,
      c.req.header("user-agent") ?? null,
    );
    sessionId = minted.sessionId;
    login = minted.login;
    c.header("Set-Cookie", sessionCookie(sessionId, 30 * 24 * 60 * 60));
  }

  if (!sessionId) {
    // Production: send user through OAuth, remember user_code.
    c.header("Set-Cookie", cookiePair(CLI_USER_CODE_COOKIE, userCode, 600), { append: true });
    const oauthState = randomId(16);
    const cb = new URL(c.req.url);
    cb.pathname = "/auth/callback";
    cb.search = "";
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", c.env.GITHUB_OAUTH_CLIENT_ID);
    url.searchParams.set("redirect_uri", cb.toString());
    url.searchParams.set("state", oauthState);
    url.searchParams.set("scope", "read:user");
    c.header("Set-Cookie", cookiePair(STATE_COOKIE, oauthState, 600), { append: true });
    return c.redirect(url.toString(), 302);
  }

  pending.sessionId = sessionId;
  pending.login = login;
  await saveDevice(c.env, deviceCode, pending);

  return c.html(
    `<!doctype html><html><body style="font-family:system-ui;padding:2rem">
     <h1>CLI authorized</h1>
     <p>Logged in as <strong>@${login ?? "?"}</strong>.</p>
     <p>Return to the terminal — <code>githost login</code> should finish shortly.</p>
     </body></html>`,
  );
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
  <p style="margin-top:1.5rem;font-size:0.85rem;color:#71717a">
    Local dev? <a href="/auth/dev-login" style="color:#18181b">Dev login</a>
  </p>
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
