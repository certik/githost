import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type SyncLogEntry } from "./api";

/**
 * /logs — operational log viewer for the resync chain + webhook handlers.
 *
 * Auto-refreshes every 5s so we can watch a chain run end-to-end. Filtering
 * by level (info/warn/error) and event lets us zoom into specific failures.
 *
 * No virtualization yet — the backend caps the table at ~1000 rows and the
 * default limit is 200, so we never render more than that.
 */
export default function Logs() {
  const [level, setLevel] = useState<string>("");
  const [event, setEvent] = useState<string>("");
  const [paused, setPaused] = useState(false);
  const [limit, setLimit] = useState(200);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["logs", level, event, limit],
    queryFn: () => api.logs({ limit, level: level || undefined, event: event || undefined }),
    refetchInterval: paused ? false : 5_000,
    staleTime: 0,
  });

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold">Sync log</h1>
        <div className="flex items-center gap-2">
          <select
            className="border rounded px-2 py-1 text-sm"
            value={level}
            onChange={(e) => setLevel(e.target.value)}
            title="Filter by level"
          >
            <option value="">All levels</option>
            <option value="info">Info</option>
            <option value="warn">Warn</option>
            <option value="error">Error</option>
          </select>
          <input
            className="border rounded px-2 py-1 text-sm w-40"
            placeholder="event filter…"
            value={event}
            onChange={(e) => setEvent(e.target.value)}
            title="Exact event match, e.g. sync.batch.done"
          />
          <select
            className="border rounded px-2 py-1 text-sm"
            value={limit}
            onChange={(e) => setLimit(parseInt(e.target.value, 10))}
          >
            <option value={50}>Last 50</option>
            <option value={200}>Last 200</option>
            <option value={500}>Last 500</option>
            <option value={1000}>Last 1000</option>
          </select>
          <button
            onClick={() => setPaused((p) => !p)}
            className="border rounded px-3 py-1 text-sm bg-white hover:bg-zinc-100"
            title={paused ? "Resume auto-refresh" : "Pause auto-refresh"}
          >{paused ? "▶ Resume" : "⏸ Pause"}</button>
          <button
            onClick={() => refetch()}
            className="border rounded px-3 py-1 text-sm bg-white hover:bg-zinc-100 disabled:opacity-50"
            disabled={isFetching}
          >{isFetching ? "Refreshing…" : "Refresh"}</button>
        </div>
      </div>

      {isLoading && <div className="text-zinc-500">Loading…</div>}
      {error && <div className="text-red-600 text-sm">{String((error as Error).message)}</div>}

      {data && (
        <ul className="divide-y rounded border bg-white text-sm font-mono">
          {data.items.length === 0 && (
            <li className="px-4 py-6 text-zinc-500 text-sm">No log entries match the filter.</li>
          )}
          {data.items.map((entry) => <LogRow key={entry.id} entry={entry} />)}
        </ul>
      )}
    </div>
  );
}

function LogRow({ entry }: { entry: SyncLogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const hasContext = entry.context !== null && entry.context !== undefined;
  const levelClass =
    entry.level === "error" ? "bg-red-50 text-red-900 border-l-4 border-red-500" :
    entry.level === "warn"  ? "bg-amber-50 text-amber-900 border-l-4 border-amber-400" :
    "bg-white text-zinc-800 border-l-4 border-transparent";

  return (
    <li className={`px-3 py-1.5 ${levelClass}`}>
      <div
        className={`flex items-baseline gap-3 ${hasContext ? "cursor-pointer hover:bg-black/[0.03]" : ""}`}
        onClick={() => hasContext && setExpanded((e) => !e)}
      >
        <span className="text-xs text-zinc-500 whitespace-nowrap">
          {new Date(entry.ts).toLocaleString(undefined, { hour12: false })}
        </span>
        <span className={`text-xs uppercase font-bold whitespace-nowrap ${
          entry.level === "error" ? "text-red-700" :
          entry.level === "warn"  ? "text-amber-700" : "text-zinc-500"
        }`}>{entry.level}</span>
        <span className="text-xs text-blue-700 whitespace-nowrap">{entry.event}</span>
        <span className="flex-1 break-all">{entry.message}</span>
        {hasContext && <span className="text-xs text-zinc-400">{expanded ? "▾" : "▸"}</span>}
      </div>
      {hasContext && expanded && (
        <pre className="ml-[10ch] mt-1 text-xs bg-zinc-50 border rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
          {JSON.stringify(entry.context, null, 2)}
        </pre>
      )}
    </li>
  );
}
