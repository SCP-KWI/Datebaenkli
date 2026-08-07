# Datebänkli — Architecture Proposal

A hosted PostgreSQL sandbox where students learn SQL in the browser, with an
admin → teacher → student administration hierarchy.

> Status: proposal, v1 scope. Decisions marked **OPEN** still need your input.

---

## 1. The core idea

**Postgres itself enforces the isolation, not our app code.**

Every student gets a real PostgreSQL **login role** and a real **schema of the
same name**. The web app connects to Postgres *as that student*. This is the
single most important design decision, and everything else follows from it:

- A student cannot read another student's tables even if they craft malicious
  SQL — the database refuses, not our validator.
- No SQL sanitising, no statement allow-list, no parser. Students may run
  *anything* their role is permitted to run. That is exactly what we want
  pedagogically: `CREATE TABLE`, `DROP`, `GRANT`, transactions, the lot.
- Because Postgres's default `search_path` is `"$user", public`, naming the
  schema identically to the role means it Just Works with zero per-session
  setup.

The alternative — one shared app connection plus `SET ROLE` — is rejected: a
student could simply type `RESET ROLE;` into the editor and escape.

---

## 2. Role model

### Application roles (stored in the meta database)

| App role | Can do |
|---|---|
| **admin** (you) | Create/remove **teachers**, global limits & quotas, instance health, backups. Sees everything. |
| **teacher** | Create/remove **classes** and **students** in their own classes. Read-only peek into their students' schemas. Reset a student's schema. Has their own playground schema for preparing material. Cannot see other teachers' classes. |
| **student** | Own schema: full DDL/DML. Read-only access to shared `demo` data. Nothing else. |

### PostgreSQL objects

```
cluster
├── datebaenkli_meta      ← app data. Student/teacher roles have NO rights here.
│   └── app_user, class, class_member, exercise, submission, query_log, setting
│
└── datebaenkli           ← the teaching database
    ├── schema demo       ← shared, read-only, granted to PUBLIC
    ├── schema u_k3a_muster_lena   owned by role u_k3a_muster_lena
    ├── schema u_k3a_meier_tim     owned by role u_k3a_meier_tim
    └── schema t_schaffner         owned by role t_schaffner  (teacher playground)
```

Provisioning a student — **the sequence below is verified against real
Postgres** by `db/verify-isolation.sh`; three of its steps are non-obvious and
the naive version fails:

```sql
CREATE ROLE u_k3a_muster_lena LOGIN PASSWORD '<32 random chars>'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
  CONNECTION LIMIT 4;

-- (1) CREATEROLE grants dbk_app admin_option on the new role but NOT
--     set_option. Without SET, "CREATE SCHEMA ... AUTHORIZATION" fails with
--     "must be able to SET ROLE". INHERIT stays FALSE so dbk_app never
--     silently acts with student privileges.
GRANT u_k3a_muster_lena TO dbk_app WITH INHERIT FALSE, SET TRUE;

CREATE SCHEMA u_k3a_muster_lena AUTHORIZATION u_k3a_muster_lena;
GRANT CONNECT ON DATABASE datebaenkli TO u_k3a_muster_lena;

-- per-session rails (see the caveat in §3 — these guard accidents, not attacks)
ALTER ROLE u_k3a_muster_lena SET statement_timeout = '15s';
ALTER ROLE u_k3a_muster_lena SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE u_k3a_muster_lena SET work_mem = '8MB';
-- NOT temp_file_limit: it is SUSET, so a non-superuser cannot set it per role.
-- It is set cluster-wide in docker-compose.yml instead, which students cannot
-- override — verified.

-- (2) The teacher grant must be issued BY the schema owner. dbk_app holds
--     NOINHERIT membership, so it has no privileges on the student's schema
--     until it deliberately steps into the role.
SET ROLE u_k3a_muster_lena;
  GRANT USAGE ON SCHEMA u_k3a_muster_lena TO t_schaffner;
  ALTER DEFAULT PRIVILEGES IN SCHEMA u_k3a_muster_lena
    GRANT SELECT ON TABLES TO t_schaffner;
RESET ROLE;
```

That `ALTER DEFAULT PRIVILEGES` line is the one people forget — without it the
teacher can only see tables that existed at provisioning time.

**A grant issued late needs one more line.** The sequence above runs against a
schema that is empty, so it never had to think about existing tables. Every
*other* time a teacher is granted — a class handed over, a student enrolled in
a second subject, a reconciler repair — the schema is full, and
`ALTER DEFAULT PRIVILEGES` only covers what is created *from now on*:

```sql
GRANT SELECT ON ALL TABLES IN SCHEMA u_k3a_muster_lena TO t_schaffner;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA u_k3a_muster_lena TO t_schaffner;
```

`provision.ts` issues all five statements every time, which also makes the
grant idempotent. Verified in `app/test/provision.live.test.mjs`.

**Reset** ("wipe my database"):

```sql
SET ROLE u_k3a_muster_lena;
  DROP SCHEMA u_k3a_muster_lena CASCADE;
RESET ROLE;
CREATE SCHEMA u_k3a_muster_lena AUTHORIZATION u_k3a_muster_lena;
-- and then RE-GRANT every teacher: DROP SCHEMA took their USAGE and their
-- default privileges with it, because both are properties of the schema. An
-- earlier draft of this document stopped at the CREATE, which would have cost
-- a teacher sight of a class one reset at a time, silently.
```

**Deprovision** — (3) the third trap:

```sql
SET ROLE u_k3a_muster_lena;
  DROP OWNED BY CURRENT_USER CASCADE;
RESET ROLE;
-- DROP OWNED BY covers objects *in* the database but not grants *on* it, so
-- DROP ROLE would fail with "privileges for database datebaenkli".
REVOKE ALL ON DATABASE datebaenkli FROM u_k3a_muster_lena;
DROP ROLE u_k3a_muster_lena;
```

`REASSIGN OWNED BY` is not usable here: it needs the *privileges of* the role,
which NOINHERIT membership does not confer.

**The archive dump needs `--role`.** `dbk_app` holds NOINHERIT membership and
therefore has SELECT on not a single student table, so a plain
`pg_dump --schema=u_k3a_muster_lena` connecting as `dbk_app` produces an empty
archive **and exits 0**. Connect as `dbk_app` and pass `--role=<student>`, which
issues `SET ROLE` after connecting:

```
pg_dump --format=custom --schema=u_k3a_muster_lena --role=u_k3a_muster_lena \
        --file=<archive>/u_k3a_muster_lena-<ts>.dump datebaenkli
```

Connecting *as* the student would also work, but not on the path that actually
needs it: an account is set NOLOGIN before it is dumped.

**Identifier naming.** `u_` + class code + surname + firstname, lowercased,
umlauts folded (`ä→ae`), non-alphanumerics stripped, truncated to 63 bytes,
numeric suffix on collision. Readable on purpose — students will type
`SELECT * FROM u_k3a_muster_lena.kunden` at some point and that should make
sense to them.

The **app username is the same string**, so the name a student types to log in
is the name they type in SQL. Implemented in `app/src/auth/identifiers.ts`;
`docs/API.md` documents the exact folding rules.

**Deprovisioning** = `pg_dump --schema` to the archive folder, then
`DROP SCHEMA ... CASCADE; DROP ROLE ...`.

