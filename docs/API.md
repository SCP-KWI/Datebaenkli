# Datebänkli — HTTP API

Everything under `/api` speaks JSON and authenticates with a session cookie
(`dbk_sid`, httpOnly, signed, SameSite=Lax). Errors always have the same shape:

```json
{ "error": { "code": "not_your_class", "message": "That class belongs to another teacher." } }
```

`code` is stable and machine-readable — branch on it, and key the German strings
off it when the i18n layer lands (architecture §8a). `message` is an English
developer fallback, never something a student should be shown.

## Rules that apply to every route

- **Closed by default.** A route is reachable without a session only if it is
  explicitly marked public. That is eleven of them, and the complete list is
  worth having here because *this list is the assertion* — an incomplete one is
  exactly what a reviewer would trust: the six pages `/`, `/login`, `/password`,
  `/sql`, `/lesson`, `/roster`; the two asset routes `/assets/:file` and
  `/assets/fonts/:file`; and `/health`, `POST /api/login`, `POST /api/logout`,
  `GET /api/version`.

  The pages are public on purpose: they are program text, not data, and every
  action they offer goes through an `/api` route that enforces the real rules.
  A page's *script* especially — gate it and the code that would redirect an
  expired session to `/login` never runs, so the user gets a dead shell.
- **Every state-changing call must send `Content-Type: application/json`**, even
  the ones that take no body — `415 json_required` otherwise. This is the CSRF
  control. `application/json` is not CORS-safelisted, so a cross-origin request
  carrying it needs a preflight, which we answer for nobody; without the rule, a
  plain `<form>` or a bare `fetch(url, {method:'POST'})` from any sibling app on
  the same registrable domain would fire with the session cookie attached,
  because SameSite=Lax considers subdomains same-site. An empty body is read as
  `{}`, so body-less routes need no payload.
- **The password gate outranks everything.** While `mustChangePassword` is set,
  every route except `GET /api/me`, `POST /api/me/password`,
  `POST /api/me/sessions/revoke` and `POST /api/logout` returns
  `403 password_change_required`.
- **Sessions roll.** A session past half its life is extended on use, so an
  active lesson never times out; an idle one expires and is swept.
- **A password change ends every session**, including the caller's — the caller
  is issued a fresh one in the same response. Same for an admin- or
  teacher-initiated reset, and for any state change away from `active`.

## Roles

| | admin | teacher | student |
|---|---|---|---|
| Teachers CRUD | ✅ | — | — |
| Classes | all | own only | — |
| Students | all | those in their own classes | — |
| Own profile & password | ✅ | ✅ | ✅ |

"Their own" is checked on every route by id, not by filtering lists — a teacher
who guesses another teacher's class id gets `403 not_your_class`.

## Session

| Method | Path | Who | Notes |
|---|---|---|---|
| `POST` | `/api/login` | public | `{username, password}` → `{user}`. Rate-limited: 10 failures per account and 60 per IP per 15 min, then `429` with `Retry-After`. Wrong password, unknown user and archived account are indistinguishable. |
| `POST` | `/api/logout` | public | Idempotent; always clears the cookie. |
| `GET` | `/api/me` | any | `{user}` |
| `PATCH` | `/api/me` | any | `{locale?, displayName?}` |
| `POST` | `/api/me/password` | any | `{currentPassword, newPassword}`; minimum 10 characters, and it must differ from the current one. |
| `POST` | `/api/me/sessions/revoke` | any | Log this account out everywhere. |

