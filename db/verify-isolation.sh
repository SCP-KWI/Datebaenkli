#!/bin/bash
# Datebänkli — end-to-end check of the isolation model against a REAL Postgres.
#
# The unit suite (app/test) runs migrations in PGlite, which is single-user and
# therefore cannot execute a single GRANT. This script covers what it cannot:
# roles, grants, cross-student isolation, timeouts, reset and deprovisioning.
# Run it after any change to provisioning.
#
#   DBK_APP_DB_PASSWORD=... ./db/verify-isolation.sh
#   DBK_PGHOST=127.0.0.1 DBK_PGPORT=55432 DBK_APP_DB_PASSWORD=... ./db/verify-isolation.sh
#
# ## This script CREATES AND DROPS REAL ROLES. Two things stop that being
# ## dangerous, and both are here because it once was.
#
# It used to say "and once against the live server", and HANDOFF §4tt is why
# that line is gone. Its fixtures used to be `u_k3a_muster_lena`,
# `u_k3a_meier_tim` and `t_schaffner` — and `t_schaffner` is exactly what
# /roster names a teacher account for an author called Schaffner, so on the
# deployed cluster it was a real person. The teardown does `DROP OWNED BY
# CURRENT_USER CASCADE` before `DROP ROLE`, so following that instruction would
# have deleted that teacher and every table in their schema.
#
# 1. **The fixtures now live outside the namespace the app can generate.** Every
#    name /roster produces starts `u_` or `t_` (`db/ident.ts`'s ROLE_NAME), so a
#    `vfy_` prefix cannot collide with a real account by construction. That is
#    the fix; the guard below is the belt to its braces.
#
# 2. **The guard asks anyway**, before creating anything: does any fixture name
#    belong to a real account in the meta database? It fails closed — an
#    unreachable meta database is a refusal, not a shrug. With `vfy_` names it
#    should now never fire, which is the point: it is a tripwire for whoever
#    adds a fixture back inside the app's namespace.
#
# The live suites in app/test keep the realistic names deliberately. They are
# never pointed at production — that was always this script's exposure, not
# theirs — `test/support/live-pg.mjs` asserts their roles are gone afterwards,
# and names that look like a real class are what make those tests readable.
set -uo pipefail

: "${DBK_APP_DB_PASSWORD:?set DBK_APP_DB_PASSWORD (the dbk_app role password)}"
H="-h ${DBK_PGHOST:-127.0.0.1} -p ${DBK_PGPORT:-5432}"
APP_PW="$DBK_APP_DB_PASSWORD"
META_DB="${DBK_META_DB:-datebaenkli_meta}"
PASS=0; FAIL=0

# Every name this script may create, in one place. The guard, the teardown and
# the leak assertion all read it: three copies of a role list is how one of them
# ends up not covering a fixture somebody added.
#
# `u_test` used to be here, cleaned up but never created, left from an older
# revision. It is gone on purpose — it sits in the app's own namespace, and the
# one rule this script now has is that it never drops a name /roster could have
# produced. An ancient `u_test` on a dev cluster is therefore no longer tidied
# away by a run; that is the correct trade, because the same line pointed at
# production is the bug this file exists to have fixed.
#
# The provisioning block further down keeps its own literal list, because it is
# inside a quoted heredoc that deliberately does not expand.
FIXTURES=(vfy_lena vfy_tim vfy_teacher)
# The same list as a SQL literal: 'a','b','c'
FIXTURES_SQL=$(printf "'%s'," "${FIXTURES[@]}"); FIXTURES_SQL=${FIXTURES_SQL%,}

run() { PGPASSWORD="$2" psql $H -U "$1" -d "$3" -v ON_ERROR_STOP=1 -tAq -c "$4" 2>&1; }

ok() {
  if out=$(run "$2" "$3" "$4" "$5"); then echo "  PASS  $1"; PASS=$((PASS+1));
  else echo "  FAIL  $1"; echo "        $out" | head -2; FAIL=$((FAIL+1)); fi
}

