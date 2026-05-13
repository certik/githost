/**
 * Maps a GitHub check-run name to one of our buckets ("quick" | "exhaustive")
 * using the `check_kind_map` configuration. Pure function — no DB access.
 *
 * Pattern semantics:
 *   - matchType "exact" — pattern === name (case-sensitive)
 *   - matchType "glob"  — `*` is the only wildcard, matches any substring;
 *                         every other character is matched literally
 *
 * Conflict resolution:
 *   - Highest `priority` wins.
 *   - Tie-break 1: exact match beats glob match (more specific).
 *   - Tie-break 2: shorter pattern wins (more specific within the same kind).
 *
 * Returns null if no mapping matches.
 */

export interface CheckMapping {
  pattern: string;
  kind: string;
  matchType: string;            // "exact" | "glob"
  priority: number;
}

export type CheckKind = "quick" | "exhaustive";

export function mapCheckToKind(name: string, mappings: readonly CheckMapping[]): CheckKind | null {
  let bestMatch: CheckMapping | null = null;
  for (const m of mappings) {
    if (!matches(m, name)) continue;
    if (!bestMatch || beats(m, bestMatch)) {
      bestMatch = m;
    }
  }
  if (!bestMatch) return null;
  if (bestMatch.kind === "quick" || bestMatch.kind === "exhaustive") return bestMatch.kind;
  return null;
}

/** Returns true if `a` should outrank `b`. */
function beats(a: CheckMapping, b: CheckMapping): boolean {
  if (a.priority !== b.priority) return a.priority > b.priority;
  // Same priority — exact match beats glob (it's strictly more specific).
  const aExact = a.matchType === "exact";
  const bExact = b.matchType === "exact";
  if (aExact !== bExact) return aExact;
  // Same priority + same match type — shorter pattern wins.
  return a.pattern.length < b.pattern.length;
}

function matches(m: CheckMapping, name: string): boolean {
  if (m.matchType === "exact") return m.pattern === name;
  if (m.matchType === "glob") return globToRegex(m.pattern).test(name);
  return false;
}

/** Convert a glob (* is the only wildcard) to a full-string regex. */
function globToRegex(glob: string): RegExp {
  const escaped = glob
    .split("*")
    .map((segment) => segment.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp("^" + escaped + "$");
}