## Teachers — admin only

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/teachers` | |
| `POST` | `/api/teachers` | `{firstName, lastName, locale?}` → `201 {user, password}`. The slip password is returned **once**; it is hashed on the way in and cannot be read back. |
| `GET` | `/api/teachers/:id` | |
| `POST` | `/api/teachers/:id/password` | New slip password; ends their sessions. |
| `PATCH` | `/api/teachers/:id/state` | `{state}` — `active`, `archived` or `deleted`. |

There is no hard delete: `class.teacher_id` is `ON DELETE RESTRICT` and, from
phase 2, a teacher owns a playground schema.

## Classes — teacher (own) or admin (all)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/classes` | `?includeArchived=true` to include archived ones. |
| `POST` | `/api/classes` | `{code, name, schoolYear?}`. An admin must also pass `teacherId`; a teacher may not (they always get themselves). |
| `GET` | `/api/classes/:id` | |
| `PATCH` | `/api/classes/:id` | `{name?, schoolYear?, teacherId?}`. `teacherId` is admin-only. **`code` cannot be changed** — it is baked into every student's Postgres role and schema name. |
| `POST` | `/api/classes/:id/archive` | Never deletes; the roster is the record of who was in `k3a` in 2026. |
| `GET` | `/api/classes/:id/students` | Ordered by `pg_role`, i.e. by surname. |
| `POST` | `/api/classes/:id/students` | Bulk enrolment, see below. |
| `POST` | `/api/classes/:id/members` | `{userIds}` — add students who already exist (the second-subject case). A teacher may only add students they already have; moving one across teachers is admin-only. |
| `DELETE` | `/api/classes/:id/members/:userId` | Refuses on the student's **last** class — see below. |

`code` must match `^[a-z0-9]{2,12}$`, and is unique.

### Bulk enrolment

```http
POST /api/classes/1/students
{ "students": [ {"firstName": "Lena", "lastName": "Muster"}, … ],
  "mustChangePassword": false }
```

→ `201 { "students": [ { "user": {…}, "password": "hafer-blau-71" }, … ] }`

Always a list — the teacher UI pastes a roster and a single student is a list of
one. **All-or-nothing**: one bad name rolls the whole batch back, because a
half-imported class with an unclear boundary is worse to clean up than a failed
import.

Students default to `mustChangePassword: false`. The slip password *is* the
credential in this design; making a fifteen-year-old invent one in the first
five minutes of the first lesson costs more than it buys. Teachers and admins,
who administer other people's accounts, are always forced to change.

### Why enrolment is guarded, not just the class

Enrolment *is* the authorisation primitive: "your students are the students in
your classes". So an unrestricted "add these ids to my class" would let any
teacher grant themselves a colleague's students — and then read a fresh slip
password out of `POST /api/students/:id/password` and log in as them. Student ids
are sequential, so nothing has to be guessed. A teacher may therefore only add
students they already have; crossing the boundary is an admin action.

### Why a student cannot leave their last class

`409 last_class`. The whole authorisation model is "your students are the
students in your classes", so a student in no class is reachable by nobody but
an admin: absent from every roster, unrestorable, password unresettable — and
still owning a schema full of their work. To move a student, add them to the new
class first. To get rid of one, set their state to `deleted`, which archives
their work properly.

## Students — admin, or a teacher of a class they are in

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/students` | Admin: all. Teacher: everyone in their classes. |
| `GET` | `/api/students/:id` | |
| `POST` | `/api/students/:id/password` | New slip password; ends their sessions. |
| `PATCH` | `/api/students/:id/state` | `{state}` — `active`, `archived` or `deleted`. |
| `POST` | `/api/students/:id/reset` | Wipe their schema and give them an empty one. Irreversible, no dump. |

A student who sits in two teachers' classes is administrable by both — that is
the point of the many-to-many roster.

`cold` means "dumped to `/mnt/bulk` and schema dropped". It is **admin-only**:
`TEACHER_STATES` omits it while `ADMIN_STATES` includes it (`routes/students.ts`),
so a teacher asking for it gets a `403` and an admin gets the dump. Restoring is
`cold -> active`, which re-runs `pg_restore`; `cold -> archived` is refused
(`409 restore_first`), because it would leave the row claiming a schema it no
longer has.

What each state does to Postgres:

| State | Postgres |
|---|---|
| `active` | role exists and can log in; a restore re-creates it if it is missing |
| `archived` | `NOLOGIN`. Schema and every table in it are **untouched** — this is reversible by design. |
| `deleted` | `pg_dump` to the archive, **then** drop schema and role. If the dump fails, nothing is dropped. |

`POST /api/students/:id/reset` takes no dump on purpose. The schema is a
scratchpad; students will wreck things and should be able to start over without
asking anyone, and a 50 MB archive every time a fifteen-year-old presses reset
would fill the disk with noise nobody will ever read. Deletion is the path that
preserves work.

## Running SQL — student, or teacher in their own schema

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/query` | `{sql, exerciseId?}` — runs it as the caller's own Postgres role. |
| `POST` | `/api/query/cancel` | Stops whatever the caller is running. `{cancelled: n}`. |

