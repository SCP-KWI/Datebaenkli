#!/bin/bash
# Datebänkli — cluster bootstrap.
#
# Runs ONCE, as the postgres superuser, on the first start of an empty data
# directory (docker-entrypoint-initdb.d). Everything after this point is done
# by the app's migration runner as dbk_app.
#
# Creates:
#   role     dbk_app            — owns both DBs, provisions student roles
#   database datebaenkli_meta   — app data (users, classes, logs)
#   database datebaenkli        — the teaching database (student schemas + demo)
#
# Both databases are ICU `de-CH`, and this script refuses to run on a server
# that cannot do that — see the block below.
#
# Deliberately NOT superuser: dbk_app gets CREATEROLE only. See
# docs/ARCHITECTURE.md §2 and the provisioning caveat in docs/HANDOFF.md.

set -euo pipefail

if [ -z "${DBK_APP_DB_PASSWORD:-}" ]; then
  echo "FATAL: DBK_APP_DB_PASSWORD is not set" >&2
  exit 1
fi

# --- collation ---------------------------------------------------------------
# Both databases are created with ICU `de-CH`, not the container's C.UTF-8.
# Under C the comparison is on bytes, so `ORDER BY nachname` over the demo data
# returns Bühler, Küng and Rüegg *after* Zimmermann, and 'apfel' after 'Zebra'.
# That is the first query a class runs, and explaining UTF-8 byte order is not
# the lesson. See docs/ARCHITECTURE.md §10.
#
# The meta database gets it too, though no student ever queries it: the teacher's
# roster is `ORDER BY lower(display_name)` (services/users.ts) over exactly the
# same Swiss names, and one rule for the deployment is easier to keep true than
# two.
#
# Probed before anything is created, and on purpose: a CREATE DATABASE that
# fails mid-script leaves a half-initialised data directory, and the container
# then restart-loops until someone deletes pgdata. The probe turns that into one
# sentence in the log. It asserts the *behaviour* rather than the presence of a
# collation name, because an ICU build carrying only root locale data would
# answer to `de-CH-x-icu` and still be worth having.
#
# Deliberately not a fallback to C.UTF-8 on failure: a fallback hands you the
# exact database this exists to prevent, silently, and you find out a term later
# when the database can no longer be changed without destroying student work.
icu_sorts_de="$(psql -tAX --username "$POSTGRES_USER" --dbname postgres \
  -c "SELECT ('Zürcher' COLLATE \"de-CH-x-icu\") < ('Zwahlen' COLLATE \"de-CH-x-icu\")" \
  2>/dev/null || true)"

if [ "$icu_sorts_de" != "t" ]; then
  echo "FATAL: this PostgreSQL has no usable ICU 'de-CH' collation." >&2
  echo "       Datebänkli creates both databases with LOCALE_PROVIDER icu; a" >&2
  echo "       server built without --with-icu, or an image missing icu-data," >&2
  echo "       cannot do that. The official postgres:17-alpine image can." >&2
  echo "       Nothing has been created. Fix the image, then:" >&2
  echo "         docker compose down && sudo rm -rf pgdata && docker compose up -d" >&2
  exit 1
fi

# Quoted heredoc + psql's :'var' interpolation, so a password containing
# quotes or backslashes cannot break out into SQL.
psql -v ON_ERROR_STOP=1 \
     -v app_pw="$DBK_APP_DB_PASSWORD" \
     --username "$POSTGRES_USER" \
     --dbname postgres <<-'EOSQL'

  CREATE ROLE dbk_app
    LOGIN
    PASSWORD :'app_pw'
    CREATEROLE
    NOSUPERUSER NOCREATEDB NOREPLICATION NOBYPASSRLS;

  -- TEMPLATE template0 is required to depart from the cluster's locale, and
  -- LC_COLLATE/LC_CTYPE are left unstated on purpose: they are inherited from
  -- template0, so this works whatever locale the image's initdb settled on.
  -- With an ICU provider they no longer decide sort order anyway.
  CREATE DATABASE datebaenkli_meta OWNER dbk_app
    TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER icu ICU_LOCALE 'de-CH';
  CREATE DATABASE datebaenkli      OWNER dbk_app
    TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER icu ICU_LOCALE 'de-CH';

  -- Nobody connects to these except dbk_app (meta) and provisioned
  -- students/teachers (teach, granted explicitly at provisioning time).
  REVOKE ALL ON DATABASE datebaenkli_meta FROM PUBLIC;
  REVOKE ALL ON DATABASE datebaenkli      FROM PUBLIC;
  GRANT  ALL ON DATABASE datebaenkli_meta TO dbk_app;
  GRANT  ALL ON DATABASE datebaenkli      TO dbk_app;
EOSQL

# Harden the public schema in each database. Postgres 15+ already revokes
# CREATE on public from PUBLIC, but being explicit costs nothing and documents
# the intent: students create objects in *their own* schema, never in public.
for db in datebaenkli_meta datebaenkli; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" <<-'EOSQL'
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    ALTER SCHEMA public OWNER TO dbk_app;
EOSQL
done

# The meta database must be unreachable for student and teacher roles.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname datebaenkli_meta <<-'EOSQL'
  REVOKE ALL ON SCHEMA public FROM PUBLIC;
EOSQL

# Take away the large-object constructors.
#
# A large object lives in `pg_largeobject`, which belongs to **no schema**. That
# one fact defeats three separate controls at once: `schemaUsage` walks
# `pg_class` and cannot see it, so it is unquotaed storage; `DROP SCHEMA ...
# CASCADE` does not remove it, so it survives "Datenbank zurücksetzen"; and
# `pg_dump --schema=` excludes it, so cold storage cannot preserve it either.
# `SELECT lo_from_bytea(0, repeat('a',100000000)::bytea)` needs no privilege
# beyond CONNECT, and on repeat it fills the disk for the whole school.
#
# Measuring it instead was tried and is not available: sizing needs SELECT on
# `pg_largeobject`, which is superuser-only, and joining it made the usage
# report throw 42501 for every caller.
#
# So the capability goes. Nothing in the app can create a large object — it
# takes hand-typed SQL in the editor — and no lesson uses one, so this costs
# nothing that anybody wanted. `lo_unlink`, `lo_get` and friends are left alone
# deliberately: someone who already owns one must still be able to look at it
# and throw it away.
#
# Must run as a superuser, because these functions are owned by `postgres` and
# only their owner may revoke. That is why it lives here rather than in a
# migration — `dbk_app` cannot do it. An existing cluster needs this applied by
# hand once; see docs/HANDOFF.md.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname datebaenkli <<-'EOSQL'
  REVOKE EXECUTE ON FUNCTION lo_from_bytea(oid, bytea) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION lo_creat(integer)         FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION lo_create(oid)            FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION lo_put(oid, bigint, bytea) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION lo_import(text)           FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION lo_import(text, oid)      FROM PUBLIC;
EOSQL

echo "Datebänkli: bootstrap complete (dbk_app, datebaenkli, datebaenkli_meta; ICU de-CH)."
