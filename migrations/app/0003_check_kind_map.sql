-- Maps upstream GitHub check-run names to our "quick" / "exhaustive" buckets.
-- syncPr fetches /commits/:sha/check-runs after upserting a PR; mapCheckToKind
-- (src/lib/check-mapper.ts) consults this table to classify each check.
--
-- Highest `priority` wins when multiple patterns match. Defaults below seed
-- sensible buckets for lfortran/lfortran — edit via:
--   wrangler d1 execute githost-app --remote --command="INSERT INTO check_kind_map ..."
--
-- match_type:
--   "exact"   — pattern equals check name verbatim
--   "glob"    — `*` is the only wildcard, matches any substring

CREATE TABLE check_kind_map (
  id          TEXT PRIMARY KEY,                            -- UUID
  pattern     TEXT    NOT NULL,
  kind        TEXT    NOT NULL,                            -- "quick" | "exhaustive"
  match_type  TEXT    NOT NULL DEFAULT 'exact',            -- "exact" | "glob"
  priority    INTEGER NOT NULL DEFAULT 0,                  -- higher wins
  created_at  INTEGER NOT NULL
);
CREATE INDEX check_kind_map_kind_idx ON check_kind_map(kind);

-- Default mapping for lfortran/lfortran. Exact matches outrank globs by
-- priority so a single named-quick check is never accidentally captured by
-- the exhaustive glob.

INSERT INTO check_kind_map (id, pattern, kind, match_type, priority, created_at) VALUES
  ('seed-quick-1', 'LFortran CI (OS=ubuntu-latest, LLVM=11)', 'quick',      'exact', 100, 1700000000000),
  ('seed-quick-2', 'Test without LLVM Backend',               'quick',      'exact', 100, 1700000000000),
  ('seed-quick-3', 'Check Release build',                     'quick',      'exact', 100, 1700000000000),
  ('seed-exh-1',   'Test LLVM * (*)',                         'exhaustive', 'glob',   50, 1700000000000),
  ('seed-exh-2',   'LFortran CI (OS=*, LLVM=*)',              'exhaustive', 'glob',   40, 1700000000000);
