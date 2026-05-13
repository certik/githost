import { Link, Route, Routes, useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { html as diffHtml, parse as diffParse } from "diff2html";
import "diff2html/bundles/css/diff2html.min.css";
import { api, ApiError } from "./api";

export default function App() {
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me(), staleTime: 60_000 });
  const qc = useQueryClient();
  const logout = useMutation({
    mutationFn: () => api.logout(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });

  return (
    <div className="min-h-screen">
      <header className="border-b bg-white px-6 py-3 flex items-center gap-4">
        <Link to="/" className="font-semibold text-zinc-900">githost</Link>
        <nav className="text-sm text-zinc-600 flex gap-4 flex-1">
          <Link to="/" className="hover:text-zinc-900">PRs</Link>
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
          <Route path="*" element={<div className="text-zinc-500">Not found.</div>} />
        </Routes>
      </main>
    </div>
  );
}

function PrList({ signedIn }: { signedIn: boolean }) {
  const [state, setState] = useState<"open" | "closed" | "all">("open");
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["prs", state],
    queryFn: () => api.prs(state === "all" ? undefined : state),
  });
  const refresh = useMutation({
    mutationFn: () => api.refresh("prs"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["prs"] }),
  });

  const refreshError = refresh.error instanceof ApiError && refresh.error.status === 401
    ? "Sign in to refresh from GitHub."
    : refresh.error
      ? (refresh.error as Error).message
      : null;

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold">Pull requests</h1>
        <div className="flex items-center gap-2">
          <select className="border rounded px-2 py-1 text-sm" value={state} onChange={(e) => setState(e.target.value as any)}>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
            <option value="all">All</option>
          </select>
          <button
            className="border rounded px-3 py-1 text-sm bg-white hover:bg-zinc-100 disabled:opacity-50"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending || !signedIn}
            title={signedIn ? undefined : "Sign in to refresh from GitHub"}
          >{refresh.isPending ? "Queuing…" : "Manual refresh"}</button>
        </div>
      </div>

      {refreshError && <div className="mb-3 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">{refreshError}</div>}
      {isLoading && <div className="text-zinc-500">Loading…</div>}
      {error && <div className="text-red-600 text-sm">{String((error as Error).message)}</div>}

      <ul className="divide-y rounded border bg-white">
        {data?.items.map((p) => (
          <li key={p.id} className="px-4 py-3 hover:bg-zinc-50">
            <Link to={`/pr/${p.number}`} className="flex items-baseline gap-3">
              <span className={`text-xs px-2 py-0.5 rounded-full ${
                p.merged ? "bg-purple-100 text-purple-700" :
                p.state === "open" ? "bg-green-100 text-green-700" :
                "bg-zinc-200 text-zinc-700"
              }`}>
                {p.merged ? "merged" : p.state}
              </span>
              <span className="text-zinc-900 font-medium">{p.title}</span>
              <span className="text-zinc-500 text-sm">#{p.number} by {p.authorLogin ?? "?"}</span>
            </Link>
          </li>
        ))}
        {data && data.items.length === 0 && (
          <li className="px-4 py-6 text-zinc-500 text-sm">
            No PRs yet. {signedIn ? "Hit “Manual refresh” to sync from GitHub." : "Sign in and hit “Manual refresh” to sync from GitHub."}
          </li>
        )}
      </ul>
    </div>
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
