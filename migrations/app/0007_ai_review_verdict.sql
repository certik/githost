-- Local AI review verdict (GitHub-style event).
-- APPROVE | COMMENT | REQUEST_CHANGES. Null for rows created before this column.
ALTER TABLE ai_review ADD COLUMN verdict TEXT;
