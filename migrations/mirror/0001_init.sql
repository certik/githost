-- Mirror DB — initial schema. See src/db/mirror/schema.ts for the Drizzle definition.
-- Forward-only. Never edit after applying to remote. Add a new numbered migration instead.

CREATE TABLE repo (
  id                  INTEGER PRIMARY KEY,
  owner               TEXT    NOT NULL,
  name                TEXT    NOT NULL,
  default_branch      TEXT,
  etag                TEXT,
  last_full_sync_at   INTEGER
);
CREATE UNIQUE INDEX repo_owner_name_idx ON repo(owner, name);

CREATE TABLE user (
  id          INTEGER PRIMARY KEY,
  login       TEXT    NOT NULL,
  avatar_url  TEXT,
  html_url    TEXT,
  is_bot      INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX user_login_idx ON user(login);

CREATE TABLE pr (
  id          INTEGER PRIMARY KEY,
  repo_id     INTEGER NOT NULL REFERENCES repo(id),
  number      INTEGER NOT NULL,
  state       TEXT    NOT NULL,
  draft       INTEGER NOT NULL DEFAULT 0,
  merged      INTEGER NOT NULL DEFAULT 0,
  title       TEXT    NOT NULL,
  body        TEXT,
  author_id   INTEGER REFERENCES user(id),
  head_ref    TEXT,
  head_sha    TEXT,
  base_ref    TEXT,
  base_sha    TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  closed_at   INTEGER,
  merged_at   INTEGER,
  raw_json    TEXT
);
CREATE UNIQUE INDEX pr_repo_number_idx ON pr(repo_id, number);
CREATE INDEX pr_updated_idx ON pr(updated_at);
CREATE INDEX pr_state_idx   ON pr(state);

CREATE TABLE issue (
  id          INTEGER PRIMARY KEY,
  repo_id     INTEGER NOT NULL REFERENCES repo(id),
  number      INTEGER NOT NULL,
  state       TEXT    NOT NULL,
  title       TEXT    NOT NULL,
  body        TEXT,
  author_id   INTEGER REFERENCES user(id),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  closed_at   INTEGER,
  raw_json    TEXT
);
CREATE UNIQUE INDEX issue_repo_number_idx ON issue(repo_id, number);
CREATE INDEX issue_updated_idx ON issue(updated_at);

CREATE TABLE comment (
  id          INTEGER PRIMARY KEY,
  repo_id     INTEGER NOT NULL REFERENCES repo(id),
  kind        TEXT    NOT NULL,           -- 'issue' | 'review' | 'review_comment'
  pr_id       INTEGER REFERENCES pr(id),
  issue_id    INTEGER REFERENCES issue(id),
  author_id   INTEGER REFERENCES user(id),
  body        TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  raw_json    TEXT
);
CREATE INDEX comment_pr_idx    ON comment(pr_id);
CREATE INDEX comment_issue_idx ON comment(issue_id);

CREATE TABLE label_upstream (
  pr_id  INTEGER NOT NULL REFERENCES pr(id) ON DELETE CASCADE,
  name   TEXT    NOT NULL,
  color  TEXT,
  PRIMARY KEY (pr_id, name)
);

CREATE TABLE sync_cursor (
  kind        TEXT    PRIMARY KEY,
  value       TEXT    NOT NULL,
  updated_at  INTEGER NOT NULL
);
