#!/bin/bash
# Datebänkli — nightly dumps of both databases.
#
# Runs on the HOST, from cron or a systemd timer, and reaches the database
# through `docker exec`. Three consequences, all of them the reason it is
# written this way:
#
#   * No password is anywhere in the backup path. The official image trusts the
#     local socket, so `docker exec -u postgres` is already a superuser
#     connection. Nothing here reads a credential, so nothing here can leak one.
#   * The files are written by the *host* user. The db container runs as uid 70
#     and cannot write to /mnt/bulk/datebaenkli, which is uid 1000 (the app
#     container's `node`); dumping to stdout and redirecting on this side
#     avoids the whole ownership question rather than solving it.
#   * pg_dump and pg_restore come out of the container, so the host needs no
#     postgres client. It has none, and no node either (HANDOFF §4w).
#
# The two databases are dumped one after the other and so are not mutually
# consistent: an account created between the two dumps exists in meta with no
# role in teach. That is exactly the drift `services/reconcile.ts` repairs on
# boot, which is why this does not deserve a maintenance window.
#
#   backup.sh           take a backup, then prune to the newest $DBK_BACKUP_KEEP
#   backup.sh --check   exit non-zero if the newest backup is too old
#
# Install (host, as the owner of /mnt/bulk/datebaenkli):
#   crontab -e
#   17 3 * * * flock -n /tmp/dbk-backup.lock /opt/apps/datebaenkli/db/backup.sh >> /var/log/dbk-backup.log 2>&1
#
# Restoring is in docs/HANDOFF.md §7. Read it before you need it.

set -euo pipefail

BACKUP_DIR="${DBK_BACKUP_DIR:-/mnt/bulk/datebaenkli/backups}"
KEEP="${DBK_BACKUP_KEEP:-14}"
MAX_AGE_HOURS="${DBK_BACKUP_MAX_AGE_HOURS:-26}"
INCLUDE_ENV="${DBK_BACKUP_ENV:-1}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# `${VAR-default}`, not `${VAR:-default}`: setting DBK_DB_EXEC to the empty
# string means "the postgres client is on this machine, run it directly", which
# is how this is exercised against a throwaway cluster (HANDOFF §6).
#
# `-i` is in the default because the verification step pipes a dump back in, and
# a `docker exec` without it gets EOF and silently succeeds at nothing (§7).
# Do not add `-t`: a TTY would corrupt the binary dump on its way to stdout.
read -r -a DB_EXEC <<<"${DBK_DB_EXEC-docker exec -i -u postgres datebaenkli-db}" || true

# Published runs only. `! -name '*.partial'` is the load-bearing half: without
# it a run that died half way through counts as the newest backup, which is the
# one thing this script exists to make impossible.
complete_runs() {
  find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '2*' ! -name '*.partial' \
    2>/dev/null | sort || true
}

# --- backup.sh --check -------------------------------------------------------
# The way scheduled backups actually fail is not a crash, it is a timer that
# quietly stopped months ago. This is the line to hang a monitor on.
if [ "${1:-}" = "--check" ]; then
  newest="$(complete_runs | tail -1)"
  if [ -z "$newest" ]; then
    echo "FAIL: no backup in $BACKUP_DIR" >&2
    exit 1
  fi
  age_h=$(( ( $(date +%s) - $(stat -c %Y "$newest") ) / 3600 ))
  if [ "$age_h" -gt "$MAX_AGE_HOURS" ]; then
    echo "FAIL: newest backup $(basename "$newest") is ${age_h}h old, limit ${MAX_AGE_HOURS}h" >&2
    exit 1
  fi
  echo "ok: $(basename "$newest"), ${age_h}h old"
  exit 0
fi

# --- take the backup ---------------------------------------------------------

stamp="$(date +%Y-%m-%d_%H%M%S)"
run="$BACKUP_DIR/$stamp"
part="$run.partial"

mkdir -p "$BACKUP_DIR"
# The meta dump holds session tokens, scrypt hashes and every student's
# encrypted Postgres password; the globals dump holds SCRAM verifiers.
chmod 700 "$BACKUP_DIR"

rm -rf "$part"
mkdir -p "$part"
chmod 700 "$part"

