-- Add mergeable status from GitHub PR detail endpoint.
--
-- GitHub returns:
--   pr.mergeable: true | false | null  (null = still computing, common post-push)
--   pr.mergeable_state: "clean" | "dirty" | "unstable" | "behind" | "blocked" | "unknown" | "draft"
--
-- These are ONLY available on GET /pulls/:n (not the list endpoint), but we
-- already fetch that in syncPr so there's zero extra API cost.
--
-- We persist nullable mergeable directly (SQLite has no native bool — 0/1/NULL).
-- The "Quick+Exhaustive passed" highlight box in the UI excludes PRs where
-- mergeable IS FALSE, so reviewers only see truly-mergeable PRs in the top
-- slot.

ALTER TABLE pr ADD COLUMN mergeable INTEGER;
ALTER TABLE pr ADD COLUMN mergeable_state TEXT;
