import { Link, Route, Routes, useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { html as diffHtml, parse as diffParse } from "diff2html";
import "diff2html/bundles/css/diff2html.min.css";
import { api, ApiError, type PrSummary, type TestRun, type TestStatus } from "./api";
import { groupForReviewPriority } from "./lib/review-priority";
import Logs from "./Logs";

type SortMode = "review-priority" | "newest";
const SORT_MODE_KEY = "githost.sortMode";

const MAX_BATCHES_KEY = "githost.maxBatches";
const MAX_BATCHES_CHOICES = [5, 15, 50, 100, 200] as const;
const MAX_BATCHES_DEFAULT = 5;

export default function App() {
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me(), staleTime: 60_000 });
  const qc = useQueryClient();
  const logout = useMutation({
    mutationFn: () => api.logout(),
    // After the server clears the cookie, do a full-page navigation to the
    // signed-out splash. This unmounts the SPA (and drops React Query's PR
    // cache), so the user can't see stale authenticated state.
    onSuccess: () => { window.location.assign("/auth/signed-out"); },
  });

  return (
    <div className="min-h-screen">
      <header className="border-b bg-white px-6 py-3 flex items-center gap-4">
        <Link to="/" className="font-semibold text-zinc-900">githost</Link>
        <nav className="text-sm text-zinc-600 flex gap-4 flex-1">
          <Link to="/" className="hover:text-zinc-900">PRs</Link>
          <Link to="/logs" className="hover:text-zinc-900">Sync log</Link>
        </nav>
        {me?.user ? (
          <div className="flex items-center gap-3 text-sm">
            <span className="text-zinc-700">@{me.user.login}</span>
            <button
              onClick={() => logout.mutate()}
              className="text-zinc-500 hover:text-zinc-900"
            >Sign out</button>
          </div>
        ) : (
          <a
            href="/auth/login"
            className="text-sm border rounded px-3 py-1 bg-white hover:bg-zinc-100"
          >Sign in with GitHub</a>
        )}
      </header>
      <main className="px-6 py-6">
        <Routes>
          <Route path="/" element={<PrList signedIn={!!me?.user} />} />
          <Route path="/pr/:number" element={<PrDetail />} />
          <Route path="/logs" element={<Logs />} />
          <Route path="*" element={<div className="text-zinc-500">Not found.</div>} />
        </Routes>
      </main>
    </div>
  );
}

