-- Update the quick/exhaustive check-kind defaults to match against the
-- workflow-prefixed display name ("<workflow> / <check>") rather than the
-- bare check-run name.
--
-- Why: the GitHub UI shows "Quick checks / LFortran CI (OS=ubuntu-latest,
-- LLVM=11)" — "Quick checks" is the workflow name. The check-runs API
-- returns just "LFortran CI (OS=ubuntu-latest, LLVM=11)" as the name, but
-- syncPrChecks now also fetches /actions/runs and reconstructs the prefix.
-- A single workflow-name glob is enough to bucket every lfortran "Quick
-- checks" job into the quick bucket.
--
-- We REPLACE the seeds (id LIKE 'seed-%') from migration 0003. Any patterns
-- a user added with non-seed IDs are preserved.

DELETE FROM check_kind_map WHERE id LIKE 'seed-%';

INSERT INTO check_kind_map (id, pattern, kind, match_type, priority, created_at) VALUES
  ('seed-2-quick',      'Quick checks / *',      'quick',      'glob', 100, 1700000000000),
  ('seed-2-exhaustive', 'Exhaustive checks / *', 'exhaustive', 'glob', 100, 1700000000000),
  -- Catch the "Test LLVM N (...)" jobs in case lfortran also surfaces them
  -- outside the "Exhaustive checks" workflow.
  ('seed-2-llvm',       'Test LLVM * (*)',       'exhaustive', 'glob',  50, 1700000000000);