# A denial counts only if Postgres refused on privilege grounds. A connection
# that fails because the role is missing or the password is wrong proves
# nothing — counting those as passes is how a suite goes green for the wrong
# reason. Note "FATAL: permission denied for database" IS a legitimate denial.
denied() {
  out=$(run "$2" "$3" "$4" "$5"); rc=$?
  if [ $rc -eq 0 ]; then
    echo "  FAIL  $1  << SUCCEEDED, SHOULD BE DENIED >>"; FAIL=$((FAIL+1)); return
  fi
  if echo "$out" | grep -qE 'does not exist|password authentication failed|Connection refused|could not translate'; then
    echo "  FAIL  $1  << could not connect; denial not proven >>"
    echo "        $(echo "$out" | head -1 | cut -c1-95)"; FAIL=$((FAIL+1)); return
  fi
  echo "  PASS  $1"
  echo "        └ $(echo "$out" | grep -m1 -oP '(ERROR|FATAL):.*' | cut -c1-92)"
  PASS=$((PASS+1))
}

# Every role this script may have created, students before the teacher. The
# order is the caller's to get right for the same reason `dropRoles` in
# `app/test/support/live-pg.mjs` says so: a teacher holds grants into her
# students' schemas, and dropping her first leaves those to fail.
#
# A function because it runs twice — once on entry and once on exit — and a
# second copy of a DROP ROLE list is the copy that goes stale.
teardown() {
  PGPASSWORD="$APP_PW" psql $H -U dbk_app -d datebaenkli -q -c "
DO \$\$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY[$FIXTURES_SQL] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('SET ROLE %I', r);
      EXECUTE 'DROP OWNED BY CURRENT_USER CASCADE';
      RESET ROLE;
      -- DROP OWNED BY covers objects *in* the database, not grants *on* it.
      EXECUTE format('REVOKE ALL ON DATABASE datebaenkli FROM %I', r);
      EXECUTE format('DROP ROLE %I', r);
    END IF;
  END LOOP;
END \$\$;" 2>&1 | grep -v '^$' | tail -2
}

# --- the guard: are any of these names real people? --------------------------
#
# `pg_roles` cannot answer this — a fixture role and a teacher's role are the
# same kind of object, which is the entire problem. `app_user` in the meta
# database is what distinguishes them: the app writes a row there for every
# account it creates, and this script writes none.
#
# `to_regclass` rather than assuming the table: a freshly bootstrapped cluster
# has the database but no migrations until the app has run once, and "no
# app_user table" genuinely means "no accounts", not an error.
#
# **`deleted` is excluded, and it is the only state that may be.** Deletion
# deprovisions — the app drops the role and the schema and keeps the row as a
# tombstone, so the *name* is genuinely free again and blocking on it would make
# this script unrunnable on any cluster where such an account once existed
# (which is exactly what the dev cluster looked like after 7.2's own fixtures
# were cleaned up). The other three all keep the role: `active` obviously,
# `archived` as NOLOGIN, and `cold` as NOLOGIN with the schema dumped away —
# for that last one the role *is* the account, so dropping it would strand a
# term's work in an archive nobody can restore against.
echo "=== checking these names are not real accounts ==="
REAL=$(PGPASSWORD="$APP_PW" psql $H -U dbk_app -d "$META_DB" -tAq -v ON_ERROR_STOP=1 -c "
  SELECT CASE
           WHEN to_regclass('public.app_user') IS NULL THEN ''
           ELSE coalesce((SELECT string_agg(username || ' (' || state || ')', ', ' ORDER BY username)
                            FROM app_user
                           WHERE username IN ($FIXTURES_SQL) AND state <> 'deleted'), '')
         END" 2>&1)
rc=$?

if [ $rc -ne 0 ]; then
  echo "  ABORT  could not reach $META_DB to check — refusing to create roles blind"
  echo "         $(echo "$REAL" | head -1 | cut -c1-100)"
  echo "         set DBK_META_DB, or point DBK_PGHOST/DBK_PGPORT at the right cluster"
  exit 1
fi
if [ -n "$REAL" ]; then
  echo "  ABORT  these are REAL accounts on this cluster: $REAL"
  echo "         This script drops every name it uses, schema and all. Running it"
  echo "         here would delete that account's work. See HANDOFF §4tt."
  exit 1
fi
echo "  ok    none of them exist as accounts here"

echo "=== teardown ==="
teardown

echo "=== provisioning as dbk_app (non-superuser) ==="
PGPASSWORD="$APP_PW" psql $H -U dbk_app -d datebaenkli -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['vfy_lena','vfy_tim','vfy_teacher'] LOOP
    EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB '
                   'NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 4',
                   r, 'pw_'||r);
    EXECUTE format('GRANT %I TO dbk_app WITH INHERIT FALSE, SET TRUE', r);
    EXECUTE format('CREATE SCHEMA %I AUTHORIZATION %I', r, r);
    EXECUTE format('GRANT CONNECT ON DATABASE datebaenkli TO %I', r);
    EXECUTE format('ALTER ROLE %I SET statement_timeout = %L', r, '15s');
    EXECUTE format('ALTER ROLE %I SET idle_in_transaction_session_timeout = %L', r, '60s');
    EXECUTE format('ALTER ROLE %I SET work_mem = %L', r, '8MB');
  END LOOP;
  FOREACH r IN ARRAY ARRAY['vfy_lena','vfy_tim'] LOOP
    EXECUTE format('SET ROLE %I', r);
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO vfy_teacher', r);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT ON TABLES TO vfy_teacher', r);
    RESET ROLE;
  END LOOP;