function PrList({ signedIn }: { signedIn: boolean }) {
  const [state, setState] = useState<"open" | "closed" | "all">("open");
  const [sortMode, setSortMode] = useState<SortMode>(() => {
    // Persist the user's choice across reloads. Default is the new
    // "review-priority" view; the old flat newest-first view is still
    // selectable.
    try {
      const v = localStorage.getItem(SORT_MODE_KEY);
      if (v === "newest" || v === "review-priority") return v;
    } catch { /* localStorage unavailable; fall through */ }
    return "review-priority";
  });
  useEffect(() => {
    try { localStorage.setItem(SORT_MODE_KEY, sortMode); } catch { /* ignore */ }
  }, [sortMode]);

  const [maxBatches, setMaxBatches] = useState<number>(() => {
    try {
      const v = parseInt(localStorage.getItem(MAX_BATCHES_KEY) ?? "", 10);
      if (MAX_BATCHES_CHOICES.includes(v as typeof MAX_BATCHES_CHOICES[number])) return v;
    } catch { /* fall through */ }
    return MAX_BATCHES_DEFAULT;
  });
  useEffect(() => {
    try { localStorage.setItem(MAX_BATCHES_KEY, String(maxBatches)); } catch { /* ignore */ }
  }, [maxBatches]);

  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["prs", state],
    queryFn: () => api.prs(state === "all" ? undefined : state),
  });
  const refresh = useMutation({
    mutationFn: () => api.refresh("prs", { maxBatches }),
  });

  // Poll the DO status while the chain is running, then 5s of "settling"
  // after it finishes so the PR list query refetches and the user sees the
  // newly-synced state. The DO returns { status: "idle" } when done.
  const refreshTriggered = refresh.isPending || refresh.isSuccess;
  const syncStatus = useQuery({
    queryKey: ["refresh-status"],
    queryFn: () => api.refreshStatus(),
    enabled: refreshTriggered,
    refetchInterval: (q) => q.state.data?.status === "running" ? 1500 : false,
  });

  // When the chain transitions to idle, invalidate the PR query so the new
  // data shows up.
  useEffect(() => {
    if (syncStatus.data?.status === "idle" && refreshTriggered) {
      qc.invalidateQueries({ queryKey: ["prs"] });
    }
  }, [syncStatus.data?.status, refreshTriggered, qc]);

  const refreshError = refresh.error instanceof ApiError && refresh.error.status === 401
    ? "Sign in to refresh from GitHub."
    : refresh.error
      ? (refresh.error as Error).message
      : null;

  // Build a status banner from the DO status. While running: show progress.
  // When idle, show the last completion if recent.
  const refreshBanner = (() => {
    if (!refreshTriggered) return null;
    const s = syncStatus.data;
    if (!s) {
      // mutation succeeded but first status fetch hasn't returned yet
      return refresh.data?.alreadyRunning ? "A sync is already running." : "Sync starting…";
    }
    if (s.status === "running") {
      return `Syncing… page ${s.page}, ${s.batches} batches, ${s.processed} PRs synced.`;
    }
    if (s.status === "stopped" && s.lastError) {
      return `Sync stopped: ${s.lastError}`;
    }
    if (s.status === "idle" && s.finishedAt) {
      return `Sync complete: ${s.batches} batches, ${s.processed} PRs synced.`;
    }
    return null;
  })();

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold">Pull requests</h1>
        <div className="flex items-center gap-2">
          <select
            className="border rounded px-2 py-1 text-sm"
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value as SortMode)}
            title="Sort mode"
          >
            <option value="review-priority">Review priority</option>
            <option value="newest">Newest first</option>
          </select>
          <select className="border rounded px-2 py-1 text-sm" value={state} onChange={(e) => setState(e.target.value as any)}>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
            <option value="all">All</option>
          </select>
          <select
            className="border rounded px-2 py-1 text-sm"
            value={maxBatches}
            onChange={(e) => setMaxBatches(parseInt(e.target.value, 10))}
            title="Max batches per refresh click (20 PRs per batch). Higher = catches up more drift but takes longer."
            disabled={refresh.isPending || syncStatus.data?.status === "running"}
          >
            {MAX_BATCHES_CHOICES.map((n) => (
              <option key={n} value={n}>{n} batches</option>
            ))}
          </select>
          <button
            className="border rounded px-3 py-1 text-sm bg-white hover:bg-zinc-100 disabled:opacity-50"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending || !signedIn}
            title={signedIn ? undefined : "Sign in to refresh from GitHub"}
          >{refresh.isPending ? "Refreshing…" : "Manual refresh"}</button>
        </div>
      </div>

      {refreshError && <div className="mb-3 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">{refreshError}</div>}
      {refreshBanner && !refreshError && (
        <div className={`mb-3 text-sm rounded px-3 py-2 flex items-center justify-between border ${
          syncStatus.data?.status === "running"
            ? "text-blue-800 bg-blue-50 border-blue-200"
            : syncStatus.data?.status === "stopped"
              ? "text-red-800 bg-red-50 border-red-200"
              : "text-emerald-800 bg-emerald-50 border-emerald-200"
        }`}>
          <span>{refreshBanner}</span>
          <Link to="/logs" className="text-xs underline opacity-75 hover:opacity-100">view sync log</Link>
        </div>
      )}
      {isLoading && <div className="text-zinc-500">Loading…</div>}
      {error && <div className="text-red-600 text-sm">{String((error as Error).message)}</div>}

      {data && (sortMode === "review-priority"
        ? <PrListReviewPriority items={data.items} signedIn={signedIn} />
        : <PrListFlat items={data.items} signedIn={signedIn} />)}
    </div>
  );
}

/** Header row used at the top of every PR list view, shared for column alignment. */
function PrListHeader() {
  return (
    <li className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500 grid grid-cols-[1fr_8rem_3rem_4.5rem_4.5rem] gap-3 items-center">
      <span>Pull request</span>
      <span className="text-center">State</span>
      <span className="text-center" title="Mergeable status from GitHub">Merge</span>
      <span className="text-center" title="Quick tests">Quick</span>
      <span className="text-center" title="Exhaustive tests">Exhaustive</span>
    </li>
  );
}

