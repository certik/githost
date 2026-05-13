-- Local-dev seed data for the app DB.
-- Run via `npm run dev:seed`.
--
-- Each row is keyed to a PR in scripts/seed-mirror.sql. We cover every cell
-- of the (quick × exhaustive) matrix so the Review priority view groups in
-- the expected order.

INSERT OR REPLACE INTO pr_test_run
  (pr_id, kind,         status,    head_sha,   log_url,                      updated_at)
VALUES
  -- Priority 0 (CI-green, highlighted box)
  (101, 'quick',      'passed',  'sha-101', 'https://example.com/log/1q',  1700000000000),
  (101, 'exhaustive', 'passed',  'sha-101', 'https://example.com/log/1e',  1700000000000),
  (107, 'quick',      'passed',  'sha-107', NULL,                          1700000000000),
  (107, 'exhaustive', 'passed',  'sha-107', NULL,                          1700000000000),

  -- Priority 1: quick passed, exhaustive running
  (108, 'quick',      'passed',  'sha-108', NULL,                          1700000000000),
  (108, 'exhaustive', 'running', 'sha-108', NULL,                          1700000000000),

  -- Priority 2: quick passed, exhaustive queued
  (109, 'quick',      'passed',  'sha-109', NULL,                          1700000000000),
  (109, 'exhaustive', 'queued',  'sha-109', NULL,                          1700000000000),

  -- Priority 3: quick passed, exhaustive skipped
  (103, 'quick',      'passed',  'sha-103', NULL,                          1700000000000),
  (103, 'exhaustive', 'skipped', 'sha-103', NULL,                          1700000000000),

  -- Priority 5: quick passed, exhaustive failed
  (110, 'quick',      'passed',  'sha-110', NULL,                          1700000000000),
  (110, 'exhaustive', 'failed',  'sha-110', 'https://example.com/log/exh', 1700000000000),

  -- Priority 10: quick running
  (102, 'quick',      'running', 'sha-102', NULL,                          1700000000000),

  -- Priority 20: quick queued
  (105, 'quick',      'queued',  'sha-105', NULL,                          1700000000000),
  -- PR 1006 has no rows at all → quick=null → still priority 20

  -- Priority 30: quick failed
  (104, 'quick',      'failed',  'sha-104', 'https://example.com/log/4q',  1700000000000),

  -- Drafts (any rows are fine; they sort to their own section)
  (111, 'quick',      'running', 'sha-111', NULL,                          1700000000000),
  (112, 'quick',      'passed',  'sha-112', NULL,                          1700000000000),
  (112, 'exhaustive', 'passed',  'sha-112', NULL,                          1700000000000);

