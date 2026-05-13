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
  (id,  repo_id, number, state,    draft, merged, mergeable, mergeable_state, title,
   author_id, head_ref, head_sha,  base_ref, base_sha,
   created_at,    updated_at)
VALUES
  -- "Ready for review" section, sorted top-to-bottom by review priority:

  -- Priority 0 — Quick + Exhaustive passed, mergeable=true (green box, CI-ready):
  (101, 1, 1001, 'open',   0, 0, 1,    'clean',   'CI-green and mergeable: add feature X', 1001, 'feat-x',  'sha-101', 'main', 'main-sha', 1700000000000, 1700000900000),
  (107, 1, 1007, 'open',   0, 0, 1,    'clean',   'CI-green: tidy typo',                   1003, 'typo',    'sha-107', 'main', 'main-sha', 1700000000000, 1700000850000),
  (113, 1, 1013, 'open',   0, 0, NULL, 'unknown', 'CI-green, mergeable unknown (still computing)', 1002, 'pending', 'sha-113', 'main', 'main-sha', 1700000000000, 1700000825000),

  -- Priority 1 — Quick + Exhaustive passed BUT merge conflict (amber box):
  (114, 1, 1014, 'open',   0, 0, 0,    'dirty',   'CI-green but conflicts with main — rebase needed', 1001, 'conflict', 'sha-114', 'main', 'main-sha', 1700000000000, 1700000810000),
  (115, 1, 1015, 'open',   0, 0, 0,    'dirty',   'Another CI-green merge conflict',       1003, 'conflict-2', 'sha-115', 'main', 'main-sha', 1700000000000, 1700000805000),

  -- Priority 2 — Quick passed, exhaustive running:
  (108, 1, 1008, 'open',   0, 0, 1,    'clean',   'New backend pass — exhaustive in flight',
                                                                1001, 'pass-y',  'sha-108', 'main', 'main-sha', 1700000000000, 1700000800000),

  -- Priority 3 — Quick passed, exhaustive queued:
  (109, 1, 1009, 'open',   0, 0, 1,    'clean',   'Quick green; exhaustive queued', 1002, 'q-2',    'sha-109', 'main', 'main-sha', 1700000000000, 1700000750000),

  -- Priority 4 — Quick passed, exhaustive skipped:
  (103, 1, 1003, 'open',   0, 0, 0,    'dirty',   'Skips exhaustive + has conflicts', 1001, 'bug-z', 'sha-103', 'main', 'main-sha', 1700000000000, 1700000700000),

  -- Priority 6 — Quick passed, exhaustive failed (one to fix):
  (110, 1, 1010, 'open',   0, 0, 1,    'unstable','Exhaustive regressed; quick still green',
                                                                1003, 'reg',     'sha-110', 'main', 'main-sha', 1700000000000, 1700000650000),

  -- Priority 10 — Quick running:
  (102, 1, 1002, 'open',   0, 0, NULL, 'unknown', 'Quick still running; mergeable computing', 1002, 'wip-y',   'sha-102', 'main', 'main-sha', 1700000000000, 1700000600000),

  -- Priority 20 — Quick queued / not run:
  (105, 1, 1005, 'open',   0, 0, 1,    'clean',   'Just pushed; quick queued',   1003, 'await-t', 'sha-105', 'main', 'main-sha', 1700000000000, 1700000500000),
  (106, 1, 1006, 'open',   0, 0, 0,    'dirty',   'No CI rows yet + has conflicts', 1003, 'no-ci',   'sha-106', 'main', 'main-sha', 1700000000000, 1700000450000),

  -- Priority 30 — Quick failed (needs attention):
  (104, 1, 1004, 'open',   0, 0, 1,    'unstable','Quick failed: regression',    1002, 'ab-c',    'sha-104', 'main', 'main-sha', 1700000000000, 1700000400000),

  -- "Draft" section:
  (111, 1, 1011, 'open',   1, 0, 1,    'clean',   'Draft: refactor Y',           1002, 'draft-y', 'sha-111', 'main', 'main-sha', 1700000000000, 1700000300000),
  (112, 1, 1012, 'open',   1, 0, NULL, 'unknown', 'Draft: exploring approach Z', 1001, 'draft-z', 'sha-112', 'main', 'main-sha', 1700000000000, 1700000200000);

