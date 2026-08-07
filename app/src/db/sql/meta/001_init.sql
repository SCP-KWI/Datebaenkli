-- Datebänkli — meta database schema.
--
-- Application state only. No student data lives here; student tables live in
-- their own schemas in the `datebaenkli` database. Student and teacher
-- Postgres roles have no CONNECT privilege on this database at all.

-- --- enums -------------------------------------------------------------------

CREATE TYPE app_role AS ENUM ('admin', 'teacher', 'student');

-- active   : normal
-- archived : auto after 1 year idle — NOLOGIN, schema kept read-only, restorable
-- cold     : admin-triggered — dumped to /mnt/bulk, schema dropped, restorable
-- deleted  : teacher-triggered only, never automatic; row kept for audit
CREATE TYPE user_state AS ENUM ('active', 'archived', 'cold', 'deleted');

CREATE TYPE class_state AS ENUM ('active', 'archived');

-- how a submitted query's result is compared to the reference solution (v2)
CREATE TYPE compare_mode AS ENUM ('exact', 'unordered', 'column_subset');

-- --- users -------------------------------------------------------------------

CREATE TABLE app_user (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username             text        NOT NULL,
  display_name         text        NOT NULL,
  role                 app_role    NOT NULL,
  state                user_state  NOT NULL DEFAULT 'active',
  locale               text        NOT NULL DEFAULT 'de',

  -- app login (scrypt, see src/auth/password.ts)
  password_hash        text        NOT NULL,
  must_change_password boolean     NOT NULL DEFAULT false,

  -- Postgres side. NULL for admins, who have no teaching schema.
  -- pg_role doubles as the schema name (architecture §2), which is what makes
  -- Postgres's default search_path ("$user", public) work with no setup.
  pg_role              text,
  pg_password_enc      text,        -- AES-256-GCM, base64, key = DBK_ENCRYPTION_KEY

  created_by           bigint      REFERENCES app_user(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  last_login_at        timestamptz,
  last_active_at       timestamptz,
  archived_at          timestamptz,

  CONSTRAINT app_user_locale_ck CHECK (locale IN ('de', 'en')),
  -- Admins never get a Postgres role; everyone else must have one.
  CONSTRAINT app_user_pg_role_ck CHECK (
    (role = 'admin' AND pg_role IS NULL) OR (role <> 'admin' AND pg_role IS NOT NULL)
  )
);

-- Usernames are reusable after deletion, so uniqueness applies to live rows only.
CREATE UNIQUE INDEX app_user_username_key
  ON app_user (lower(username)) WHERE state <> 'deleted';
CREATE UNIQUE INDEX app_user_pg_role_key
  ON app_user (pg_role) WHERE pg_role IS NOT NULL AND state <> 'deleted';
CREATE INDEX app_user_role_state_idx ON app_user (role, state);
CREATE INDEX app_user_last_active_idx ON app_user (last_active_at)
  WHERE state = 'active';

-- --- classes -----------------------------------------------------------------

CREATE TABLE class (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- short slug used when building schema names, e.g. 'k3a' -> u_k3a_muster_lena
  code        text        NOT NULL,
  name        text        NOT NULL,
  school_year text,
  teacher_id  bigint      NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  state       class_state NOT NULL DEFAULT 'active',
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT class_code_ck CHECK (code ~ '^[a-z0-9]{2,12}$')
);

CREATE UNIQUE INDEX class_code_key ON class (lower(code));
CREATE INDEX class_teacher_idx ON class (teacher_id) WHERE state = 'active';

-- A student may sit in more than one class (two subjects, two teachers), so
-- this is many-to-many. Every teacher of every class a student belongs to gets
-- the read-only grant on that student's schema.
CREATE TABLE class_member (
  class_id  bigint      NOT NULL REFERENCES class(id) ON DELETE CASCADE,
  user_id   bigint      NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (class_id, user_id)
);

CREATE INDEX class_member_user_idx ON class_member (user_id);

-- --- sessions ----------------------------------------------------------------

CREATE TABLE session (
  id         text        PRIMARY KEY,           -- random 32 bytes, base64url
  user_id    bigint      NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ip         inet,
  user_agent text
);

CREATE INDEX session_user_idx ON session (user_id);
CREATE INDEX session_expires_idx ON session (expires_at);

-- --- query log ---------------------------------------------------------------

-- Every execution, successful or not. Powers the teacher's live lesson view and
-- becomes the submission trail for v2 exercises.
CREATE TABLE query_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       bigint      NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  sql_text      text        NOT NULL,
  duration_ms   integer,
  row_count     integer,
  error_code    text,        -- SQLSTATE, drives the localised hint layer (§8a)
  error_message text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX query_log_user_time_idx ON query_log (user_id, created_at DESC);
CREATE INDEX query_log_time_idx ON query_log (created_at DESC);
CREATE INDEX query_log_errors_idx ON query_log (error_code, created_at DESC)
  WHERE error_code IS NOT NULL;

-- --- exercises (v2 — schema in place from the start) -------------------------

CREATE TABLE exercise (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  teacher_id   bigint       NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  title        text         NOT NULL,
  task_md      text         NOT NULL DEFAULT '',
  setup_sql    text,
  solution_sql text,
  compare      compare_mode NOT NULL DEFAULT 'unordered',
  published    boolean      NOT NULL DEFAULT false,
  created_at   timestamptz  NOT NULL DEFAULT now(),
  updated_at   timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX exercise_teacher_idx ON exercise (teacher_id);

CREATE TABLE exercise_assignment (
  exercise_id bigint      NOT NULL REFERENCES exercise(id) ON DELETE CASCADE,
  class_id    bigint      NOT NULL REFERENCES class(id) ON DELETE CASCADE,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  due_at      timestamptz,
  PRIMARY KEY (exercise_id, class_id)
);

CREATE TABLE submission (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  exercise_id bigint      NOT NULL REFERENCES exercise(id) ON DELETE CASCADE,
  user_id     bigint      NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  sql_text    text        NOT NULL,
  passed      boolean,
  detail      jsonb,       -- diff / mismatch explanation
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX submission_exercise_user_idx ON submission (exercise_id, user_id, created_at DESC);

-- --- audit -------------------------------------------------------------------

-- Destructive and administrative actions: who removed which student, who reset
-- whose schema, who created a teacher. Append-only.
CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id    bigint      REFERENCES app_user(id) ON DELETE SET NULL,
  action      text        NOT NULL,
  target_type text,
  target_id   text,
  detail      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_time_idx ON audit_log (created_at DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_id, created_at DESC);

-- --- settings ----------------------------------------------------------------

CREATE TABLE setting (
  key        text        PRIMARY KEY,
  value      jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO setting (key, value) VALUES
  ('archive_after_days', '365'::jsonb),
  ('query_log_retention_days', '400'::jsonb);
