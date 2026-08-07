-- Phase 9 — exercises (Übungen).
--
-- 001 shipped a stub for this feature, sketched from ARCHITECTURE §5 long before
-- anyone tried to build it. Three of its columns describe a design that was not
-- chosen, so this migration removes them before adding anything: an unused
-- column with no writer and no UI is the decoy §3 warns about, and 002 already
-- set the precedent by deleting the `archive_after_days` setting row.

-- --- what was dropped, and why ----------------------------------------------
--
-- `solution_sql` + `compare` were auto-grading: the student's query and a
-- reference query run in one transaction, result sets diffed, ✅ or a
-- side-by-side. It is a coherent feature and it is not this one. What was asked
-- for is that the teacher *reads* the hand-ins — which is a different product
-- decision, not a cheaper version of the same one, because the exercises this is
-- for ("build a schema for a lending library") have no single reference result
-- to diff against. Re-addable later as its own phase, with its own columns.
--
-- `published` was a global draft flag. `exercise_assignment` answers the same
-- question better and per class: an exercise is out there if it has been
-- distributed to someone.
--
-- `setup_sql` is superseded by `exercise_source` below, which is the same idea
-- with an ordering and a per-table identity, so the teacher's page can say
-- "delete the kunden table" instead of "edit this 4000-line textarea".
ALTER TABLE exercise DROP COLUMN solution_sql;
ALTER TABLE exercise DROP COLUMN compare;
ALTER TABLE exercise DROP COLUMN published;
ALTER TABLE exercise DROP COLUMN setup_sql;

DROP TYPE compare_mode;

-- --- how an exercise's tables are described ----------------------------------
--
-- One row per table (or per script) the teacher adds, replayed in order into
-- every student's own copy.
--
-- **A CSV source stores the CSV, not generated SQL.** Storing
-- `INSERT INTO kunden VALUES ('Müller', ...)` text would be this application
-- building *data* by string concatenation, which services/import.ts's header
-- rejects in as many words — and it would do it in the one place the values come
-- from a file nobody has validated. Keeping the CSV means materialisation runs
-- the existing import path, where every value is a `$n` parameter, and it means
-- the teacher can still see the file they uploaded.
--
-- `csv_spec` is the confirmed column list — `[{name, type}]`, the same shape and
-- the same seven types the student-facing import dialog produces. It is stored
-- rather than re-inferred so that a fixture cannot change shape between the
-- teacher confirming it and the twenty-fifth student opening it.
CREATE TYPE exercise_source_kind AS ENUM ('sql', 'csv');

CREATE TABLE exercise_source (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  exercise_id bigint               NOT NULL REFERENCES exercise(id) ON DELETE CASCADE,
  -- Not unique per exercise, deliberately: a unique (exercise_id, position)
  -- turns "move this table up" into a deferred-constraint dance for no gain.
  -- Ties break on id, so the order is total either way.
  position    integer              NOT NULL DEFAULT 0,
  kind        exercise_source_kind NOT NULL,
  -- What the teacher calls it in the list. For a CSV that is the table name; for
  -- a script it is whatever they typed, because a script may create three tables.
  label       text                 NOT NULL,

  sql_text    text,
  csv_text    text,
  csv_spec    jsonb,
  -- Shown in the teacher's list so a collapsed CSV row still says how big it is.
  row_count   integer,

  created_at  timestamptz          NOT NULL DEFAULT now(),

  CONSTRAINT exercise_source_payload_ck CHECK (
    (kind = 'sql' AND sql_text IS NOT NULL AND csv_text IS NULL AND csv_spec IS NULL)
    OR
    (kind = 'csv' AND csv_text IS NOT NULL AND csv_spec IS NOT NULL AND sql_text IS NULL)
  )
);

CREATE INDEX exercise_source_order_idx ON exercise_source (exercise_id, position, id);

-- --- which schema is whose ---------------------------------------------------
--
-- Every student gets their own schema per exercise, owned by them, so that
-- isolation is the same Postgres-enforced thing it is everywhere else and
-- "reset this exercise" is `DROP SCHEMA` rather than a prefix match over table
-- names.
--
-- **The name is stored, not derived.** `x<exercise_id>_<pg_role>` is the recipe,
-- but it has to be clamped to Postgres's 63 bytes, and two students with long
-- enough names clamp to the same string. Deriving it at each call site would
-- make that collision resolve to *one schema shared by two students*, which is
-- an isolation break rather than a cosmetic bug. Allocating once and writing it
-- down — under a unique index, with auth/identifiers.ts's `withSuffix` breaking
-- the tie — is exactly how `app_user.pg_role` already works.
--
-- **There is no `materialised_at` column**, and that is §3's rule rather than an
-- omission: `pg_namespace` answers whether the schema exists, so a timestamp
-- here would be a second answer that can disagree. This row means "this student
-- has a name reserved for this exercise", nothing more, which is the part
-- Postgres genuinely cannot answer.
CREATE TABLE exercise_workspace (
  exercise_id bigint      NOT NULL REFERENCES exercise(id) ON DELETE CASCADE,
  user_id     bigint      NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  schema_name text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (exercise_id, user_id),

  -- The same allow-list as db/ident.ts's `assertWorkspaceSchema`, restated here
  -- for the same reason that file gives for checking *and* quoting: the cost is
  -- a regex and the failure mode is a string reaching `DROP SCHEMA`. The leading
  -- `x` is the load-bearing part — it cannot match the `^[ut]_` a role name must
  -- have, so a workspace name can never be mistaken for a role.
  CONSTRAINT exercise_workspace_name_ck CHECK (schema_name ~ '^x[0-9]+_[a-z0-9_]{1,58}$')
);

CREATE UNIQUE INDEX exercise_workspace_schema_key ON exercise_workspace (schema_name);
CREATE INDEX exercise_workspace_user_idx ON exercise_workspace (user_id);

-- --- hand-ins ----------------------------------------------------------------
--
-- `passed` and `detail` belonged to the auto-grading design dropped above.
-- `note` is what replaces them: the student says what they tried, in prose.
ALTER TABLE submission DROP COLUMN passed;
ALTER TABLE submission DROP COLUMN detail;
ALTER TABLE submission ADD COLUMN note text;

-- Multiple hand-ins per student are the point, so they are numbered rather than
-- merely ordered. The number is what the download filename says and what the
-- teacher refers to out loud ("schau dir Abgabe 2 an"), so it has to be stable —
-- and the unique index is what makes two simultaneous submits fail loudly
-- instead of producing two rows both calling themselves attempt 3.
ALTER TABLE submission ADD COLUMN attempt integer NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX submission_attempt_key ON submission (exercise_id, user_id, attempt);

-- --- the lesson view -------------------------------------------------------
--
-- Which exercise a statement was run against, so phase 4's live view can say
-- "Lena is on Übung 3" rather than showing a `SELECT` with no context. NULL for
-- everything run in the student's own playground, which is most of it.
--
-- ON DELETE SET NULL, not CASCADE: deleting an exercise must not delete the
-- record that a student ran anything. `query_log` is a trail.
ALTER TABLE query_log ADD COLUMN exercise_id bigint REFERENCES exercise(id) ON DELETE SET NULL;
