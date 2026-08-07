#!/bin/bash
# Datebänkli — retire old schema dumps from the archive directory.
#
# The archive holds one `pg_dump -Fc` file per account that was cold-stored or
# deleted. `db/backup.sh` is the other half of the disk story and prunes by
# *count*, keeping the newest N runs; this prunes by *age*, because these files
# are not snapshots of one thing but one file per person.
#
#   prune-archive.sh             delete what is over the age limit
#   prune-archive.sh --dry-run   print exactly what it would delete, touch nothing
#
# Install (host, as the owner of /mnt/bulk/datebaenkli), alongside backup.sh:
#   crontab -e
#   47 3 * * 0 flock -n /tmp/dbk-prune.lock /opt/apps/datebaenkli/db/prune-archive.sh >> /var/log/dbk-prune.log 2>&1
#
# Weekly, not nightly: nothing here is urgent, and a job that deletes data
# should run rarely enough that a mistake has time to be noticed.
#
# ## The one rule that makes this safe
#
# **A dump is only deletable if no live account depends on it.** That is not the
# same as "old", and getting it wrong destroys data that is still in use:
#
#   * A **cold** account's dump IS that account's data. The schema was dropped;
#     `archive_path` in the meta database points at this file, and it is what
#     `reconcile.ts` and `restoreStudent` read to bring the student back. A cold
#     account can easily sit cold for longer than the age limit — that is the
#     entire point of cold storage — so age alone would delete live accounts.
#   * A **deleted** account's dump is genuinely unreferenced once the drop
#     succeeded: `reconcile.ts` skips a deleted account whose role is already
#     gone, so nothing reads the file again. This is what the age limit is for.
#
# So the keep-list is built from the database, not from the filenames, and any
# file it names is kept **regardless of age**. If the database cannot be reached
# the script deletes nothing at all — an unreadable keep-list is indistinguishable
# from an empty one, and the two have very different consequences.
#
# Deleting a dump is irreversible and the file is the only remaining copy of
# that student's work. `--dry-run` first, at least the first time.

set -euo pipefail

ARCHIVE_DIR="${DBK_ARCHIVE_DIR:-/mnt/bulk/datebaenkli/archive}"
KEEP_DAYS="${DBK_ARCHIVE_KEEP_DAYS:-180}"
META_DB="${DBK_META_DB:-datebaenkli_meta}"
DB_USER="${DBK_DB_USER:-postgres}"

# Same convention and same reason as backup.sh: `${VAR-default}` rather than
# `${VAR:-default}`, so setting DBK_DB_EXEC to the empty string means "psql is
# on this machine", which is how this is exercised against a throwaway cluster.
read -r -a DB_EXEC <<<"${DBK_DB_EXEC-docker exec -i -u postgres datebaenkli-db}" || true

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

[ -d "$ARCHIVE_DIR" ] || { echo "prune-archive: no such directory: $ARCHIVE_DIR"; exit 1; }

# --- the keep-list -----------------------------------------------------------
#
# Every dump a non-deleted account still points at. `state <> 'deleted'` is the
# whole predicate: active and archived accounts should not have an archive_path
# at all, but if one does — a cold-store whose restore half-failed, say — the
# file is still the only copy of that schema and this is not the script to
# resolve it. Only basenames are compared, because archive_path is written as
# the *container's* path (`/mnt/bulk/...` inside the app) and this runs on the
# host, where the same file may be mounted elsewhere.
keep_list=$("${DB_EXEC[@]}" psql -U "$DB_USER" -d "$META_DB" -tAq -v ON_ERROR_STOP=1 -c "
  SELECT regexp_replace(archive_path, '^.*/', '')
    FROM app_user
   WHERE archive_path IS NOT NULL AND state <> 'deleted'" 2>&1) || {
  echo "prune-archive: ABORT — could not read the keep-list from $META_DB"
  echo "  $(echo "$keep_list" | head -1 | cut -c1-120)"
  echo "  Deleting nothing: a keep-list that failed to load looks exactly like an empty one."
  exit 1
}

kept_referenced=0
deleted=0
freed=0

echo "prune-archive: $ARCHIVE_DIR, older than ${KEEP_DAYS}d$([ "$DRY" = 1 ] && echo ' (DRY RUN)')"

# -mtime +N is "more than N days old" in whole days, which is the granularity
# this wants; a dump on the boundary surviving one more week is harmless.
while IFS= read -r -d '' file; do
  base=$(basename "$file")
  if printf '%s\n' "$keep_list" | grep -qxF "$base"; then
    # Referenced by a live account — almost certainly cold storage. Age is
    # irrelevant here and saying so out loud is the point: this line is what
    # tells a reader the safety rule is doing something rather than nothing.
    echo "  KEEP  $base — still referenced by a live account"
    kept_referenced=$((kept_referenced + 1))
    continue
  fi
  size=$(stat -c %s "$file" 2>/dev/null || echo 0)
  if [ "$DRY" = 1 ]; then
    echo "  would delete  $base"
  else
    rm -f -- "$file"
    echo "  deleted  $base"
  fi
  deleted=$((deleted + 1))
  freed=$((freed + size))
done < <(find "$ARCHIVE_DIR" -maxdepth 1 -type f -name '*.dump' -mtime +"$KEEP_DAYS" -print0)

echo "prune-archive: $deleted file(s) $([ "$DRY" = 1 ] && echo 'would be ' )removed, \
$((freed / 1024)) KiB, $kept_referenced kept because a live account needs them"
