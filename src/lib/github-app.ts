import { SignJWT, importPKCS8 } from "jose";

/**
 * GitHub App auth:
 *   1. Sign a short-lived RS256 JWT with the App's private key. (`appJwt`)
 *   2. Exchange JWT for an installation access token (1-hour TTL). (`installationToken`)
 *   3. Cache installation tokens per installation_id until ~5 minutes before expiry.
 *
 * All HTTP is plain `fetch` to keep the Worker bundle small.
 */

const tokenCache = new Map<number, { token: string; expiresAt: number }>();

/** True when the PEM looks like a real PKCS#8 private key (not the .dev.vars placeholder). */
export function hasUsableGithubAppKey(privateKeyPem: string | undefined | null): boolean {
  if (!privateKeyPem || !privateKeyPem.trim()) return false;
  const pem = normalizePem(privateKeyPem);
  if (pem.includes("...")) return false; // placeholder from .dev.vars.example
  if (pem.includes("BEGIN RSA PRIVATE KEY")) return false; // PKCS#1 — jose needs PKCS#8
  return pem.includes("BEGIN PRIVATE KEY");
}

async function appJwt(appId: string, privateKeyPem: string): Promise<string> {
  const pem = normalizePem(privateKeyPem);
  if (!hasUsableGithubAppKey(pem)) {
    throw new GithubAppAuthError(
      "GITHUB_APP_PRIVATE_KEY is missing or not PKCS#8 PEM. " +
        "For local diffs, put a real App private key in .dev.vars " +
        '(PKCS#8: "-----BEGIN PRIVATE KEY-----"). ' +
        "Convert PKCS#1 with: openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in app.pem -out app.pkcs8.pem",
    );
  }
  let key;
  try {
    key = await importPKCS8(pem, "RS256");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new GithubAppAuthError(
      `GITHUB_APP_PRIVATE_KEY could not be imported (${msg}). ` +
        "Use a PKCS#8 PEM (BEGIN PRIVATE KEY), not a placeholder.",
    );
  }
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt(now - 30)              // clock-skew tolerance
    .setExpirationTime(now + 9 * 60)    // GitHub allows max 10 min
    .setIssuer(appId)
    .sign(key);
}

export class GithubAppAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubAppAuthError";
  }
}

/**
 * Some keys come as PKCS#1 ("BEGIN RSA PRIVATE KEY"). jose's importPKCS8 expects PKCS#8.
 * If you have a PKCS#1 key, convert once with:
 *   openssl pkcs8 -topk8 -inform PEM -outform PEM -in app.pem -out app.pkcs8.pem -nocrypt
 * This helper normalizes escaped newlines (common in .dev.vars) and trims.
 */
function normalizePem(pem: string): string {
  return pem.replace(/\\n/g, "\n").trim() + "\n";
}

export async function installationToken(env: {
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
}, installationId: number): Promise<string> {
  const cached = tokenCache.get(installationId);
  const nowMs = Date.now();
  if (cached && cached.expiresAt - 5 * 60_000 > nowMs) return cached.token;

  const jwt = await appJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  const res = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "githost",
    },
  });
  if (!res.ok) {
    throw new Error(`installation token failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json<{ token: string; expires_at: string }>();
  const expiresAt = Date.parse(data.expires_at);
  tokenCache.set(installationId, { token: data.token, expiresAt });
  return data.token;
}

/**
 * Minimal authenticated fetch against the GitHub REST API.
 * Pass `installationId` for app-scoped requests, or pass a user OAuth token directly via `token`.
 */
export async function gh(
  env: { GITHUB_APP_ID: string; GITHUB_APP_PRIVATE_KEY: string },
  opts: { installationId?: number; token?: string; path: string; method?: string; body?: unknown; headers?: Record<string, string> },
): Promise<Response> {
  const tok = opts.token ?? (opts.installationId !== undefined
    ? await installationToken(env, opts.installationId)
    : undefined);
  if (!tok) throw new Error("gh(): need installationId or token");

  const url = opts.path.startsWith("http") ? opts.path : `https://api.github.com${opts.path}`;
  return fetch(url, {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `token ${tok}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "githost",
      "Content-Type": opts.body ? "application/json" : "",
      ...opts.headers,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}