END $$;
SQL
rc=$?; [ $rc -eq 0 ] && echo "  provisioning ok" || { echo "PROVISIONING FAILED"; exit 1; }

LENA=pw_vfy_lena; TIM=pw_vfy_tim; TCH=pw_vfy_teacher

echo
echo "=== preconditions ==="
for pair in "vfy_lena:$LENA" "vfy_tim:$TIM" "vfy_teacher:$TCH"; do
  ok "${pair%%:*} connects" "${pair%%:*}" "${pair##*:}" datebaenkli "SELECT 1"
done

echo
echo "=== student's own schema ==="
echo "        search_path = $(run vfy_lena "$LENA" datebaenkli 'SHOW search_path')"
ok "Lena: CREATE TABLE unqualified" vfy_lena "$LENA" datebaenkli \
   "CREATE TABLE kunden(id int primary key, name text); INSERT INTO kunden VALUES (1,'Meier');"
echo "        landed in schema: $(run vfy_lena "$LENA" datebaenkli "SELECT schemaname FROM pg_tables WHERE tablename='kunden'")"

echo
echo "=== cross-student isolation (the whole point) ==="
denied "Tim CANNOT read Lena's table" vfy_tim "$TIM" datebaenkli \
   "SELECT * FROM vfy_lena.kunden"
denied "Tim CANNOT write into Lena's schema" vfy_tim "$TIM" datebaenkli \
   "CREATE TABLE vfy_lena.evil(x int)"
denied "Tim CANNOT drop Lena's table" vfy_tim "$TIM" datebaenkli \
   "DROP TABLE vfy_lena.kunden"

echo
echo "=== shared demo data ==="
ok "Tim reads demo.kantone" vfy_tim "$TIM" datebaenkli "SELECT count(*) FROM demo.kantone"
denied "Tim CANNOT modify demo data" vfy_tim "$TIM" datebaenkli \
   "UPDATE demo.kantone SET einwohner = 0"
denied "Tim CANNOT create tables in demo" vfy_tim "$TIM" datebaenkli "CREATE TABLE demo.evil(x int)"

echo
echo "=== blast radius ==="
denied "Tim CANNOT connect to the meta database" vfy_tim "$TIM" datebaenkli_meta "SELECT 1"
denied "Teacher CANNOT connect to the meta database" vfy_teacher "$TCH" datebaenkli_meta "SELECT 1"
denied "Tim CANNOT create objects in public" vfy_tim "$TIM" datebaenkli "CREATE TABLE public.evil(x int)"
denied "Tim CANNOT read server files" vfy_tim "$TIM" datebaenkli "SELECT pg_read_file('/etc/passwd')"
denied "Tim CANNOT COPY FROM a server path" vfy_tim "$TIM" datebaenkli "COPY demo.kantone FROM '/etc/passwd'"
denied "Tim CANNOT create a role" vfy_tim "$TIM" datebaenkli "CREATE ROLE sneaky LOGIN"
denied "Tim CANNOT grant himself superuser" vfy_tim "$TIM" datebaenkli \
   "ALTER ROLE vfy_tim SUPERUSER"
