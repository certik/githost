-- Local-dev seed data for the app DB.
-- Run via `npm run dev:seed`.
--
-- Sets up pr_test_run rows that demonstrate every possible icon state.
-- The UI renders one icon per (PR, kind) cell:
--   not queued (no row) → empty gray ring
--   queued              → amber dot
--   running             → amber dot + spinning arc
--   passed              → green dot
--   failed              → red circle with white X
--   skipped             → gray slash circle

INSERT OR REPLACE INTO pr_test_run
  (pr_id, kind,         status,    head_sha,   log_url,                      updated_at)
VALUES
  -- PR #1001 "Add feature X": quick passed, exhaustive failed
  (101,   'quick',      'passed',  'sha-101',  'https://example.com/log/1q', 1700000000000),
  (101,   'exhaustive', 'failed',  'sha-101',  'https://example.com/log/1e', 1700000000000),
  -- PR #1002 "WIP refactor Y" (draft): quick running, exhaustive queued
  (102,   'quick',      'running', 'sha-102',  NULL,                         1700000000000),
  (102,   'exhaustive', 'queued',  'sha-102',  NULL,                         1700000000000),
  -- PR #1003 "Fix bug Z" (merged): quick passed, exhaustive skipped
  (103,   'quick',      'passed',  'sha-103',  NULL,                         1700000000000),
  (103,   'exhaustive', 'skipped', 'sha-103',  NULL,                         1700000000000),
  -- PR #1004 (closed): quick failed, no exhaustive row → empty ring
  (104,   'quick',      'failed',  'sha-104',  'https://example.com/log/4q', 1700000000000),
  -- PR #1005 (open, awaiting): both queued
  (105,   'quick',      'queued',  'sha-105',  NULL,                         1700000000000),
  (105,   'exhaustive', 'queued',  'sha-105',  NULL,                         1700000000000),
  -- PR #1006: quick skipped, exhaustive running (uncommon mix, demos icons)
  (106,   'quick',      'skipped', 'sha-106',  NULL,                         1700000000000),
  (106,   'exhaustive', 'running', 'sha-106',  NULL,                         1700000000000);