# Everything is built under `<stamp>.partial` and published by a single rename.
# `--check` and the retention pass both ignore `.partial`, so an interrupted run
# is never mistaken for a backup — a truncated dump under the real name is worse
# than no dump at all, because you discover it while restoring.
trap 'rc=$?; [ "$rc" -eq 0 ] || echo "backup FAILED (exit $rc); kept $part for inspection" >&2' EXIT

dump_db() {
  local db="$1" out="$part/$2"
  "${DB_EXEC[@]}" pg_dump --format=custom --no-password --dbname "$db" >"$out"
  # Reading the archive's table of contents back proves the file is a complete
  # custom-format dump and not a truncated one. It costs milliseconds and is the
  # difference between a backup and a file.
  "${DB_EXEC[@]}" pg_restore --list <"$out" >/dev/null
  chmod 600 "$out"
}

dump_db datebaenkli_meta meta.dump
dump_db datebaenkli      teach.dump

"${DB_EXEC[@]}" pg_dumpall --globals-only --no-password >"$part/globals.sql"
# Roles are not in either database, and a restore without them is a directory of
# schemas nobody can log into. Cheap proof the dump is not an empty file.
if ! grep -q '^CREATE ROLE dbk_app;' "$part/globals.sql"; then
  echo "FATAL: globals.sql does not create dbk_app — pg_dumpall wrote nothing usable" >&2
  exit 1
fi
chmod 600 "$part/globals.sql"

# `.env` travels with the dumps because DBK_ENCRYPTION_KEY is what makes
# app_user.pg_password_enc mean anything: without it every student's Postgres
# password has to be regenerated and re-provisioned by hand before anyone can
# run a query again. The cost is that this directory is now exactly as sensitive
# as .env, which is the trade being made deliberately: 0700, 0600 on every file,
# and nothing but this script and a human should ever open it.
#
# This comment used to end "on a disk the app cannot reach". That was false —
# docker-compose.yml mounted this directory into the app container read-write,
# under the same uid that owns it — and the claim is what made the trade look
# safer than it was. The mount is gone; if you are tempted to add it back, note
# that it would put DBK_ENCRYPTION_KEY behind any file-read bug in a web app
# that runs student-supplied SQL. Set DBK_BACKUP_ENV=0 if you keep the secrets
# elsewhere.
if [ "$INCLUDE_ENV" = "1" ] && [ -f "$REPO_DIR/.env" ]; then
  install -m 600 "$REPO_DIR/.env" "$part/env"
fi

{
  echo "taken      $stamp"
  echo "host       $(hostname)"
  echo "server     $("${DB_EXEC[@]}" psql -tAX -d postgres -c 'SHOW server_version' 2>&1)"
  # A dump of an ICU database will not restore into a server built without ICU,
  # and that is discovered at the worst possible moment unless it is written
  # down here. `datlocale` is the PG 17+ spelling.
  echo "locale     $("${DB_EXEC[@]}" psql -tAX -d postgres -c \
    "SELECT string_agg(datname||'='||datlocprovider::text||':'||coalesce(datlocale, datcollate), ' ' ORDER BY datname)
       FROM pg_database WHERE datname LIKE 'datebaenkli%'" 2>&1)"
  echo "env        $([ -f "$part/env" ] && echo included || echo "NOT included")"
  echo "files"
  ( cd "$part" && find . -maxdepth 1 -type f ! -name MANIFEST -printf '  %-12f %10s bytes\n' | sort )
} >"$part/MANIFEST"

mv "$part" "$run"
ln -sfn "$stamp" "$BACKUP_DIR/latest"

# --- retention ---------------------------------------------------------------

mapfile -t runs < <(complete_runs)
if [ "${#runs[@]}" -gt "$KEEP" ]; then
  for old in "${runs[@]:0:$(( ${#runs[@]} - KEEP ))}"; do
    rm -rf "$old"
  done
fi

# Failed runs are kept for a week so there is something to look at on Monday,
# then cleared so they cannot accumulate unnoticed.
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '*.partial' -mtime +7 -exec rm -rf {} +

echo "backup ok: $run ($(du -sh "$run" | cut -f1)), keeping ${KEEP}"
