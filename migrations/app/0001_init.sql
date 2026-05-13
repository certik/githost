-- App DB — initial schema. See src/db/app/schema.ts for the Drizzle definition.
-- Holds irreplaceable, locally-authored data. Soft-delete via `deleted_at`.
-- Forward-only. Never edit after applying to remote.

CREATE TABLE app_user (
  id          TEXT PRIMARY KEY,
  gh_user_id  INTEGER NOT NULL,
  login       TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX app_user_gh_idx ON app_user(gh_user_id);

CREATE TABLE user_session (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  user_agent  TEXT
);
CREATE INDEX user_session_user_idx ON user_session(user_id);
CREATE INDEX user_session_exp_idx  ON user_session(expires_at);

CREATE TABLE oauth_token (
  user_id     TEXT PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  ciphertext  TEXT NOT NULL,
  iv          TEXT NOT NULL,
  scope       TEXT,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE ai_review (
  id                    TEXT PRIMARY KEY,
  repo_id               INTEGER NOT NULL,
  pr_id                 INTEGER NOT NULL,
  pr_number             INTEGER NOT NULL,
  head_sha              TEXT    NOT NULL,
  model                 TEXT    NOT NULL,
  status                TEXT    NOT NULL DEFAULT 'pending',
  summary               TEXT,
  comments_json         TEXT,
  error_message         TEXT,
  posted_upstream_at    INTEGER,
  upstream_review_id    INTEGER,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  deleted_at            INTEGER
);
CREATE INDEX ai_review_pr_idx     ON ai_review(pr_id);
CREATE INDEX ai_review_sha_idx    ON ai_review(head_sha);
CREATE INDEX ai_review_status_idx ON ai_review(status);

CREATE TABLE label_local (
  id           TEXT PRIMARY KEY,
  repo_id      INTEGER NOT NULL,
  name         TEXT    NOT NULL,
  color        TEXT,
  description  TEXT,
  created_at   INTEGER NOT NULL,
  deleted_at   INTEGER
);
CREATE UNIQUE INDEX label_local_repo_name_idx ON label_local(repo_id, name);

CREATE TABLE pr_local_label (
  pr_id       INTEGER NOT NULL,
  label_id    TEXT    NOT NULL REFERENCES label_local(id) ON DELETE CASCADE,
  created_by  TEXT    REFERENCES app_user(id),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (pr_id, label_id)
);

CREATE TABLE saved_view (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  filter_json  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER
);
CREATE INDEX saved_view_user_idx ON saved_view(user_id);

CREATE TABLE audit_log (
  id           TEXT PRIMARY KEY,
  actor        TEXT NOT NULL,
  table_name   TEXT NOT NULL,
  row_id       TEXT NOT NULL,
  op           TEXT NOT NULL,
  before_json  TEXT,
  after_json   TEXT,
  ts           INTEGER NOT NULL
);
CREATE INDEX audit_log_table_row_idx ON audit_log(table_name, row_id);
CREATE INDEX audit_log_ts_idx        ON audit_log(ts);