`exerciseId` (phase 9) says the script belongs to an exercise rather than to the
caller's playground, and the runner sets `search_path` to that workspace for the
duration. It is an **id, not a schema name**: the server maps it, so which schema
this caller means is never something the browser gets to assert. `409
exercise_not_open` if they have not opened it yet; `404 exercise_not_found` if it
is not theirs to open.

Admins are excluded (`403 wrong_role`): they have no Postgres identity, so there
is no role to run anything as.

**A failed query is a `200`.** A syntax error is the expected outcome of learning
SQL, not an HTTP-level problem, and the editor needs the detail to underline the
offending character:

```json
{ "ok": false, "statements": [], "durationMs": 3,
  "error": { "code": "42601", "message": "syntax error at or near \"FRM\"", "position": 10 } }
```

`code` is the SQLSTATE, which is what phase 6 keys its German messages off.
The 4xx codes are reserved for things wrong with the *request*: `409
not_provisioned` (no Postgres identity behind the account), `429
too_many_queries` (the caller's previous query still holds their connection).

A success carries one entry per statement, because the editor runs scripts:

```json
{ "ok": true, "durationMs": 12, "statements": [
  { "command": "SELECT",
    "columns": [{ "name": "id", "dataTypeId": 23 }],
    "rows": [[1], [2]],
    "rowCount": 2,
    "truncated": false }
] }
```

`rows` are **arrays, not objects**: `SELECT 1 AS a, 2 AS a` is legal SQL and an
ordinary thing to type while learning joins, and as objects the second column
would silently overwrite the first.

`rowCount` is what Postgres reported, which is the *true* total even when `rows`
was clipped to the 1000-row fetch cap — that is what lets the grid say "showing
the first 1000 of 4812". For a statement that returns no result set it is rows
*affected*, so `truncated` means specifically "we stopped keeping rows", never
"those two numbers differ".

**A script is one transaction, so a failure undoes all of it.** The whole string
goes to Postgres as a single simple-protocol message, which wraps it in an
implicit transaction. If the third statement fails, the first two are rolled
back — `statements` comes back empty and the tables the script created are not
there. Confirmed live, and it is the opposite of the natural assumption, so the
student page says so in as many words when a multi-statement script fails. An
explicit `COMMIT;` mid-script *does* break out of the implicit transaction and
keeps everything before it.

**A command tag is not a reliable guide to what a statement did.**
`CREATE TABLE x AS SELECT …` reports its tag as `SELECT`. Anything deciding
"was this DDL?" from `command` will be wrong; the schema browser reloads after
every execution instead.

### Cancellation

`statement_timeout` is a convenience, **not** a limit: it is `USERSET`, so a
student can run `SET statement_timeout = 0` in the editor. The real bound is an
app-side watchdog that cancels from the `dbk_app` pool once the wall clock
exceeds `DBK_QUERY_TIMEOUT_MS`, and `POST /api/query/cancel` is the same path.
Either way the query comes back as:

```json
{ "ok": false, "error": { "code": "57014", … }, "cancelled": { "reason": "timeout" } }
```

`reason` is `user` for the button and `timeout` for the watchdog — and also for
the role's own `statement_timeout`, which produces the same SQLSTATE.

`{"cancelled": 0}` is a normal answer: the query finished between the click and
the request. The endpoint stops *everything* the caller is running rather than
one identified query, because the running query's id cannot reach the browser —
the response that would carry it is the one still blocked.

## Your own database — student, or teacher in their own schema

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/workspace` | The schema browser's tree. |
| `POST` | `/api/workspace/reset` | Drop the caller's schema and give them an empty one. |
| `POST` | `/api/workspace/import/preview` | Parse a CSV and guess its column types. Changes nothing. |
| `POST` | `/api/workspace/import` | Create a table from it and fill it. |

None of them takes an id: they act on the session's own account, which is the
whole authorisation story. The staff-facing equivalent of the reset is
`POST /api/students/:id/reset`.

`GET /api/workspace` reads the catalog over a connection opened **as the
caller**, filtered by `has_schema_privilege` / `has_table_privilege`. That is
not a convenience — `pg_class` is world-readable, so without those predicates
the tree would hand every student a list of every other student's tables:

```json
{ "self": "u_k3a_muster_lena",
  "schemas": [
    { "name": "u_k3a_muster_lena", "own": true, "tables": [
      { "name": "kunden", "kind": "table", "estimatedRows": null,
        "columns": [{ "name": "id", "type": "integer", "notNull": true }] }
    ]},
    { "name": "demo", "own": false, "tables": [ … ] }
  ]}
```

A student sees their own schema, `demo` and `public`; a teacher additionally
sees the schema of every student they teach. **A schema with nothing readable in
it is still listed, empty** — for a teacher, "this student has no tables yet"
and "I have lost my grant on this student" must not render as the same thing.

`estimatedRows` is the planner's estimate (`pg_class.reltuples`) and is `null`
when Postgres has none, which is the case for every table until it is analysed.
It is not `count(*)`: that would be one query per table on the two connections
the student shares with the editor.

`POST /api/workspace/reset` is irreversible and takes no dump — the same
`resetSchema` the staff route uses, so it also puts the teacher's grants back
(dropping the schema takes them with it). It answers with the `provisioning`
field described below rather than failing.

### CSV upload

Two steps, deliberately. Correcting the inferred types *is* the lesson
(architecture §4), so the preview is a form rather than a confirmation.

The file travels as a **JSON string**, not `multipart/form-data`. It cannot be
multipart: that is one of the three CORS-safelisted content types, and requiring
`application/json` on every state-changing call is this app's whole CSRF
defence. At most 10 MB, 100 000 rows and 100 columns.

```json
POST /api/workspace/import/preview   { "csv": "…", "filename": "Kunden 2025.csv" }

{ "table": "kunden_2025", "delimiter": ";", "hasHeader": true, "totalRows": 412,
  "truncated": true, "tooManyRows": false,
  "columns": [
    { "sourceName": "Kunden-Nr", "name": "kunden_nr", "type": "integer" },
    { "sourceName": "Umsatz 2025", "name": "umsatz_2025", "type": "numeric" }
  ],
  "rows": [["1", "1'234'567,80"]] }
```

`rows` holds the first 20 rows **as written in the file**, uncoerced — showing
them already converted would hide the one thing the student is there to check.
Sending `delimiter` or `hasHeader` back to this route overrides the guess and
re-runs inference, which is what the preview's controls do.

The confirm step re-sends the same bytes rather than the server holding them:
nothing to expire, nothing to leak between two tabs, and no way for the import
to act on anything other than what the preview described.

```json
POST /api/workspace/import
{ "csv": "…", "table": "kunden_2025", "delimiter": ";", "hasHeader": true,
  "replace": false,
  "columns": [{ "name": "kunden_nr", "type": "integer" }, …] }

{ "ok": true, "table": "u_k3a_muster_lena.kunden_2025", "rowCount": 412 }
```

Types are one of `text`, `integer`, `bigint`, `numeric`, `boolean`, `date`,
`timestamp` — Postgres type names verbatim, because naming them is half the
point. Table and column names are folded to `[a-z_][a-z0-9_]*` (`Umsätze 2025`
→ `umsaetze_2025`); colliding names are suffixed rather than dropped.

**A type the data does not fit answers `200 { ok: false, errors }`**, the same
call `POST /api/query` makes for a failed query and for the same reason — it is
the expected outcome of learning about data types, not an HTTP-level problem:

```json
{ "ok": false, "errors": [
  { "line": 41, "column": "menge", "value": "viele", "expected": "integer" }
]}
```

`line` is the line in the student's file, counted through blank lines and
newlines inside quoted fields, so it is the number their spreadsheet shows.
At most 20 are reported. Nothing is created — the whole import is one
transaction, and the coercion check runs before it opens.

The 4xx codes are for the request: `table_exists` (409 — the fix is another
name or `replace: true`), `csv_too_many_rows` (413), `invalid_table_name`,
`column_count_mismatch`, `duplicate_column_name`, `empty_csv` (400).

Values are normalised before they reach Postgres rather than being handed over
as written. Swiss `31.12.2025` becomes `2025-12-31`, `1'234,50` becomes
`1234.50`, `ja`/`nein` become booleans, and a blank cell becomes NULL. This is
not a convenience: Postgres's default `DateStyle` is `ISO, MDY`, under which
`03.04.2025` parses **without error** as 4 March. Dates written with slashes are
deliberately left as `text`, because `03/04/2025` is genuinely ambiguous and
nothing in the file resolves it.

## Lesson view — teacher of the class, or admin

Two reads, both scoped by the same `assertClassAccess` the class routes use. They
were missing from this document entirely; the second is the most sensitive read
in the API, so its absence here was the worst of the gaps.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/lesson/classes/:id` | The class roster with per-student live state: last activity, statement counts, error counts, disk used against the quota. |
| `GET` | `/api/lesson/classes/:id/students/:userId` | One student in detail — **their last 50 statements, with the SQL text**, plus their schema as the *caller* can see it. |

Two things about the detail route that are deliberate and worth not reversing:

- `:userId` is **not trusted as a scope**. The handler re-reads the class roster
  and refuses a student who is not in it, rather than assuming the id belongs to
  the class named in the path.
- The schema pane is read as the **caller**, via `catalog.read(callerId)`, not as
  the student. A teacher therefore sees exactly what their own grants allow,
  which is the same answer Postgres would give them in the editor — the view
  cannot become a way to see more than the grants do.

`query_log` rows are pruned after `DBK_QUERY_LOG_RETENTION_DAYS` (default 120),
so this route shows a term's worth of history and not a permanent record.

## Admin — instance operations

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/admin/reconcile` | Repair the teaching database against `app_user`. Also runs at startup. |
| `POST` | `/api/admin/archive-sweep` | Cold-store every account idle past the retention window. Instance-wide; also runs nightly. |
| `GET` | `/api/admin/usage` | `{quotaBytes, totalBytes, overQuota, schemas}` — bytes per schema. |

Admin-only, not staff: `usage` names every schema in the instance, which is a
roster of every other teacher's students, and `reconcile` can drop the schema of
any account marked deleted.

Usage is **reporting only**. Postgres has no native per-schema quota, and
enforcement needs somewhere to refuse a write. `POST /api/query` is now that
place, but it does not yet check — see "Not yet implemented".

## The `provisioning` field

Creating an account, changing its state, moving a class between teachers and
enrolling a student all touch two databases: the account row is committed in
`datebaenkli_meta`, and the Postgres role lives in `datebaenkli`. Two databases
cannot share a transaction, so the second half runs **after** the first has
committed and can fail on its own.

Those responses therefore carry a `provisioning` object:

```json
{ "user": {…}, "password": "hafer-blau-71", "provisioning": { "ok": true } }
{ "user": {…}, "provisioning": { "ok": false, "error": "connection refused" } }
```

`ok: false` is not an error status. The account genuinely exists and is in the
roster — it just has no schema yet, or still has one it should not. Failing the
request with a `5xx` would claim nothing happened, which is worse than saying
what did. Every failure also writes a `provision_failed` row to `audit_log`, and
the reconciler repairs the gap on the next pass or at the next restart.

## Identifiers

A student's app username, Postgres role and schema name are **one string**
(`auth/identifiers.ts`, architecture §2):

```
u_k3a_muster_lena     u_ + class code + surname + firstname
t_schaffner           teachers
```

Lowercased, umlauts transliterated German-style (`ä→ae`, `ß→ss`), other accents
stripped, everything outside `[a-z0-9]` removed, clamped to 63 bytes, numeric
suffix on collision (`t_schaffner2`).

Role == schema makes Postgres's default `search_path` (`"$user", public`) resolve
with no per-session setup. Login == role means the name a student types to log in
is the same one they type in `SELECT * FROM u_k3a_muster_lena.kunden`.

## Exercises — phase 9

Two prefixes, and the split is the authorisation story. `/api/exercises/*` is the
teacher's and every route naming an id goes through the same
"is this yours" check `/api/classes` uses. `/api/my/exercises/*` is the
student's and takes no owner id at all — every route acts on the session.

### Authoring — teacher (own) or admin (all)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/exercises` | Yours; every one in the instance for an admin. |
| `POST` | `/api/exercises` | `{title, taskMd?}` → `201 {exercise}`. |
| `GET` | `/api/exercises/:id` | With its sources and its class assignments. |
| `PATCH` | `/api/exercises/:id` | `{title?, taskMd?}`. |
| `DELETE` | `/api/exercises/:id` | Drops **every** class's workspaces first. |

### Its tables

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/exercises/preview` | `{csv, filename?, delimiter?, hasHeader?}` — the same pure `previewCsv` the student's import uses. |
| `POST` | `/api/exercises/:id/sources/csv` | `{label, csv, columns[], delimiter?, hasHeader?}` → `201 {source}`. |
| `POST` | `/api/exercises/:id/sources/sql` | `{label, sql}` → `201 {source}`. |
| `GET` | `/api/exercises/:id/sources/:sourceId` | One source in full, for editing. |
| `DELETE` | `/api/exercises/:id/sources/:sourceId` | |
| `POST` | `/api/exercises/:id/sources/order` | `{ids[]}` — replay order. |

A CSV is **coerced in full at upload** and refused with `400 csv_types_rejected`
if any cell does not fit the chosen types. That is deliberately not the student
import's `200 {ok: false, errors}`: there the per-cell report *is* the lesson,
here it is somebody preparing material who can only fix the file.

Caps are lower than the student import's on purpose — 2 MB and 20 000 rows per
source, 20 sources — because a fixture is copied into every student in the class
and counts against each of their quotas.

### Distribution

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/exercises/:id/classes` | `{classId}`. The class is checked separately: owning the exercise says nothing about owning the class. |
| `DELETE` | `/api/exercises/:id/classes/:classId` | **Destructive.** |

Taking an exercise back drops every student-in-that-class's workspace *and*
deletes their hand-ins, and answers
`{workspaces, submissions, failures[], exercise}`. `failures` is reported rather
than swallowed: one schema refusing to drop leaves the other twenty-four correct
and the teacher has to be able to see it happened. A workspace that failed to
drop keeps its row, so the next attempt retries exactly that one.

### Hand-ins

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/exercises/:id/submissions?classId=` | Teacher. |
| `GET` | `/api/exercises/:id/submissions/:submissionId/download` | One `.sql`. |
| `GET` | `/api/exercises/:id/classes/:classId/download` | The whole class as one `.sql`. |
| `POST` | `/api/my/exercises/:id/submissions` | `{sql, note?}` → `201 {submission}`. |
| `GET` | `/api/my/exercises/:id/submissions` | The caller's own. |
| `GET` | `/api/my/exercises/:id/submissions/:submissionId/download` | Own only. |

Attempts are **numbered, not just ordered** — a unique index on
`(exercise, user, attempt)` makes two simultaneous submits fail loudly rather
than produce two rows both calling themselves attempt 3.

The bulk download is one annotated `.sql`, not a ZIP: the app has four runtime
dependencies and a real archive would mean hand-writing the format.

### The student's side

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/my/exercises` | Assigned to a class they are in. |
| `POST` | `/api/my/exercises/:id/open` | Builds the workspace if absent. |
| `POST` | `/api/my/exercises/:id/reset` | Drops it and rebuilds it. |

`open` is a **POST** because the first call creates a schema, and it is
idempotent — an existing workspace answers `materialised: false` and is not
touched, which is what makes it safe to call on every page load. Answering
`{ok: false, failedSource, error}` means the *teacher's* fixture is broken; the
student can do nothing about it, so the page says whose problem it is.

A teacher may open **their own** exercise without being in its class, so they can
test a fixture before a lesson rather than discovering it is broken through 25
students at once.

`/api/workspace` also gained `exercises: [{schema, title}]`, so the schema
browser can label a node "Übung: Kundendaten" instead of
`x7_u_k3a_muster_lena`. The tree keeps the real name in a tooltip — it is what a
student has to type to qualify a table.

## Not yet implemented

The student-facing surface is complete: the query runner, cancellation, the
schema browser, CSV upload, the student's own reset button, and exercises.

**Auto-checking a hand-in against a reference query is not coming back by
accident.** It was dropped in phase 9 as a product decision and its columns were
removed rather than left unused; ARCHITECTURE §5 has the argument.

Quota enforcement is **in place** — `services/quota.ts` is consulted by the
query runner before a statement that could grow the schema (`services/query.ts`)
and by the CSV importer before it writes, and both refuse with `507
quota_exceeded`. This section previously said it was missing; it was implemented
in phase 7.2.