**Where this lives.** `app/src/services/provision.ts` is the engine, and it is
the only file allowed to build SQL by string concatenation — DDL takes no bind
parameters. `app/src/db/ident.ts` holds the allow-list (`^[ut]_...`) and the
quoting that makes that safe. `app/src/services/reconcile.ts` diffs `app_user`
against `pg_roles`/`pg_namespace` and repairs the difference; it runs at
startup and from `POST /api/admin/reconcile`.

**There is no `provisioned_at` column, on purpose.** Postgres is the source of
truth for what exists. A flag would be a second one, and the two would
eventually disagree. The cost is a catalog query per reconcile; the benefit is
that provisioning is repairable from the account row alone, so a run that dies
halfway is a self-healing condition rather than an incident.

---

## 3. Safety rails

> **Correction after testing.** An earlier draft treated `statement_timeout` as
> a hard limit. It is not — see the box below §3. The table separates limits a
> student can lift from those they cannot.

**Hard limits** (verified unliftable by a student in `db/verify-isolation.sh`):
`CONNECTION LIMIT 4` per role, cluster-wide `temp_file_limit=256MB`, and every
schema/database privilege. Altering any of these needs `CREATEROLE` or
superuser, which students do not have.

| Risk | Mitigation |
|---|---|
| Runaway query (accidental cartesian join) | `statement_timeout = 15s` on the role catches the accident, which is the realistic case. **Enforcement, however, is app-side**: a watchdog cancels via `pg_cancel_backend(pid)` from the admin pool once the wall clock exceeds the limit. The same path backs the UI's Cancel button. |
| Abandoned open transaction locking a table | `idle_in_transaction_session_timeout = 60s`. |
| Connection exhaustion | `CONNECTION LIMIT 4` per role; app pools capped at 2 per student, idle-evicted after 60 s. |
| Memory blowup | `work_mem = 8MB`, `temp_file_limit = 256MB` per role. |
| Disk fill | Postgres has **no native per-schema quota**. The app sums `pg_total_relation_size` for the caller's own schema, on demand, and refuses anything that could grow it once they are over the limit (default 50 MB/student). Plus a hard 10 MB / 100k-row cap on CSV upload. **Built in phase 3** — see the second box below for what it does and does not promise. |
| Reading server files | Students are not superuser and lack `pg_read_server_files`, so `COPY FROM '/etc/passwd'` is denied. Uploads go through `COPY ... FROM STDIN` from the app. |
| Escaping to other databases | `dblink`, `postgres_fdw`, `file_fdw` and all untrusted PLs are **not installed**. `REVOKE CONNECT ON DATABASE datebaenkli_meta FROM PUBLIC`. |
| Result set too large for the browser | Fetch cap of 1000 rows, with "showing first 1000 of N". |
| Brute-forcing the app login | Argon2id password hashes, per-IP and per-account rate limiting. |

> **`statement_timeout` is not a security boundary.** It is `USERSET`, so a
> student can run `SET statement_timeout = 0;` in their own session — and can
> even persist it with `ALTER ROLE <self> SET statement_timeout = '1h'`, since
> a role may always change its own session defaults. Both were confirmed
> against real Postgres. Postgres offers no way to revoke this.
>
> Consequence: **the app must not rely on it.** The per-query watchdog above is
> the actual control; the role default is a convenience that stops the common
> accident without a round trip. The blast radius of a student who deliberately
> disables it is bounded by the hard limits — they get at most 4 connections and
> 256 MB of temp spill, and `pg_cancel_backend` still reaches them.
>
> **Correction, phase 3.** "`pg_cancel_backend` still reaches them" is only true
> with one extra step. That function checks `has_privs_of_role()`, which respects
> `INHERIT`, and `dbk_app` holds student roles `WITH INHERIT FALSE` — so the
> obvious call fails with 42501. `services/watchdog.ts` steps into the role first
> (`set_config('role', $1, true)`, i.e. `SET LOCAL ROLE` through a bind
> parameter) and signals from there. See HANDOFF §4a; built and verified live.

> **The disk quota bounds the steady state, not a single statement.** Built in
> phase 3 as `services/quota.ts`, and two things in the row above turned out
> differently once it was written.
>
> *No background job.* "A 5-minute background job sums …" was the plan; it is
> measured **on demand**, for one schema, on the two write paths. A cached
> number is wrong for up to five minutes in the direction that matters — a
> student can be 400 MB over and still be told they are fine — and the query it
> would save is one catalog scan, cheaper than the identity lookup the same
> request already does. A cheap keyword scan (`mayGrow`) means a script with no
> `INSERT`/`CREATE`/`UPDATE`-shaped word in it never asks the database at all,
> so an ordinary lesson of `SELECT`s pays nothing.
>
> *What it actually promises.* It cannot refuse the statement that takes a
> student over — nothing knows how large a result is until it has been written.
> A student at 49 MB can still run one `INSERT … SELECT` that writes gigabytes;
> what bounds *that* is the watchdog's 20-second wall clock and
> `temp_file_limit`. What the quota stops is **accumulation**: once over, the
> next growing statement is refused and stays refused. That is the right shape
> for the actual failure — a class of thirty leaving experiments behind for a
> term, not an adversary with a 20-second budget.
>
> The CSV import is the exception and is exact: it knows its own size before it
> opens a transaction, so it is refused *before* it crosses the line rather
> than after.
>
> *And `DELETE` is not the advice.* Deleting rows frees **no** space —
> the dead tuples stay in the heap until `VACUUM FULL` rewrites it, so
> `pg_total_relation_size` does not move. Confirmed over HTTP: deleting 39 900
> of 40 000 rows left the schema at exactly 4.0 MB. The refusal message names
> `DROP TABLE` and `TRUNCATE`, which do. See HANDOFF §4q.

**Two honest caveats.**

*Catalogs are world-readable.* `pg_class` and `pg_namespace` are visible to
everyone, so a curious student *can* discover that other schemas and tables
exist — they just can't read a single row from them. Hiding catalogs entirely
isn't possible without patching Postgres. For a teaching tool this is fine, and
arguably a teachable moment about metadata vs. data.

*A student can share their own schema.* They **own** it, and an owner may
`GRANT USAGE ON SCHEMA u_me TO u_other`. Postgres offers no way to take that
away without taking ownership away, and ownership is what the whole model rests
on. So "strict isolation, always" (§8b) is not preventable at the grant level.
It is **restored** instead: `reconcile.ts` compares the USAGE grants on every
student schema against the roster and revokes anything that is not one of that
student's teachers, reporting it as `peer_student`. Found by writing phase 2's
reconciler, and verified live.

The bound this leaves is the one that matters: two students who *agree* can see
each other's work until the next reconcile pass. Nobody can reach a student who
did not agree. Treat it as a cheating vector to notice, not a confidentiality
breach — and note that the revocation lands in `audit_log`, so it is visible
after the fact.

---

## 4. Application architecture

One Node service, one container. No microservices, no queue, no Redis.

```
Browser (Chalk UI, vanilla JS + CodeMirror 6)
   │  HTTPS, session cookie
   ▼
Nginx Proxy Manager  ──────────────────────────── TLS termination
   │
   ▼
datebaenkli-app   (Node 22 + Fastify + TypeScript)
   │
   ├─ pool as "app_meta" ─────────────► datebaenkli_meta   (users, classes, log)
   │
   └─ pool per student role ──────────► datebaenkli        (student schemas)
        lazily created, max 2 conns, LRU-evicted after 60s idle
   │
   ▼
datebaenkli-db    (postgres:17-alpine)   — internal network only, no host port
```

