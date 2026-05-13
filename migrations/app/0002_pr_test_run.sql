-- Per-PR test run status, set by an external CI runner via
-- PUT /api/prs/:number/tests/:kind.
--
-- Logical FK: pr_id references mirror.pr.id (cross-DB, not enforced).
-- One row per (pr_id, kind). New runs overwrite previous status.
-- For history, add a separate pr_test_run_history table later.

CREATE TABLE pr_test_run (
  pr_id        INTEGER NOT NULL,
  kind         TEXT    NOT NULL,            -- "quick" | "exhaustive"
  status       TEXT    NOT NULL,            -- "queued" | "running" | "passed" | "failed"
  head_sha     TEXT,                        -- commit SHA the run was triggered against
  started_at   INTEGER,
  finished_at  INTEGER,
  log_url      TEXT,                        -- optional link to CI run / log output
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (pr_id, kind)
);
CREATE INDEX pr_test_run_status_idx ON pr_test_run(status);
