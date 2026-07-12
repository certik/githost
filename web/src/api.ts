export type TestStatus = "queued" | "running" | "passed" | "failed" | "skipped";

export interface TestRun {
  status: TestStatus;
  headSha: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  logUrl: string | null;
  updatedAt: number;
}

export interface PrSummary {
  id: number;
  number: number;
  title: string;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  // null = GitHub still computing (recent push), true/false = known.
  mergeable: boolean | null;
  // "clean" | "dirty" | "unstable" | "behind" | "blocked" | "unknown" | "draft"
  mergeableState: string | null;
  headRef: string | null;
  baseRef: string | null;
  createdAt: number;
  updatedAt: number;
  authorLogin: string | null;
  htmlUrl: string;
  quickTest: TestRun | null;
  exhaustiveTest: TestRun | null;
}

export interface PrDetailResponse {
  pr: PrSummary & { body: string | null; headSha: string | null; baseSha: string | null };
  reviews: AiReview[];
  localLabels: { name: string; color: string | null }[];
}

export interface AiReview {
  id: string;
  prNumber: number;
  headSha: string;
  status: "pending" | "ready" | "posted" | "discarded" | "failed";
  summary: string | null;
  commentsJson: string | null;
  postedUpstreamAt: number | null;
  createdAt: number;
}

/** Parsed inline comment from ai_review.comments_json / githost.review/v1. */
export interface ReviewComment {
  path: string;
  line: number;
  body: string;
  startLine?: number;
  side?: string;
  reviewId: string;
  reviewStatus: AiReview["status"];
  headSha: string;
}

export interface Me {
  user: { id: string; ghUserId: number; login: string } | null;
  /** Present only when Worker has DEV_LOGIN_ENABLED=true (local .dev.vars). */
  dev?: {
    autoLogin: boolean;
    loginUrl: string;
    login: string;
  } | null;
}

export class ApiError extends Error {
  constructor(public status: number, public bodyText: string) {
    super(`HTTP ${status}: ${bodyText}`);
  }
}

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { credentials: "include", ...init });
  if (!r.ok) throw new ApiError(r.status, await r.text());
  return r.json() as Promise<T>;
}

export interface RefreshResponse {
  ok: true;
  scheduled?: boolean;
  alreadyRunning?: boolean;
  page?: number;
  batches?: number;
  maxBatches?: number;
  queued?: string;
}

export interface SyncStatus {
  status: "idle" | "running" | "stopped";
  page: number | null;
  batches: number;
  processed: number;
  maxBatches: number;
  startedAt: number | null;
  finishedAt: number | null;
  lastError: string | null;
}

export interface SyncLogEntry {
  id: number;
  ts: number;
  level: "info" | "warn" | "error";
  event: string;
  message: string;
  context: unknown;
}

export const api = {
  me: () => j<Me>(`/api/me`),
  prs: (state?: string) => j<{ items: PrSummary[] }>(`/api/prs${state ? `?state=${state}` : ""}`),
  pr: (n: number) => j<PrDetailResponse>(`/api/prs/${n}`),
  diff: (n: number) => fetch(`/api/prs/${n}/diff`, { credentials: "include" }).then(r => r.text()),
  refresh: (resource: "prs" | "issues" | "comments" = "prs", opts?: { maxBatches?: number }) =>
    j<RefreshResponse>(`/api/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resource, ...(opts?.maxBatches ? { maxBatches: opts.maxBatches } : {}) }),
    }),
  refreshStatus: () => j<SyncStatus>(`/api/refresh/status`),
  logs: (opts?: { limit?: number; level?: string; event?: string; q?: string }) => {
    const params = new URLSearchParams();
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.level) params.set("level", opts.level);
    if (opts?.event) params.set("event", opts.event);
    if (opts?.q)     params.set("q", opts.q);
    const qs = params.toString();
    return j<{ items: SyncLogEntry[] }>(`/api/logs${qs ? `?${qs}` : ""}`);
  },
  logout: () => fetch(`/auth/logout`, { method: "POST", credentials: "include" }),
};
