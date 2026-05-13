-- Local-dev seed data for the mirror DB.
-- Run via `npm run dev:seed` (which calls `wrangler d1 execute … --local`).
--
-- Fixtures cover every PR-state badge the UI renders:
--   - Open + draft        → "Draft"
--   - Open + ready        → "Ready for review"
--   - Closed + merged     → "Merged"
--   - Closed + not merged → "Closed"
-- and every test-status combination (see scripts/seed-app.sql).

INSERT OR REPLACE INTO repo (id, owner, name, default_branch)
VALUES (1, 'lfortran', 'lfortran', 'main');

INSERT OR REPLACE INTO user (id, login, avatar_url, html_url, is_bot) VALUES
  (1001, 'alice',     NULL, 'https://github.com/alice',     0),
  (1002, 'bob',       NULL, 'https://github.com/bob',       0),
  (1003, 'carol',     NULL, 'https://github.com/carol',     0);

INSERT OR REPLACE INTO pr
  (id,  repo_id, number, state,    draft, merged, title,
   author_id, head_ref, head_sha,  base_ref, base_sha,
   created_at,    updated_at)
VALUES
  (101, 1, 1001, 'open',   0, 0, 'Add feature X',           1001, 'feat-x',  'sha-101', 'main', 'main-sha', 1700000000000, 1700000900000),
  (102, 1, 1002, 'open',   1, 0, 'WIP: refactor Y',         1002, 'wip-y',   'sha-102', 'main', 'main-sha', 1700000000000, 1700000800000),
  (103, 1, 1003, 'closed', 0, 1, 'Fix bug Z',               1001, 'bug-z',   'sha-103', 'main', 'main-sha', 1700000000000, 1700000700000),
  (104, 1, 1004, 'closed', 0, 0, 'Abandoned change',        1002, 'ab-c',    'sha-104', 'main', 'main-sha', 1700000000000, 1700000600000),
  (105, 1, 1005, 'open',   0, 0, 'Awaiting tests',          1003, 'await-t', 'sha-105', 'main', 'main-sha', 1700000000000, 1700000500000),
  (106, 1, 1006, 'open',   0, 0, 'All four states demoed',  1003, 'demo',    'sha-106', 'main', 'main-sha', 1700000000000, 1700000400000);