function PrRow({ p }: { p: PrSummary }) {
  return (
    <li className="px-4 py-3 hover:bg-zinc-50 grid grid-cols-[1fr_8rem_3rem_4.5rem_4.5rem] gap-3 items-center">
      <a href={p.htmlUrl} target="_blank" rel="noreferrer" className="flex items-baseline gap-2 min-w-0">
        <span className="text-zinc-900 font-medium truncate hover:underline">{p.title}</span>
        <span className="text-zinc-500 text-xs whitespace-nowrap">#{p.number} by {p.authorLogin ?? "?"}</span>
      </a>
      <span className="flex justify-center"><PrStateBadge pr={p} /></span>
      <span className="flex justify-center"><MergeableIndicator pr={p} /></span>
      <span className="flex justify-center"><TestStatusDot run={p.quickTest} label="Quick" /></span>
      <span className="flex justify-center"><TestStatusDot run={p.exhaustiveTest} label="Exhaustive" /></span>
    </li>
  );
}

/**
 * Renders a 16×16 icon showing whether a PR is mergeable per GitHub:
 *   - true  → green check (clean merge possible)
 *   - false → red X (merge conflict, needs rebase)
 *   - null  → gray "?" (GH still computing, or PR is closed/merged)
 *
 * For merged/closed PRs we suppress the indicator entirely since merging
 * is no longer relevant.
 */
