-- Local-dev seed data for the app DB.
-- Run via `npm run dev:seed`.
--
-- Each row is keyed to a PR in scripts/seed-mirror.sql. We cover every cell
-- of the (quick × exhaustive) matrix so the Review priority view groups in
-- the expected order.

INSERT OR REPLACE INTO pr_test_run
  (pr_id, kind,         status,    head_sha,   log_url,                      updated_at)
VALUES
  -- Priority 0 (CI-green + mergeable, highlighted box)
  (101, 'quick',      'passed',  'sha-101', 'https://example.com/log/1q',  1700000000000),
  (101, 'exhaustive', 'passed',  'sha-101', 'https://example.com/log/1e',  1700000000000),
  (107, 'quick',      'passed',  'sha-107', NULL,                          1700000000000),
  (107, 'exhaustive', 'passed',  'sha-107', NULL,                          1700000000000),
  -- Also in priority 0: CI-green with mergeable=null (unknown, optimistic-green)
  (113, 'quick',      'passed',  'sha-113', NULL,                          1700000000000),
  (113, 'exhaustive', 'passed',  'sha-113', NULL,                          1700000000000),

  -- Priority 1 (CI-green BUT merge conflict, amber box)
  (114, 'quick',      'passed',  'sha-114', NULL,                          1700000000000),
  (114, 'exhaustive', 'passed',  'sha-114', NULL,                          1700000000000),
  (115, 'quick',      'passed',  'sha-115', NULL,                          1700000000000),
  (115, 'exhaustive', 'passed',  'sha-115', NULL,                          1700000000000),

  -- Priority 2: quick passed, exhaustive running
  (108, 'quick',      'passed',  'sha-108', NULL,                          1700000000000),
  (108, 'exhaustive', 'running', 'sha-108', NULL,                          1700000000000),

  -- Priority 3: quick passed, exhaustive queued
  (109, 'quick',      'passed',  'sha-109', NULL,                          1700000000000),
  (109, 'exhaustive', 'queued',  'sha-109', NULL,                          1700000000000),

  -- Priority 4: quick passed, exhaustive skipped
  (103, 'quick',      'passed',  'sha-103', NULL,                          1700000000000),
  (103, 'exhaustive', 'skipped', 'sha-103', NULL,                          1700000000000),

  -- Priority 6: quick passed, exhaustive failed
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

-- ---------------------------------------------------------------------------
-- Local AI / CLI reviews with inline comments (PR detail unified-diff UI).
-- Paths/lines match the stub diff returned for non-hex seed SHAs
-- (see GET /api/prs/:number/diff in src/routes/api.ts).
--
-- Browse: open PR #1001 while signed in → "AI reviews (local)" + comments
-- in the Diff section.
-- ---------------------------------------------------------------------------

INSERT OR REPLACE INTO ai_review
  (id, repo_id, pr_id, pr_number, head_sha, model, status, verdict, summary,
   comments_json, error_message, posted_upstream_at, upstream_review_id,
   created_at, updated_at, deleted_at)
VALUES
  (
    'seed-review-1001-claude',
    1,
    101,
    1001,
    'sha-101',
    'claude-opus',
    'ready',
    'REQUEST_CHANGES',
    'Seeded review for local UI demos. Inline notes are on README.md and src/example.f90.',
    '[
      {"path":"README.md","line":3,"body":"Nit: this line is only present in the local stub diff — good place to preview a single-line comment."},
      {"path":"src/example.f90","line":2,"body":"Prefer explicit kinds: `integer(4) :: n, m` (or whatever the project convention is)."},
      {"path":"src/example.f90","startLine":5,"line":7,"side":"RIGHT","body":"Multi-line note: this `if` is always true when `n >= 0`. Consider simplifying or documenting the invariant."}
    ]',
    NULL,
    NULL,
    NULL,
    1700001000000,
    1700001000000,
    NULL
  ),
  (
    'seed-review-1001-grok',
    1,
    101,
    1001,
    'sha-101',
    'grok',
    'ready',
    'COMMENT',
    'Second seeded review (same PR) so the list shows multiple agents. Latest wins for the list column.',
    '[
      {"path":"src/example.f90","line":4,"body":"Where does `n` get a value before `m = n + 1`? If it is undefined, this is a bug."},
      {"path":"README.md","line":5,"body":"Thanks for the demo note — once you have real SHAs, this stub disappears automatically."}
    ]',
    NULL,
    NULL,
    NULL,
    1700001100000,
    1700001100000,
    NULL
  ),
  (
    'seed-review-1007-human',
    1,
    107,
    1007,
    'sha-107',
    'human/alice',
    'ready',
    'APPROVE',
    'Light touch on the typo PR — one inline comment only.',
    '[
      {"path":"src/example.f90","line":6,"body":"Optional: use `write(*,*)` if this codebase prefers Fortran I/O style."}
    ]',
    NULL,
    NULL,
    NULL,
    1700001200000,
    1700001200000,
    NULL
  );