**Why not pgAdmin / Adminer / CloudBeaver?** They're built for DBAs, the UI is
overwhelming for a first SQL lesson, and — decisively — none of them give you a
class roster, a credential-slip printout, or exercise distribution. The custom
app is maybe 3000 lines and is the thing that actually makes this a *teaching*
platform rather than a database with a web form in front of it.

### Two-layer credentials

Students never see a Postgres password. They log into the app with a short
memorable one (`hafer-blau-71`) printed on a slip; the app looks up their
Postgres password, which is 32 random characters encrypted at rest
(AES-256-GCM, key from the container environment) in the meta database.

### Query flow

1. `POST /api/query { sql }`
2. Session → app_user → Postgres role → pool
3. Simple query protocol, so a student can run a multi-statement script and see
   each result. Fetch capped at 1000 rows.
4. Every execution is written to `query_log` (who, what, duration, rowcount,
   error). This powers the teacher's live lesson view *and* becomes the
   submission record for v2 exercises.

### Screens

**Student** — one page, three panes:
- Left: schema browser (their schema + `demo`), tables → columns → row counts,
  click a table for `SELECT * LIMIT 50`
- Top right: SQL editor (CodeMirror 6, Postgres dialect, autocomplete fed from
  their own catalog), ⌘↵ to run, Cancel button
- Bottom right: result grid, timing, row count, or a friendly rendering of the
  Postgres error (position marker included — Postgres tells us the character
  offset, which is genuinely great for beginners)
- Plus: **CSV upload** and **Reset my database** (`DROP SCHEMA … CASCADE` and
  recreate — students will wreck things, and they should be able to)

**Teacher** — classes list → roster → per-student actions (reset, peek,
remove), bulk-create from a pasted name list, printable credential slips, and a
**live lesson view**: who's connected, last statement, error rate. That live
view is the feature I'd expect you to actually love during a lesson.

**Admin** — teachers CRUD, global limits, disk usage per class, backup status.

### CSV upload

Client uploads → server parses → infers column types (int / bigint / numeric /
date / timestamp / boolean / text) → shows a preview with **editable** types and
table name → confirm → `CREATE TABLE` + batched `INSERT`. Letting them correct
the inferred types is itself a lesson about data types.

**Built, phase 3.** Two deviations from the sketch above, both deliberate:

- **No `csv-parse`.** The hard part turned out not to be RFC 4180 but the Swiss
  Excel dialect — `;` delimiters, `1'234,50`, `31.12.2025`, Windows-1252 — none
  of which a general parser decides for us. The sniffing, coercion and inference
  had to be written either way; record splitting is ~60 more lines
  (`services/csv.ts`).
- **No `pg-copy-streams`.** COPY's wire format is hand-escaped text, which would
  make the importer responsible for building *data* by concatenation as well as
  SQL. Batched multi-row `INSERT` keeps every value in a `$n` placeholder — the
  rule the rest of the codebase follows without exception — and the throughput
  difference is imperceptible at a 10 MB cap.

Values are normalised to a form Postgres has exactly one reading of before they
are sent. `DateStyle` defaults to `ISO, MDY`, so `03.04.2025` handed over as
written parses **without error** as 4 March; slash dates are left as `text`
because nothing in the file disambiguates them. Contract in `docs/API.md`.

### Shared `demo` schema

Ships with a Swiss-flavoured example database so day one doesn't start with an
empty screen: `kantone`, `gemeinden`, `schuelerinnen`, `noten`, `bestellungen`,
`artikel` — enough for joins, aggregates, subqueries, and a deliberate
foreign-key violation to demo constraints. Read-only, granted to PUBLIC.

---

## 5. Exercises — BUILT in phase 9

**Amended in place, because what was built is not what this section described.**
The original sketch is quoted below so the difference is legible rather than
lost; §8a set the precedent for correcting a section rather than leaving it
describing a design nobody chose.

> - **exercise**: title, task text (Markdown), optional setup SQL, reference
>   solution, comparison mode (order-sensitive / set-equality / column-subset)
> - Teacher assigns an exercise to a class → students see a task list
> - On submit: run the student's SQL and the reference query in the same
>   transaction, diff the result sets, show ✅ or a side-by-side difference
> - Teacher gets a class × exercise matrix

### What was actually asked for, and built

A teacher builds an exercise's **tables**, writes the task, hands it to a class,
and reads what comes back. No auto-checking:

- **exercise**: title, task text (Markdown). Nothing else.
- **exercise_source**: 1–n per exercise, ordered — each either a SQL script or a
  CSV file with a confirmed column list. This is the part the sketch called
  "optional setup SQL", and the difference is a UI that manages *tables* rather
  than one textarea holding a 4000-line `INSERT`.
- **exercise_assignment**: teacher → class. Reversible, destructively.
- **exercise_workspace**: `(exercise, student) → schema name`. The idea the
  sketch had no place for, and the one everything else rests on.
- **submission**: many per student, `sql_text` + an optional note, numbered.

### Auto-checking was dropped, not deferred

The reference-solution design is coherent and is not a cheaper version of this
one. The exercises this is for — "build a schema for a lending library", "find
the customer with the highest turnover" — mostly have no single reference result
to diff against, and the teacher wants to see *how* it was written. So the
columns for it are dropped in `meta/003_exercises.sql` rather than left as a
decoy, and re-adding it is its own phase with its own columns.

The class × exercise matrix went the same way: the teacher's page shows, per
class, how many students have opened it and how many have handed in. A full
matrix is a reporting feature nobody has asked for yet.

### The one design decision everything follows from

**A student's copy of an exercise lives in its own schema, owned by them** —
`x7_u_k3a_muster_lena`. Not prefixed tables inside their playground schema.

That is §2's role/schema model applied a second time rather than a new
mechanism, and it is what makes three requirements fall out instead of being
implemented:

| Requirement | Falls out as |
|---|---|
| students do not interfere | the schema has an owner; Postgres enforces it, as everywhere else |
| reset one exercise only | `DROP SCHEMA` — exact by construction, not a prefix match over table names a student can break by renaming one |
| the tables appear in the browser | `services/catalog.ts` lists what the caller can read, and this is theirs |
| the teacher can look | the same read grant `grantTeacherSql` already issues on a playground |

The name is **allocated once and stored**, never derived at the call site: the
recipe has to be clamped to 63 bytes, and two long student names clamp to the
same string. Deriving it would make that collision resolve to one schema shared
by two students, which is an isolation break rather than a cosmetic bug.

`db/ident.ts` keeps two **disjoint** allow-lists — a workspace name cannot match
the `^[ut]_` a role name must have — so a workspace can never be steered into
`CREATE ROLE` / `DROP ROLE` / `SET ROLE`, and a role name can never be accepted
where a workspace is meant.

### `search_path`, and what it deliberately excludes

A query run against an exercise gets `search_path = <workspace>, public` —
**without** `"$user"`. An unqualified `DELETE FROM kunden` typed during an
exercise must not be able to reach the `kunden` in the student's own playground;
that is what makes "reset this exercise only" an honest promise. Their playground
is still theirs and still reachable, qualified.

The exercise's own setup runs with `search_path` = the workspace alone, so an
unqualified `CREATE TABLE` in a teacher's script lands in the exercise.

