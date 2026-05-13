/**
 * Build a test user + session directly in D1 so tests don't need to run the
 * GitHub OAuth flow. Returns a ready-to-paste cookie header value.
 */
import { env } from "cloudflare:test";

export interface TestSession {
  userId: string;
  sessionId: string;
  cookie: string;
}

export async function createSession(opts: { login?: string; ghUserId?: number } = {}): Promise<TestSession> {
  const userId = crypto.randomUUID();
  const ghUserId = opts.ghUserId ?? Math.floor(Math.random() * 1_000_000) + 1;
  const login = opts.login ?? `tester-${ghUserId}`;
  const sessionId = `test-${crypto.randomUUID()}`;
  const now = Date.now();

  await env.APP_DB.prepare(
    "INSERT INTO app_user (id, gh_user_id, login, created_at) VALUES (?, ?, ?, ?)"
  ).bind(userId, ghUserId, login, now).run();

  await env.APP_DB.prepare(
    "INSERT INTO user_session (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)"
  ).bind(sessionId, userId, now + 24 * 60 * 60 * 1000, now).run();

  return { userId, sessionId, cookie: `gh_session=${sessionId}` };
}
