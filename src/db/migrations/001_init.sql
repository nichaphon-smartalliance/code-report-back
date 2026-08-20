-- 001_init.sql — SPEC-001 "Data Model", verbatim.
--
-- report_jobs has NO column for the personal access token, and never will.
-- A migration that adds one is a REQ-001 §11 violation (SPEC-001 "Data Model").

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text NOT NULL UNIQUE,
  password_hash text NOT NULL,          -- argon2id
  display_name  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE report_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id),
  repo_url      text NOT NULL,
  branch        text,
  author_filter text,
  date_from     date NOT NULL,
  date_to       date NOT NULL,
  language      text NOT NULL CHECK (language IN ('th','en')),
  extra_context text,
  status        text NOT NULL,          -- QUEUED|RUNNING|DONE|NO_COMMITS|FAILED
  stage         text,
  commit_count  integer,
  report_md     text,
  error_code    text,
  error_message text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
CREATE INDEX report_jobs_user_created_idx ON report_jobs (user_id, created_at DESC);