### Materialisation is lazy

A workspace is built when the student first opens the exercise, not for all 25 at
distribution time. A student enrolled in week six gets one; a failure is one
student's and is retried by clicking again rather than leaving a fan-out half
done; and a workspace lost to "wipe my whole database" comes back by itself,
because the *absence of the schema* is the trigger.

### No new runtime dependency, and no third SQL-concatenating file

- The schema, its drop and the teacher's grant run as `dbk_app` — `provision.ts`'s
  hazard class — so they live there.
- A CSV fixture is stored **as CSV** and materialised through `import.ts`'s
  `createAndFill`, so every value reaches Postgres as a `$n` parameter. Storing
  generated `INSERT` text would be this app building *data* by concatenation,
  which `import.ts`'s header refuses to do.
- The task's Markdown is rendered by `web/assets/markdown.js`, a ~150-line
  subset that escapes first and inserts tags second. A Markdown library would
  have been the fifth runtime dependency.
- Bulk download is one annotated `.sql`, not a ZIP — see §4's dependency rule.

---

## 6. Deployment

Two containers behind a reverse proxy that already terminates TLS. Paths below
are placeholders — `/opt/apps/datebaenkli` is simply the directory the compose
file and `.env` live in, and nothing in the app depends on it.

```
/opt/apps/datebaenkli/
  docker-compose.yml
  .env                  # secrets: POSTGRES_PASSWORD, APP_SECRET, ENCRYPTION_KEY
  app.json
  backups/
  archive/              # pg_dump of removed students
```

```yaml
services:
  datebaenkli-db:
    image: postgres:17-alpine
    container_name: datebaenkli-db
    restart: unless-stopped
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - ./pgdata:/var/lib/postgresql/data
    networks: [datebaenkli_internal]     # NOT on the proxy network
    command: >
      postgres -c shared_buffers=512MB -c work_mem=8MB
               -c max_connections=200 -c log_min_duration_statement=2000

  datebaenkli-app:
    image: datebaenkli:latest            # built from ./app
    container_name: datebaenkli-app
    restart: unless-stopped
    depends_on: [datebaenkli-db]
    env_file: .env
    networks: [datebaenkli_internal, proxy]

networks:
  datebaenkli_internal:
  proxy:
    external: true
    name: ${DBK_PROXY_NETWORK:-proxy}
```

Note the database is on an internal network only — deliberately **not** on the
proxy network, so no other container on the host can reach it, and no host port
is published.

**Rollout checklist:**
1. A directory with the files in place and `.env` holding generated secrets
2. `docker compose up -d`, then run the bootstrap migration + seed `demo`
3. Point a DNS record at the host and wait for it to propagate (`nslookup`)
4. Add the proxy host **without** SSL first → confirm the vhost appears → then
   add the certificate as a separate step. Doing both at once is the common way
   to end up with a proxy entry that never gets written.
5. Test in a private window, so no existing session masks a cookie problem

**Backups:** nightly host cron `pg_dump -Fc` of both databases into
`./backups/`, 14-day retention, plus an automatic dump immediately before any
student reset or removal.

Built as `db/backup.sh` (2026-07-28), and it takes `pg_dumpall --globals-only`
as well — roles live in neither database, and without them a restore is a set of
schemas nobody can log into. Install and restore are in HANDOFF §7. The
pre-removal dump was already built in phase 2 (`services/users.ts` refuses a
deletion it could not archive).

---

## 7. Hardware

Sizing for the "two classes in parallel" worst case, ~50 concurrent students
running small queries:

| Component | RAM | Notes |
|---|---|---|
| Postgres | ~900 MB | 512 MB shared_buffers + ~100 backends × ~5 MB + work_mem bursts |
| Node app | ~250 MB | |
| **Total** | **~1.2 GB** | comfortable headroom: 2 GB |

- **CPU:** bursty and trivial. Two cores is plenty; a class of 25 pressing "Run"
  simultaneously on 1000-row tables is nothing.
- **Disk:** 50 MB quota × 300 students = 15 GB absolute worst case. Realistically
  under 3 GB. Budget 20 GB.
- **I/O:** SSD strongly preferred, but any modern disk is fine at this size.

**Verdict: 2 cores and 2 GB of spare RAM run this comfortably**, which is well
inside what a small VPS or any repurposed desktop offers. The reference
deployment has considerably more than that and the app has never been the thing
under pressure on it.

**Disk placement matters more than disk size.** Two different access patterns,
and putting them on one volume is the mistake worth avoiding:

- `./pgdata` wants the **fast** disk — SSD or NVMe. Budget 20 GB there and
  Postgres will not notice the app exists.
- `./backups/` and `./archive/` want the **big** disk, and should be a mount or
  symlink onto it. Dumps are write-once and read-rarely, they accumulate until
  something prunes them, and keeping them off the root filesystem means the
  archives survive a rebuild of it.

If the host has cores to spare, be less stingy than the sizing above:
`shared_buffers=1GB`, `max_parallel_workers_per_gather=2`. Still trivial in
absolute terms, and that is what `docker-compose.yml` ships with — turn it down
on a smaller box.

