-- Local-dev seed data for the app DB.
-- Run via `npm run dev:seed` (which calls `wrangler d1 execute … --local`).
--
-- Sets up pr_test_run rows covering every possible color for every PR in
-- scripts/seed-mirror.sql. The UI should render one row per PR with the
-- expected (Quick, Exhaustive) dot colors.

INSERT OR REPLACE INTO pr_test_run
  (pr_id, kind,         status,    head_sha,   log_url,                      updated_at)
VALUES
  -- PR #1001 "Add feature X": quick passed, exhaustive failed
  (101,   'quick',      'passed',  'sha-101',  'https://example.com/log/1q', 1700000000000),
  (101,   'exhaustive', 'failed',  'sha-101',  'https://example.com/log/1e', 1700000000000),
  -- PR #1002 "WIP refactor Y" (draft): quick running, exhaustive queued
  (102,   'quick',      'running', 'sha-102',  NULL,                         1700000000000),
  (102,   'exhaustive', 'queued',  'sha-102',  NULL,                         1700000000000),
  -- PR #1003 "Fix bug Z" (merged): both passed
  (103,   'quick',      'passed',  'sha-103',  NULL,                         1700000000000),
  (103,   'exhaustive', 'passed',  'sha-103',  NULL,                         1700000000000),
  -- PR #1004 (closed): quick failed, no exhaustive row → empty ring
  (104,   'quick',      'failed',  'sha-104',  'https://example.com/log/4q', 1700000000000),
  -- PR #1005 (open, awaiting): both queued
  (105,   'quick',      'queued',  'sha-105',  NULL,                         1700000000000),
  (105,   'exhaustive', 'queued',  'sha-105',  NULL,                         1700000000000);
  -- PR #1006 has no test-run rows → both columns show empty rings.