function MergeableIndicator({ pr }: { pr: PrSummary }) {
  if (pr.state === "closed" || pr.merged) {
    return <span className="text-zinc-300" title="Not relevant (PR is closed)">—</span>;
  }
  if (pr.mergeable === true) {
    return (
      <svg viewBox="0 0 16 16" className="w-4 h-4 text-green-600"
        role="img" aria-label="Mergeable">
        <title>{`Mergeable (${pr.mergeableState ?? "clean"})`}</title>
        <path d="M3 8.5L6.5 12L13 4.5" stroke="currentColor" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (pr.mergeable === false) {
    return (
      <svg viewBox="0 0 16 16" className="w-4 h-4 text-red-600"
        role="img" aria-label="Merge conflict">
        <title>{`Merge conflict (${pr.mergeableState ?? "dirty"})`}</title>
        <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="2.5" fill="none" strokeLinecap="round" />
      </svg>
    );
  }
  // mergeable === null: GH still computing, OR we haven't synced this PR
  // since the column was added. Will resolve on the next webhook / refresh.
  return (
    <svg viewBox="0 0 16 16" className="w-4 h-4 text-zinc-400"
      role="img" aria-label="Mergeable status unknown">
      <title>Mergeable status unknown — GitHub is computing or sync pending</title>
      <text x="8" y="13" textAnchor="middle" fontSize="14" fill="currentColor" fontWeight="bold" fontFamily="system-ui">?</text>
    </svg>
  );
}

function PrListFlat({ items, signedIn }: { items: PrSummary[]; signedIn: boolean }) {
  return (
    <ul className="divide-y rounded border bg-white text-sm">
      <PrListHeader />
      {items.map((p) => <PrRow key={p.id} p={p} />)}
      {items.length === 0 && (
        <li className="px-4 py-6 text-zinc-500 text-sm">
          No PRs yet. {signedIn ? "Hit “Manual refresh” to sync from GitHub." : "Sign in and hit “Manual refresh” to sync from GitHub."}
        </li>
      )}
    </ul>
  );
}

/**
 * "Review priority" layout:
 *   - "Ready for review" section at the top, grouped by (quick × exhaustive)
 *     test status. The first group ("both passed") gets a highlighted box —
 *     these are the PRs you can merge in CI terms.
 *   - "Draft" section below a visual gap.
 */
function PrListReviewPriority({ items, signedIn }: { items: PrSummary[]; signedIn: boolean }) {
  const { ready, drafts } = useMemo(() => groupForReviewPriority(items), [items]);

  if (items.length === 0) {
    return (
      <ul className="divide-y rounded border bg-white text-sm">
        <PrListHeader />
        <li className="px-4 py-6 text-zinc-500 text-sm">
          No PRs yet. {signedIn ? "Hit “Manual refresh” to sync from GitHub." : "Sign in and hit “Manual refresh” to sync from GitHub."}
        </li>
      </ul>
    );
  }

  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-xs uppercase tracking-wide text-zinc-500 font-semibold mb-2">Ready for review</h2>
        {ready.length === 0
          ? <div className="text-zinc-500 text-sm px-4 py-3 border rounded bg-white">Nothing here — all open PRs are drafts.</div>
          : (
            <div className="space-y-3">
              {ready.map((g) => {
                const boxClass = g.highlight
                  ? "rounded-md border-2 border-green-500 bg-white shadow-sm"
                  : g.warn
                    ? "rounded-md border-2 border-amber-400 bg-white shadow-sm"
                    : "rounded border bg-white";
                const headerClass = g.highlight
                  ? "text-green-700"
                  : g.warn
                    ? "text-amber-700"
                    : "text-zinc-500";
                return (
                <div key={g.key} className={boxClass}>
                  <div className={`px-4 py-1.5 text-xs font-medium uppercase tracking-wide ${headerClass}`}>
                    {g.label}
                    <span className="text-zinc-400 normal-case font-normal ml-2">
                      ({g.items.length})
                    </span>
                  </div>
                  <ul className="divide-y text-sm">
                    <PrListHeader />
                    {g.items.map((p) => <PrRow key={p.id} p={p} />)}
                  </ul>
                </div>
                );
              })}
            </div>
          )}
      </section>

      <section>
        <h2 className="text-xs uppercase tracking-wide text-zinc-500 font-semibold mb-2">Draft</h2>
        {drafts.length === 0
          ? <div className="text-zinc-500 text-sm px-4 py-3 border rounded bg-white">No drafts.</div>
          : (
            <ul className="divide-y rounded border bg-white text-sm">
              <PrListHeader />
              {drafts.map((p) => <PrRow key={p.id} p={p} />)}
            </ul>
          )}
      </section>
    </div>
  );
}

function PrStateBadge({ pr }: { pr: PrSummary }) {
  let label: string;
  let cls: string;
  if (pr.merged) {
    label = "Merged";
    cls = "bg-purple-100 text-purple-700";
  } else if (pr.state === "closed") {
    label = "Closed";
    cls = "bg-zinc-200 text-zinc-700";
  } else if (pr.draft) {
    label = "Draft";
    cls = "bg-zinc-100 text-zinc-600 border border-zinc-300";
  } else {
    label = "Ready for review";
    cls = "bg-green-100 text-green-700";
  }
  return <span className={`text-xs px-2 py-0.5 rounded-full whitespace-nowrap ${cls}`}>{label}</span>;
}

/**
 * GitHub-style status icons for the test buckets.
 *
 * All icons render in a 16×16 (w-4 h-4) bounding box so the column lines up.
 * The "primary circle" diameter is 16 px for every status that has an outer
 * ring (not queued, running, passed, failed, skipped). Queued + the inner of
 * running share a smaller 10 px amber dot: when a queued check transitions
 * to running, only the outer ring appears — the inner dot stays the same
 * size.
 *
 * Hovering shows status + head_sha (when present).
 */
function TestStatusDot({ run, label }: { run: TestRun | null; label: string }) {
  const status: TestStatus | null = run?.status ?? null;
  let human = "not queued";
  if (status === "queued") human = "queued";
  else if (status === "running") human = "running";
  else if (status === "passed") human = "passed";
  else if (status === "failed") human = "failed";
  else if (status === "skipped") human = "skipped";

  let title = `${label}: ${human}`;
  if (run?.headSha) title += ` @ ${run.headSha.slice(0, 7)}`;

  const icon = (
    <span className="inline-flex items-center justify-center w-4 h-4" title={title} aria-label={title}>
      {status === null && <NotQueuedIcon />}
      {status === "queued" && <QueuedIcon />}
      {status === "running" && <RunningIcon />}
      {status === "passed" && <PassedIcon />}
      {status === "failed" && <FailedIcon />}
      {status === "skipped" && <SkippedIcon />}
    </span>
  );

  return run?.logUrl
    ? <a href={run.logUrl} target="_blank" rel="noreferrer" className="inline-flex">{icon}</a>
    : icon;
}

function NotQueuedIcon() {
  // 16 px thin gray ring — same outer diameter as every other icon.
  return <span className="w-4 h-4 rounded-full border border-zinc-300" />;
}

function QueuedIcon() {
  // Small 8 px amber dot, centered. Identical to the inner dot of
  // RunningIcon so transition queued → running adds just the outer ring.
  return <span className="inline-block rounded-full bg-amber-400" style={{ width: "8px", height: "8px" }} />;
}

/**
 * Layered "running" indicator:
 *   - 8 px amber-400 inner dot (matches QueuedIcon exactly)
 *   - amber-200 static track at the 16 px outer edge
 *   - amber-400 spinning arc on top of the track
 *
 * Absolute positioning so the inner dot shares the SVG ring's exact pixel
 * center (flex centering produces a subpixel offset).
 */
function RunningIcon() {
  return (
    <span className="relative inline-block w-4 h-4">
      <span
        className="absolute rounded-full bg-amber-400"
        style={{ width: "8px", height: "8px", left: "4px", top: "4px" }}
      />
      <svg className="absolute inset-0 w-4 h-4 block" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="7" fill="none" stroke="#fde68a" strokeWidth="2" />
      </svg>
      <svg className="absolute inset-0 w-4 h-4 block animate-spin" viewBox="0 0 16 16" aria-hidden="true">
        <circle
          cx="8" cy="8" r="7"
          fill="none"
          stroke="#f59e0b"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray="13 100"
        />
      </svg>
    </span>
  );
}

function PassedIcon() {
  // 16 px green circle with white checkmark (GitHub style).
  return (
    <svg className="w-4 h-4 block" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="8" fill="#22c55e" />
      <path
        d="M4.5 8.5 L7 11 L11.75 5.75"
        fill="none"
        stroke="white"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FailedIcon() {
  // 16 px red circle with white X.
  return (
    <svg className="w-4 h-4 block" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="8" fill="#ef4444" />
      <path
        d="M5.5 5.5 L10.5 10.5 M10.5 5.5 L5.5 10.5"
        stroke="white"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SkippedIcon() {
  // 16 px gray ring, white inner field, gray diagonal slash through the middle.
  // Ring thickness = outer r=8 minus inner r=6 → 2 px. Slash strokeWidth
  // matches so the slash visually balances with the ring.
  return (
    <svg className="w-4 h-4 block" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="8" fill="#9ca3af" />
      <circle cx="8" cy="8" r="6" fill="white" />
      <path d="M5 11 L11 5" stroke="#9ca3af" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function PrDetail() {
  const { number } = useParams();
  const n = Number(number);
  const { data, isLoading, error } = useQuery({ queryKey: ["pr", n], queryFn: () => api.pr(n), enabled: !isNaN(n) });

  const [diff, setDiff] = useState<string>("");
  useEffect(() => { if (!isNaN(n)) api.diff(n).then(setDiff).catch(() => setDiff("")); }, [n]);

  const diffRendered = useMemo(() => {
    if (!diff) return "";
    return diffHtml(diffParse(diff), { drawFileList: true, matching: "lines", outputFormat: "side-by-side" });
  }, [diff]);

  if (isLoading) return <div className="text-zinc-500">Loading…</div>;
  if (error)     return <div className="text-red-600 text-sm">{String((error as Error).message)}</div>;
  if (!data)     return null;

  return (
    <div className="max-w-6xl mx-auto">
      <h2 className="text-xl font-semibold mb-1">
        {data.pr.title} <span className="text-zinc-500 font-normal">#{data.pr.number}</span>
      </h2>
      <p className="text-sm text-zinc-500 mb-4">
        by {data.pr.authorLogin ?? "?"} · {data.pr.baseRef} ← {data.pr.headRef}
      </p>

      {data.localLabels.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {data.localLabels.map(l => (
            <span key={l.name} className="text-xs px-2 py-0.5 rounded-full bg-zinc-200 text-zinc-700">
              {l.name}
            </span>
          ))}
        </div>
      )}

      {data.reviews.length > 0 && (
        <section className="mb-6 bg-white border rounded p-3">
          <h3 className="font-medium mb-2">AI reviews (local)</h3>
          <ul className="space-y-2 text-sm">
            {data.reviews.map(r => (
              <li key={r.id} className="border-l-2 pl-2">
                <div className="text-xs text-zinc-500">{r.status} · {r.headSha.slice(0, 7)}</div>
                <div>{r.summary ?? <em className="text-zinc-400">(no summary yet)</em>}</div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h3 className="font-medium mb-2">Diff</h3>
        {diff
          ? <div className="bg-white border rounded overflow-hidden" dangerouslySetInnerHTML={{ __html: diffRendered }} />
          : <div className="text-zinc-500 text-sm">No diff available yet.</div>}
      </section>
    </div>
  );
}
