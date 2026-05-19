/**
 * Human-friendly relative-time formatter for the PR list.
 *
 * Returns strings like:
 *   "just now", "5m ago", "3h ago", "2d ago", "1w ago", "4mo ago", "2y ago"
 *
 * Boundaries (mirrors GitHub's PR list convention closely enough):
 *
 *   age          | output
 *   -------------|-----------------
 *   < 45s        | "just now"
 *   < 60m        | "Nm ago"
 *   < 24h        | "Nh ago"
 *   < 7d         | "Nd ago"
 *   < 30d        | "Nw ago"      (weeks rounded down)
 *   < 365d       | "Nmo ago"     (months ≈ 30d)
 *   ≥ 365d       | "Ny ago"      (years ≈ 365d)
 *
 * `then` and `now` are in milliseconds since the epoch. `now` is injectable
 * so unit tests can pin the clock; production callers omit it and we use
 * `Date.now()`.
 *
 * Negative deltas (then > now) are clamped to 0 so a slightly skewed
 * client clock shows "just now" instead of "in the future".
 */
export function formatRelativeTime(then: number, now: number = Date.now()): string {
  const deltaMs = Math.max(0, now - then);
  const sec = Math.floor(deltaMs / 1000);

  if (sec < 45) return "just now";

  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;

  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;

  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;

  if (day < 30) return `${Math.floor(day / 7)}w ago`;

  if (day < 365) return `${Math.floor(day / 30)}mo ago`;

  return `${Math.floor(day / 365)}y ago`;
}

/**
 * ISO-ish absolute timestamp for the title/tooltip attribute. Local time so
 * the user sees the wall-clock they expect, but kept short.
 */
export function formatAbsoluteTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
