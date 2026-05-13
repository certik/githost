-- Operational log for the autonomous server-side resync chain. Each batch run
-- writes one or more rows here so we can debug drift / missed webhooks from
-- inside the app (see the /logs UI page).
--
-- Lives in APP_DB because mirror is regenerable but the operational history
-- is something we want to keep around even if we wipe the mirror.
--
-- Retention: code in src/lib/sync-log.ts caps to 1000 most-recent rows.

CREATE TABLE sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,              -- epoch ms
  level TEXT NOT NULL,              -- 'info' | 'warn' | 'error'
  event TEXT NOT NULL,              -- e.g. 'sync.batch.start', 'sync.batch.done', 'sync.batch.error', 'sync.pr.error'
  message TEXT NOT NULL,            -- human-readable summary
  context TEXT                      -- JSON blob with structured fields (page, processed, skipped, prNumber, error stack, ...)
);

CREATE INDEX sync_log_ts_idx ON sync_log(ts DESC);
CREATE INDEX sync_log_level_idx ON sync_log(level);