Scale levers if you ever outgrow it (you won't at school scale): PgBouncer in
session mode in front of Postgres, and read-only replicas. Neither is needed for
v1.

---

## 8. Chalk integration

Datebänkli takes a new position on the Chalk accent ring. Following the rule
that new accents change **hue only**:

- **Accent: violet, `oklch(0.578 0.100 300)` — CONFIRMED and built** (phase 7,
  2026-07-29; lightness revised 2026-07-30). It obeys the ring rule: the chroma
  sits inside the band every other accent shares and only the hue moves. The
  full triple is a transposition of an existing accent's, by hue alone.

  **The `L` is no longer 0.690, and the band moved with it.** At 0.690 white
  text measured 2.87:1 on this solid and failed WCAG AA — as it did on all six
  accents, which all sat at 0.68–0.705. They were darkened to the lightest value
  at which white clears 4.5, which is a different `L` per hue because luminance
  at a fixed OKLCH lightness is not constant. **So the ring rule is now "same
  chroma, hue moves, and `L` is whatever the contrast requires"**, which is a
  weaker invariant than before and the honest one. HANDOFF §4ww has the table.

  ```
  --datebaenkli:      oklch(0.578 0.100 300)   /* solid, both modes   */
  --datebaenkli-tint: oklch(0.955 0.030 302)   /* light               */
  --datebaenkli-ink:  oklch(0.500 0.115 302)   /* light               */
  --datebaenkli-tint: oklch(0.345 0.052 300)   /* dark                */
  --datebaenkli-ink:  oklch(0.832 0.092 302)   /* dark                */
  ```

- **The hue ring is read from CSS, never from a spec — and this section is why.**
  An earlier version of §8 carried an inventory of which accent sat at which
  hue, written from memory. When phase 7 finally checked the entries that
  *could* be checked against the stylesheets that actually serve them, the
  verifiable sample came back **0 for 2**: one accent was off by 5°, and another
  had no accent at all — it reused an existing one and introduced no hue,
  so the number recorded for it had never existed.

  The inventory has been removed rather than corrected, because a table like
  that is wrong the moment it is written down and nothing makes it fail loudly.
  `chalk-tokens.css` carries the six accents that are real; a hue not in that
  file is a hue you must go and read out of the stylesheet that declares it.

  The rule, stated once: **read the CSS, never the spec.**

- **How an app declares an accent — there are two patterns, and which one is
  correct depends on whether the app brings a new hue.** An app that *reuses* an
  existing accent swaps the `:root` alias block the token file explicitly
  invites you to swap, and adds no token. An app that *brings its own* declares
  it locally in its own `app.css` under `[data-app="…"]` and leaves the shared
  file untouched. Datebänkli is the second case.

  **This repo's `chalk-tokens.css` is nevertheless the ring's reconciled
  master** (a deliberate choice, 2026-07-29): it carries all six accents at the
  contrast-corrected lightnesses, so a repo still on the old values is shipping
  primary buttons that fail AA. It exists twice on purpose —
  `chalk-design-system/` is the portable copy to paste into the next app,
  `app/src/web/assets/` is the one this app serves — and `test/chalk.test.mjs`
  asserts they are byte-identical, because the copy that gets synced out is not
  the copy anyone edits.

- **Icon:** `database` (Material Symbols Rounded)
- The result grid maps directly onto the existing **Table / preview** recipe:
  `--surface-2` header row, mono uppercase labels, numeric cells right-aligned
  in tabular mono
- Errors use `--bad-tint` / `--bad-ink` status banners; successful runs use
  `--ok-*`; the SQL editor uses IBM Plex Mono
- Desktop-first layout (`max-width: 1180px`, two-column split collapsing under
  ~820px) — this one is genuinely a laptop tool, though the teacher's live
  lesson view should work on a phone

---

## 8a. Language (i18n)

**German is the default; a dropdown switches to English.**

> **Built as phase 6b, and four things below did not survive contact.** They are
> struck through in place rather than deleted, because the reasoning that
> replaced them is worth more than the original. HANDOFF §4mm has the arguments
> in full; §4nn has what the plumbing actually does.
>
> 1. **No `class.default_locale`** — the recommendation below was not taken.
>    Per-user only, for now, with the November-student failure accepted.
> 2. **No `localStorage["chalk-lang"]` mirror**, and **no top-bar button** — both
>    describe a `chalk-theme` convention that does not exist in this repo. There
>    is no theme toggle and no stylesheet at all. The control is a bare `<select>`
>    in each page's nav; the shell is phase 7's.
> 3. **The server does not render the initial page in the stored locale**, so
>    there *is* a frame of German. `routes/pages.ts` sends a byte-for-byte
>    constant and has no templating; adding it was not worth one frame.
> 4. **The `de-CH` question was posed wrongly.** It is `de-CH`/`en-CH` — the
>    language subtag follows the interface, the region subtag never moves. See
>    below; it was never "Swiss or English".

**Both locales are a real requirement, confirmed 2026-07-28, and the reason
shapes the design.** The school has students whose German is weak *and*
immersion classes taught entirely in English. Those are two different users:
the first switches an otherwise-German page for themselves, the second works in
English by default for a whole term. English is therefore a first-class locale
and not a courtesy fallback — which is what makes the per-class question below
worth answering before the sweep starts, rather than after twenty students have
been switched one at a time.

- Key-based lookup against `i18n/de.json` and `i18n/en.json`. No framework —
  a `t("query.run")` helper over a flat JSON object is enough at this size.
- Preference stored per user in `app_user.locale` (so it follows them between
  devices) and mirrored to `localStorage["chalk-lang"]`, matching the existing
  `chalk-theme` convention. Server renders the initial page in the stored
  locale so there's no flash of German.
- The language dropdown sits next to the theme toggle — a 36–38 px bordered
  square button per the Chalk top-bar recipe.
- **SQL keywords always stay English.** `SELECT` is `SELECT` in every locale.
- **An immersion class needs a default, not twenty switches.** `app_user.locale`
  stays the per-user source of truth — a student must be able to change it — but
  something has to set it at creation. Two options, and the second is the
  recommendation: a `class.default_locale` column that new members inherit
  (a migration, and a second piece of state that can disagree with the user's),
  or a locale select on the roster's bulk-create form applied to the batch
  (no migration, no new concept, and the same form already creates every
  student). Only the first survives a student added to the class next month by
  someone who forgets.
- **UI language is not data locale, and conflating them is the trap.** ~~The
  hardcoded `'de-CH'` in `Intl.NumberFormat` and `toLocaleDateString` is about
  the *data* — Swiss business figures written `1'234.50`, dates `03.04.2025` —
  and a student reading the interface in English is still working with Swiss
  data in a Swiss class.~~ **The question was posed wrongly, and the answer is
  both.** The dilemma above assumes "follow the UI" means `en-US`. It does not:
  a locale tag has a language subtag *and* a region subtag, and they answer
  different questions here. The four sites (not three — `roster.js` was missed)
  now use **`de-CH` / `en-CH`**, so the region — and with it the apostrophe
  separator, the day-first date and the 24-hour clock — never moves, while the
  language does. The only visible difference between the two is date
  zero-padding.

  Two things this rests on. The classroom constraint: two students side by side
  must see the same numbers, or they debug the formatter instead of the query —
  which `en-CH` satisfies and `en-US` would not. And the scope: these four
  format *chrome* (row counts, durations, a login date). The result grid never
  touches `Intl` at all — §4l has the app return dates as text from Postgres
  precisely so the process zone cannot reach a student's data, and the Swiss
  formatting of the values is the databases' ICU `de-CH` collation, server-side.
  `formats()` in `web/assets/i18n.js` is the single place the rule lives.

**Postgres error messages** are a special case worth getting right. Postgres
*can* localise them via `lc_messages='de_DE.UTF-8'`, but the alpine image ships
no German locale and the translations are uneven. Better approach: keep Postgres
in English and add our own **hint layer** — we match on `SQLSTATE` and render a
short explanation in the active locale above the raw error:

> `ERROR: relation "kunde" does not exist` (42P01)
> **Die Tabelle `kunde` gibt es nicht.** Meintest du `kunden`? Mit `\dt` bzw. der
> Tabellenliste links siehst du alle deine Tabellen.

Covering the ~15 most common codes (`42P01` unknown table, `42703` unknown
column, `42601` syntax error, `23505` duplicate key, `23503` FK violation,
`22P02` bad input syntax, `42883` no such function, `57014` cancelled/timeout…)
covers the overwhelming majority of what beginners hit. This is one of the
highest-value teaching features in the whole app and costs maybe half a day.

**Built as phase 6a** (`web/assets/hints.js`, 20 codes, `test/hints.test.mjs`),
and three details of the estimate above turned out differently:

- **`57014` is not in it.** The page short-circuits on `outcome.cancelled` and
  renders the reason it already knows — the student's own Cancel, or the
  timeout — which is strictly more than the SQLSTATE could say.
- **`42803`** (a column missing from `GROUP BY`) was not on the list and is one
  of the two most valuable entries; so is **`42804`**'s `WHERE name` case.
- **The did-you-mean is real**, not illustrative: it reads the schema tree the
  page already holds, so it can only ever name something Postgres would let
  that student read — the same argument the editor's autocomplete rests on. It
  returns nothing rather than guess, and HANDOFF §4jj/§4kk record what the
  message parsing and the identifier interpolation each cost to get right.

**6a was monolingual by construction, and 6b undid that — as specified below,
which is the one part of this section that survived unamended.** Each handler in
`hints.js` returned a finished German sentence, so the analysis and the phrasing
were fused. They are not the same thing: *which* message shape matched, and
*which* catalog object is the near miss, are locale-independent; only the
sentence is not. The 6b change is for a handler to return a key plus its
substitutions — `{ key: 'table.unknown', name, suggestion }` — and for the
phrasing to move into `de.json`/`en.json` beside every other string. Doing it by
duplicating twenty handlers into an English copy would double the branching
logic, and the branching is the part that was hard to get right.

Note also that an English-locale student still wants the hints. Postgres speaks
English and they can read it, but `42803` is not explained by
`column … must appear in the GROUP BY clause` — it is restated by it. The hint
earns its place in both locales.

---

## 8b. Account lifecycle

Strict isolation is **always** on — no peer-visibility mode, no teacher toggle
for it. Removing that requirement simplifies the grant model: the only non-owner
grant that ever exists on a student schema is the read-only one to their own
teacher.

Three states, and **nothing is ever deleted automatically**:

| State | What it means |
|---|---|
| **active** | Normal. Can log in, owns their schema. |
| **archived** | Automatic after **1 year** of inactivity. PG role set `NOLOGIN`; schema kept intact but revoked to read-only. Still listed (greyed) in the teacher's roster, restorable to active in one click. |
| **cold** | Optional, admin-triggered when disk pressure warrants. `pg_dump -Fc --schema=…` to `/mnt/bulk`, then `DROP SCHEMA … CASCADE`. Restorable from the dump. |
| **deleted** | **Teacher-initiated only, never automatic.** Always writes a dump to the archive first, then drops schema and role. |

Disk maths: 300 students × 50 MB worst case is 15 GB/year, realistically far
less, and small against any bulk volume worth pointing it at. So the *cold*
stage will probably never be
needed — it exists so you have a lever rather than a surprise.

A nightly job flips `active → archived` past the 1-year mark and flags the
owning teacher, so archival is never silent. Built in phase 5b: it runs inside
the app at 03:40 local (after `db/backup.sh`'s 03:17, so that night's backup
holds the pre-sweep state), keys off `coalesce(last_active_at, created_at)`, and
touches students only. "Flags" is the roster's own greyed-out row plus an
`archive_swept` audit entry naming the batch — see §10 (4) for why not email.

**A student always belongs to at least one class.** Removing them from their
last roster is refused. Authorisation is "your students are the students in your
classes", so a classless student would be reachable by nobody but an admin —
absent from every roster, unrestorable, yet still owning a schema full of work.
Moving a student means adding them to the new class first; getting rid of one
means `deleted`, which takes the dump.

---

## 9. Build plan

Effort is given in human-developer-days — read it as a *relative difficulty
ranking*, not a schedule. See `docs/HANDOFF.md` for actual status.

| Phase | Scope | Rough effort |
|---|---|---|
| **0** ✅ | Compose stack, Postgres bootstrap, migrations, `demo` seed data | 0.5 day |
| **1** ✅ | Auth, sessions, the three app roles, admin → teacher → student CRUD | 1.5 days |
| **2** ✅ | Provisioning engine (roles, schemas, grants, quotas, reset, archive) | 1 day |
| **3** ✅ | Student page: editor, execution, result grid, schema browser, cancel | 2 days |
| **4** ✅ | CSV upload with type inference | 1 day |
| **5** ✅ | Teacher roster, credential slips, live lesson view, lifecycle/archival job | 2 days |
| **6a** ✅ | The SQLSTATE hint layer (`web/assets/hints.js`) | 0.5 day |
| **6b** ✅ | i18n (de/en) — the larger half; see HANDOFF §8.0 for its measured size | 1 day |
| **7** ✅ | Chalk styling pass, dark mode, print CSS, deploy | 1 day |
| — | **v1 total — COMPLETE and deployed 2026-07-30** | **~10 days** |
| **9** ✅ | Exercises: authoring, per-student workspaces, hand-ins (§5). **Deployed 2026-08-07** | ~2 days |

Phases 0–3 alone give you something usable in a lesson.

**Phase 9 is built and DEPLOYED** (2026-08-07), on `0.9.0`. It carried
`meta/003_exercises.sql`, the second migration this project has deployed;
HANDOFF §7 records the run, which was uneventful and confirmed that the 5b
runbook generalises.

**It was called "phase 8" in this row until it was built, and the number moved.**
Work done after the Chalk pass had already been numbered 7.2, "8" and "8.1" as it
went, so an `8` here meant two different things depending on which document a
reader opened. The exercises phase is **9** everywhere now, and 8 is retired
rather than reused.

**Auto-checking and the class matrix are no longer in this row**, which is why
the estimate came down. §5 has the argument: they were dropped as a product
decision, not deferred as scope.

---

## 10. Resolved decisions

1. ~~Server specs~~ — confirmed sufficient by a wide margin (§7)
2. ~~UI language~~ — German default, English via dropdown (§8a). **Built and
   deployed in phase 6b** (2026-07-28), with three of §8a's own recommendations
   overruled by the implementation (HANDOFF §4mm) and §8a amended in place so it
   no longer describes a design that was not built:

    - **No `class.default_locale`.** German first for everyone with a toggle is
      the intended design, not a shortfall — so there is no state to inherit and
      nothing that silently reverts. The wire is ready if it is ever wanted:
      `POST /api/classes/:id/students` takes a per-student `locale`, so the
      form-select version is zero backend work and only the column is a
      migration.
    - **`de-CH` and `en-CH`, not `en-US`** — the region tag is the Swiss part and
      the language tag is the interface part, so §8a's "follow the UI *or* stay
      Swiss" was a trade that did not exist. Two students side by side see the
      same numbers in the same shape; only zero-padding on dates differs.
    - **The control is a bare `<select>` in each nav, and the top bar is phase
      7's.** §8a's 36–38 px button beside the theme toggle has nothing to sit
      beside: there is no top bar, no theme toggle and no stylesheet in this
      repo. §8a's `localStorage["chalk-lang"]` mirror was skipped for the same
      reason — it was specified to match a convention that does not exist yet.
    - **The server cannot render the initial page in the stored locale.**
      `routes/pages.ts` reads each file once at boot and sends the identical
      string every request, so §8a's "no flash of German" would mean introducing
      templating. Every page ships German in its markup and swaps it after
      `/api/me` answers — and that German is also the fallback when the script
      does not run at all (HANDOFF §4k, §4nn).

3. ~~Peer visibility~~ — no; strict isolation always (§8b)
4. ~~Account lifecycle~~ — archive after 1 year, teacher-initiated deletion only,
   never automatic (§8b). **Built and deployed in phase 5b** (2026-07-28), with
   four things §8b left open settled by the implementation (HANDOFF §4ee, §4ff)
   and one real student driven through cold storage and back on the server:

    - **`cold` keeps the role NOLOGIN and drops only the schema.** The schema is
      the disk; a `pg_authid` row is not. That is what makes the restore the
      same identifier, the same stored password and no new credential slip.
    - **`cold -> active` restores automatically**, so §8b's "restorable from the
      dump" means one click rather than a runbook. It cannot run as `dbk_app` —
      NOINHERIT locks it out of the schema the moment the dump transfers
      ownership — so it runs `--role` with the dump's schema entry filtered out
      of a `--use-list`, and it proves itself by connecting *as the student*.
    - **The nightly sweep runs in the app process**, not host cron: it is the
      `user_state` machine, `audit_log` and `destroyUserSessions`, and a bash
      job would be a second copy of `setUserState` that can drift. Safe because
      the scheduled half is non-destructive; the destructive half (`cold`) is
      admin-triggered and has no scheduler at all.
    - **"Emails/flags the owning teacher" is the roster plus `audit_log`.**
      There is no mail path and adding one is a fifth runtime dependency; the
      roster already renders a non-active student as a tag with "Aktivieren"
      beside it, and a `via: 'sweep'` audit row answers *why* and *when*.
      Revisit if a teacher ever asks to be told rather than to look.

5. ~~Provisioning without superuser~~ — `dbk_app` with `CREATEROLE` suffices;
   the three traps are in §2 and are covered by tests (phase 2)
6. ~~Where the archive dump runs from~~ — `pg_dump --role`, §2
7. ~~What a script does when one statement fails~~ — nothing survives it. The
   simple protocol wraps the whole string in an implicit transaction, so a
   failure in the third statement rolls the first two back. Not a choice we
   made; the editor states it plainly instead of pretending otherwise
   (phase 3, HANDOFF §4f)
8. ~~Where the schema browser's data comes from~~ — a dedicated route reading
   `pg_catalog` over a connection opened *as the student*, not a catalog query
   pushed through `/api/query`. The privilege filters are the isolation, and
   `query_log` stays a record of what students actually wrote (phase 3)
9. ~~How the disk quota is enforced~~ — measured on demand per request, not by
   a background job, and refusing only statements that could grow the schema.
   It bounds accumulation rather than any single statement; §3's second box
   says why that is the honest claim (phase 3, HANDOFF §4q)
10. ~~Collation~~ — **ICU `de-CH`, on both databases**, set at `CREATE DATABASE`
    in `db/init/00-bootstrap.sh` (2026-07-28) and **live on the deployed
    instance since the same day**, which required recreating the cluster while
    it was still empty. The alternative was to leave
    `C.UTF-8` and teach `COLLATE "de-CH-x-icu"` as a lesson; it lost because the
    wrong output arrives before the lesson does. Under `C` the very first query
    a class runs, `SELECT * FROM demo.schuelerinnen ORDER BY nachname`, returns
    Bühler, Küng and Rüegg *after* Zimmermann, and `'apfel' > 'Zebra'` — so the
    student's first encounter with `ORDER BY` is a result they have to be told
    to ignore. A `COLLATE` clause can still be taught on top of a sane default;
    a byte-order default cannot be untaught. Three consequences:

    - `LOCALE_PROVIDER icu` is now a **hard requirement** of the image. The
      bootstrap probes for it before creating anything and refuses to continue
      without it, rather than falling back — see HANDOFF §4x.
    - `upper('straße')` becomes `'STRASSE'` rather than `'STRAßE'`, and mixed
      case sorts `apfel, Apfel, Ärzte` instead of all uppercase first. Both are
      what a Swiss class expects; neither is what byte order gives.
    - A dump of these databases will not restore into a server built without
      ICU. `db/backup.sh` records the provider in each backup's `MANIFEST` so
      that is discovered before the restore, not during it.

11. ~~How the lesson view shows a student who is being refused~~ — as **state,
    not as an event**. A quota refusal writes no `query_log` row on purpose
    (HANDOFF §4s), which would leave "refused on every keystroke" and "hasn't
    started" looking identical in the one view whose job is telling them apart.
    The answer is not to log the refusal but to carry the student's current
    disk usage beside their activity, so the silence explains itself and
    `query_log` keeps meaning "this reached Postgres" (phase 4, HANDOFF §4z).

12. ~~Whether the hint layer should name the student's own tables~~ — **yes,
    and only when the catalog backs it up.** §8a's `Meintest du kunden?` was
    written as an illustration; phase 6a made it literal, because the page
    already holds the schema tree and a suggestion drawn from it can only name
    an object that student may read. The rule that makes it safe is that
    `hints.js` returns nothing rather than a plausible guess: an unlisted
    SQLSTATE, a message whose shape it does not recognise, or a name with no
    close match all produce no hint, and the raw Postgres text — which is the
    only part certainly true — always stays on screen underneath.

    The corollary, learned the hard way (HANDOFF §4kk): a name a student chose
    is *data*, and a dot in it is not necessarily a schema. `CREATE TABLE
    "kunden.2025"` is legal, and its error is indistinguishable from a
    schema-qualified one. The catalog, not the message, decides.

13. ~~The Chalk pass~~ — **built and verified locally in phase 7** (2026-07-29),
    not yet deployed. Six pages, one stylesheet, a real top bar, light/dark, and
    the language `<select>` finally has a shell to sit in. Four decisions inside
    it are worth not re-litigating:

    - **The violet 300° accent is confirmed** (§8), and the whole reason it is
      defensible is that it changes hue and nothing else.
    - **Fonts are self-hosted, not loaded from Google**, against Chalk §3 and
      §11 which both name `fonts.googleapis.com`. The readers here are minors on
      school accounts and the CDN would see their IP on every page load;
      tscheggsch reached the same conclusion independently, as a code-review
      finding. `app/tools/vendor-fonts.mjs` vendors them, and **Material Symbols
      is subsetted by `icon_names` to the ~27 glyphs this app draws** — 5 KB
      instead of 361 KB. An icon outside that list renders as its own name in
      words, which is the loud failure that makes the subset safe to take.
    - **`localStorage["chalk-lang"]` exists now, and it is a cache, not an
      authority.** §8a asked for it and 6b skipped it for want of a convention.
      The question that deferred it — "which side wins on a second device?" —
      turned out to be the wrong shape: there are not two sides.
      `app_user.locale` decides, and the key only chooses the language of the
      *first frame*, before `/api/me` answers. `paintCached()` reads it; the
      authoritative `load()` immediately overwrites both the DOM and the key.
      This is deliberately **asymmetric with `chalk-theme`**, which sits beside
      it and *is* authoritative — the theme is about a screen, the language is
      about a person.
    - **The theme toggle's `aria-label` has exactly one owner**, and this cost a
      real bug to learn: the button also carried a `data-i18n-attr`, `apply()`
      runs after the toggle paints, and so a reader in dark mode saw the
      "switch to light" icon beside the label "switch to dark". The two only
      agree in whichever mode the author is testing in. `wireThemeToggle` now
      owns the attribute and returns its paint function for the page to re-run
      once the locale settles.

14. ~~What identifies a running build~~ — **a version and a build time, shown
    together in a footer on every page** (phase 7.1). `package.json`'s version is
    bumped by hand per phase; `tools/stamp-build.mjs` writes the timestamp during
    `postbuild` and cannot be forgotten. The pairing is the decision: a semver
    alone sat at `0.1.0` through seven phases and five deploys, so it would have
    confidently named the wrong release, while a timestamp beside it makes a
    stale version merely uninformative. Served by a **public** `GET /api/version`
    rather than a field on `/api/me`, because `login.html` has no session and is
    the page a confused reader is most likely to be on; a build stamp is a fact
    about the deployment, not about anyone using it.

15. **Phase 7.2 — the student sees their own quota, and the CSV pane explains
    itself** (2026-07-29, built and not yet deployed; HANDOFF §4tt).

    - **`/api/workspace` carries the quota; `catalog.read` does not.** The tree
      is read *as the student*, because `has_*_privilege` answering for
      `current_user` is the isolation boundary (§3). The quota is read as
      `dbk_app` against `pg_class`, because as the student it would answer zero
      (HANDOFF §4o). They are joined in the route so that neither service has to
      hold both rules — and because `routes/lesson.ts` shares the reader for the
      teacher's drill-down, where this number already comes from
      `services/lesson.ts`. One screen, one source.
    - **A failed measurement answers `quota: null` and the tree still renders.**
      The pane exists for the tree; the quota is an extra, and an extra must not
      be able to take the essential thing down with it. Same bargain as
      `hintFor` returning null rather than guessing.
    - **The figure is formatted by one shared function.** The argument for
      showing a student their usage is that it is the *same* number their
      teacher reads, so `mb()` moved to `web/assets/util.js` rather than being
      written a second time. Two `toFixed` calls is how that claim quietly stops
      being true.
    - **`2BP01` joined the hint catalogue**, and it is the CSV import's
      characteristic failure rather than the editor's: "replace existing table"
      drops without `CASCADE` on purpose, so a view built on the old table
      blocks the re-import. The import dialog does not render `error.detail`,
      which makes the hint the only place the blocking object is named.
    - **`db/verify-isolation.sh` tears down at both ends, asserts it worked, and
      now refuses to run where its fixture names are real accounts.** It
      previously cleaned up only on entry, so every run leaked two `LOGIN` roles
      — but chasing that turned up the larger problem: the script *drops* those
      names, one of them (`t_schaffner`) is a real teacher on the deployed
      cluster, and its header told you to run it there. The fixtures collide
      with `/roster`'s output by construction, since every generated name begins
      `u_` or `t_`. The guard reads `app_user` in the meta database, fails
      closed, and treats only `deleted` as a free name. HANDOFF §4tt.

16. **Phase 7.3 — cold storage and deletion get buttons** (2026-07-30, built and
    not yet deployed; HANDOFF §4uu). §8b specified both states and 5b built
    both; this is only the UI, and every route it calls was already tested.

    - **Two destructive actions, two different weights of confirmation.** Cold
      takes one confirm because it is reversible — "Aktivieren" restores the
      dump, and that button predates this work. Deletion takes two, saying
      different things: the first names the person, the second names person and
      username and states what is destroyed against what survives. Escalating
      the reversible one to the same ceremony would teach the reader that the
      ceremony means nothing, which is how the ceremony on the irreversible one
      stops working.
    - **The copy does not overclaim in either direction.** Deletion writes a
      dump first and skips the drop if it fails, so the work survives on the
      server — but only `cold -> active` has a restore path, so the account does
      not. The strings say precisely that, and a failed dump is reported rather
      than swallowed: the row vanishes from the roster while the schema is still
      on disk, and a teacher not told would believe the disk was freed.
    - **Cold is admin-only and its button is absent for a teacher, not
      disabled.** §8b makes it a response to instance-wide disk pressure, which
      one teacher cannot see; `routes/students.ts` does not list the state for
      them, so a rendered button would return 400.
    - **Deletion stays teacher-initiated**, as §8b has said since the beginning.
      That is the one place these two diverge in permission, and it is not about
      which is more destructive: deletion is about a student who has left, cold
      is about the disk.

17. **Phase 7.4 — the boot order, and the sweep observed** (2026-07-30, built and
    not yet deployed; HANDOFF §4vv).

    - **The boot reconcile runs after `app.listen`, not before.** It can shell
      out to `pg_restore` at up to 300 s per account, sequentially, and doing
      that before binding the port turns a restore backlog into a container that
      fails its health check and restarts into the same backlog. The repair is
      not more urgent than serving. The cost is that a request can now land
      mid-reconcile, which `server.ts` argues is acceptable: DDL is serialised by
      Postgres, provisioning is idempotent, and the pass retries on the next
      boot.
    - **The nightly sweep has been watched firing**, which no run had ever done.
      The hour, minute and threshold are all environment variables, so this is
      cheap on a throwaway cluster and needs no production config change.
    - **The sweeper's log line names the zone it resolved** instead of saying
      "local", which reads as Swiss time and meant UTC. That decouples the
      honesty of the log from the still-open question of what `TZ` the container
      should use.
    - **`db/verify-isolation.sh`'s fixtures moved outside the app's namespace**
      (`vfy_*`). Every name the app can generate begins `u_` or `t_`, so §4tt's
      collision is now impossible by construction rather than merely caught; the
      guard stays as a tripwire.

### Still open

- ~~Deploy phase 7.1~~ — **done, 2026-07-29**, and now fully closed. It failed on
  the first attempt because `postbuild` referenced a directory the Dockerfile
  does not copy (HANDOFF §4ss); `COPY tools ./tools` fixed it. Both of the
  verifications it left have since been run: `/api/version` answered `0.7.0`
  with a `builtAt` from that deploy, and **the overnight locale check passed on
  2026-07-30** — a student came back to an expired session and was still in
  English, which confirms §8a's claim that `app_user.locale` is the only source
  of truth rather than the client cache.
- ~~Deploy 7.2 through 7.5~~ — **done.** The first attempt did not replace the
  running container (HANDOFF §4vv); re-run with a build, everything went out and
  production served `0.8.0` with the darkened accents. (It is `0.9.0` now —
  HANDOFF's front matter is the current answer, and `curl /api/version` is the
  authoritative one.)
- **What `TZ` the container should run in.** Still open and still a decision,
  but nothing depends on it any more: the sweeper's log line now prints the zone
  it resolved rather than claiming "local", so it is true either way (§4vv).
- ~~What `t_schaffner` is on the production cluster~~ — **a real teacher
  account**, confirmed 2026-07-30. Nothing leaked and nothing needs cleaning up.
  It did expose that `db/verify-isolation.sh` would have *destroyed* that
  account had anyone followed its own instruction to run it against the live
  server: every name the app generates begins `u_` or `t_` (§3's `ROLE_NAME`),
  so the script's fixtures were inside the real namespace by construction.
  Guarded in 7.2; HANDOFF §4tt. The fixtures were renamed to `vfy_*` in 8.1, so
  the collision is now impossible rather than caught.
- ~~**White on `--accent` measures 2.9:1 and fails WCAG AA**~~ — **fixed
  2026-07-30 by darkening the accents** (HANDOFF §4ww), which was the author's
  choice between that and changing the foreground. It keeps §7's white-on-accent
  pattern, so it is a token change rather than a pattern change.

  It was never one colour: `--accent` is a per-app alias and all six solids sat
  at L 0.68–0.705, so white failed on every app in the family. All six moved,
  hue and chroma untouched, each to the lightest L at which white clears 4.5 —
  the target differs per hue because luminance at a fixed OKLCH lightness does
  not. Datebänkli is `oklch(0.578 0.100 300)` and measures 4.50 in both modes.

  **Any repo still on the old values is behind this file until it is synced**,
  and its buttons are still at 2.5–2.9.
- **An account cannot be deleted once its `DBK_ENCRYPTION_KEY` is gone**
  (HANDOFF §4rr). The deletion path dumps the schema first and `pg_dump --role`
  needs the decrypted role password, so a key rotation strands every existing
  account. If that key ever needs rotating, the order is re-encrypt first.
- ~~§8 items 2 and 5 — no UI for cold storage and no delete button~~ — **done in
  phase 7.3**, taken together as one problem. See §10 (16).
