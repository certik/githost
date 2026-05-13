-- Replace the workflow-prefixed seed defaults with bare-name patterns
-- matching ONLY the two jobs in lfortran's Quick-Checks-CI.yml, plus a
-- wildcard catchall for "the rest".
--
-- Per the maintainer's rule: pattern-match Quick exactly; everything else
-- is Exhaustive. We do NOT fetch /actions/runs anymore — the bare
-- check_run.name from /commits/:sha/check-runs is enough.
--
-- Quick:
--   - "Build LFortran to WASM and Upload" (exact, the WASM build job)
--   - "LFortran CI (OS=*, LLVM=*)" (glob, the matrix job)
-- Exhaustive:
--   - "*" (glob, priority 1 — catches every other check_run.name)

DELETE FROM check_kind_map WHERE id LIKE 'seed-%';

INSERT INTO check_kind_map (id, pattern, kind, match_type, priority, created_at) VALUES
  ('seed-3-quick-wasm',     'Build LFortran to WASM and Upload', 'quick',      'exact', 100, 1700000000000),
  ('seed-3-quick-matrix',   'LFortran CI (OS=*, LLVM=*)',        'quick',      'glob',  100, 1700000000000),
  ('seed-3-exhaustive-all', '*',                                 'exhaustive', 'glob',    1, 1700000000000);
