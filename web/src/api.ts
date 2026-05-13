export interface PrSummary {
  id: number;
  number: number;
  title: string;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  headRef: string | null;
  baseRef: string | null;
  createdAt: number;
  updatedAt: number;
  authorLogin: string | null;
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

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { credentials: "include", ...init });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}

export const api = {
  prs: (state?: string) => j<{ items: PrSummary[] }>(`/api/prs${state ? `?state=${state}` : ""}`),
  pr: (n: number) => j<PrDetailResponse>(`/api/prs/${n}`),
  diff: (n: number) => fetch(`/api/prs/${n}/diff`, { credentials: "include" }).then(r => r.text()),
  refresh: (resource: "prs" | "issues" | "comments" = "prs") =>
    j<{ ok: true }>(`/api/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resource }) }),
};