denied "Tim CANNOT raise temp_file_limit (SUSET, cluster-wide)" vfy_tim "$TIM" datebaenkli \
   "SET temp_file_limit = '10GB'"

echo
echo "=== teacher access ==="
ok "Teacher reads Lena's table" vfy_teacher "$TCH" datebaenkli "SELECT name FROM vfy_lena.kunden"
ok "Lena creates a NEW table after the grant" vfy_lena "$LENA" datebaenkli "CREATE TABLE bestellungen(id int)"
ok "Teacher reads that too (ALTER DEFAULT PRIVILEGES)" vfy_teacher "$TCH" datebaenkli \
   "SELECT count(*) FROM vfy_lena.bestellungen"
denied "Teacher CANNOT write to Lena's table" vfy_teacher "$TCH" datebaenkli \
   "INSERT INTO vfy_lena.kunden VALUES (2,'x')"

echo
echo "=== exercise workspaces (phase 9) ==="
#
# A second schema per student per exercise, owned by that student. Provisioned
# here exactly as `createWorkspace` does it, so what this checks is the SQL
# sequence rather than the app's opinion of it — which is the whole reason this
# script exists beside the live suite.
#
# No new fixture roles, deliberately: a workspace belongs to a student who is
# already in FIXTURES, so the guard at the top and the teardown at the bottom
# both already cover it. `DROP OWNED BY CURRENT_USER` drops every schema a role
# owns, not just the one named after it.
ok "provision a workspace for each student" dbk_app "$APP_PW" datebaenkli \
   "CREATE SCHEMA x91_vfy_lena AUTHORIZATION vfy_lena;
    CREATE SCHEMA x91_vfy_tim  AUTHORIZATION vfy_tim;
    SET ROLE vfy_lena;
      GRANT USAGE ON SCHEMA x91_vfy_lena TO vfy_teacher;
      GRANT SELECT ON ALL TABLES IN SCHEMA x91_vfy_lena TO vfy_teacher;
      ALTER DEFAULT PRIVILEGES IN SCHEMA x91_vfy_lena GRANT SELECT ON TABLES TO vfy_teacher;
    RESET ROLE;"
ok "Lena fills her own copy" vfy_lena "$LENA" datebaenkli \
   "CREATE TABLE x91_vfy_lena.uebung(id int primary key); INSERT INTO x91_vfy_lena.uebung VALUES (1);"
ok "Tim fills his" vfy_tim "$TIM" datebaenkli \
   "CREATE TABLE x91_vfy_tim.uebung(id int primary key); INSERT INTO x91_vfy_tim.uebung VALUES (1),(2);"

# The claim the whole design rests on, and both directions of it: one grant
# issued the wrong way round would leave the other of these passing.
denied "Tim CANNOT read Lena's workspace" vfy_tim "$TIM" datebaenkli \
   "SELECT * FROM x91_vfy_lena.uebung"
denied "Lena CANNOT read Tim's workspace" vfy_lena "$LENA" datebaenkli \
   "SELECT * FROM x91_vfy_tim.uebung"
denied "Tim CANNOT write into Lena's workspace" vfy_tim "$TIM" datebaenkli \
   "INSERT INTO x91_vfy_lena.uebung VALUES (99)"

ok "Teacher reads Lena's workspace" vfy_teacher "$TCH" datebaenkli \
   "SELECT count(*) FROM x91_vfy_lena.uebung"
denied "Teacher CANNOT write to it" vfy_teacher "$TCH" datebaenkli \
   "DELETE FROM x91_vfy_lena.uebung"
# She was never granted Tim's. That is what a per-student grant means, and it is
# the case that would silently pass if the grant were issued to PUBLIC.
denied "Teacher CANNOT read a workspace she was not granted" vfy_teacher "$TCH" datebaenkli \
   "SELECT * FROM x91_vfy_tim.uebung"

# "Reset this exercise" — the narrow drop, and the reason a workspace is its own
# schema rather than prefixed tables. Everything else the student owns has to
# come through it untouched.
ok "reset ONE workspace" dbk_app "$APP_PW" datebaenkli \
   "SET ROLE vfy_lena; DROP SCHEMA x91_vfy_lena CASCADE; RESET ROLE;"
ok "Lena's own tables survived it" vfy_lena "$LENA" datebaenkli "SELECT name FROM kunden"
ok "Tim's copy of the same exercise survived it" vfy_tim "$TIM" datebaenkli \
   "SELECT count(*) FROM x91_vfy_tim.uebung"

echo
echo "=== statement_timeout: accident vs deliberate circumvention ==="
start=$(date +%s)
denied "runaway query cancelled by the role default" vfy_tim "$TIM" datebaenkli "SELECT pg_sleep(30)"
echo "        └ after $(( $(date +%s) - start ))s (role default 15s)"

echo "  -- now Tim deliberately tries to lift the limit --"
if run vfy_tim "$TIM" datebaenkli "SET statement_timeout = 0; SELECT pg_sleep(18)" >/dev/null 2>&1; then
  echo "  NOTE  Tim CAN disable statement_timeout in-session (SET is USERSET)"
else
  echo "  NOTE  in-session SET statement_timeout was refused"
fi
if run vfy_tim "$TIM" datebaenkli "ALTER ROLE vfy_tim SET statement_timeout='1h'" >/dev/null 2>&1; then
  echo "  NOTE  Tim CAN persist a higher statement_timeout on his own role"
  run dbk_app "$APP_PW" datebaenkli "ALTER ROLE vfy_tim SET statement_timeout='15s'" >/dev/null
else
  echo "  NOTE  Tim cannot persist a higher statement_timeout"
fi

echo
echo "=== reset / deprovision (corrected sequence) ==="
ok "Reset: SET ROLE, DROP, RESET, recreate as dbk_app" dbk_app "$APP_PW" datebaenkli \
   "SET ROLE vfy_tim; DROP SCHEMA vfy_tim CASCADE; RESET ROLE;
    CREATE SCHEMA vfy_tim AUTHORIZATION vfy_tim;"
ok "Tim still works after reset" vfy_tim "$TIM" datebaenkli "CREATE TABLE neu(x int)"

echo
echo "=== full deprovision (teacher deletes a student) ==="
ok "Deprovision Tim entirely" dbk_app "$APP_PW" datebaenkli \
   "SET ROLE vfy_tim; DROP OWNED BY CURRENT_USER CASCADE; RESET ROLE;
    REVOKE ALL ON DATABASE datebaenkli FROM vfy_tim;
    DROP ROLE vfy_tim;"
if [ "$(run dbk_app "$APP_PW" datebaenkli "SELECT count(*) FROM pg_roles WHERE rolname='vfy_tim'")" = "0" ] &&
   [ "$(run dbk_app "$APP_PW" datebaenkli "SELECT count(*) FROM information_schema.schemata WHERE schema_name='vfy_tim'")" = "0" ]; then
  echo "  PASS  role and schema fully gone"; PASS=$((PASS+1))
else
  echo "  FAIL  leftovers after deprovision"; FAIL=$((FAIL+1))
fi
ok "Lena is unaffected by Tim's deletion" vfy_lena "$LENA" datebaenkli "SELECT name FROM kunden"

# Lena and her teacher have to survive the case above — it is the whole point of
# it — so they are still here, and until 7.2 the script simply ended and left
# them. The teardown at the top made a *re-run* clean, which hid it: on a
# throwaway cluster the next run tidies up, and there is never a next run on the
# server this file's header tells you to point it at once. Two permanently burnt
# identifiers, by the same mechanism as HANDOFF §4u.
#
# The assertion is the half that matters, and it is not optional (CLAUDE.md, on
# `dropRoles`): a teardown whose failure is swallowed is indistinguishable from
# one that worked, which is exactly how §4ii went unnoticed for months.
echo
echo "=== teardown, and the proof that it took ==="
teardown
LEFT=$(run dbk_app "$APP_PW" datebaenkli \
  "SELECT count(*) FROM pg_roles WHERE rolname IN ($FIXTURES_SQL)")
if [ "$LEFT" = "0" ]; then
  echo "  PASS  no throwaway role survived the run"; PASS=$((PASS+1))
else
  echo "  FAIL  $LEFT throwaway role(s) still in pg_roles — a live cluster just lost those names"
  FAIL=$((FAIL+1))
fi

echo
echo "================================================"
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
