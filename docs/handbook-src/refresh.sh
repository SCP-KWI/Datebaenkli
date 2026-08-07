#!/usr/bin/env bash
# Rebuild the demo cluster, seed it, retake every screenshot, convert to WebP.
#
# Everything happens on a throwaway PostgreSQL of its own — its own data
# directory under $WORK, its own port, its own app process. It never touches the
# cluster HANDOFF §6 keeps at /tmp/dbk, and it cannot reach the server.
#
# Prerequisites: postgres client+server on PATH (`initdb`, `pg_ctl`, `psql`),
# `npm install` here and in ../../app, ImageMagick, and Chromium
# (CHROME_PATH overrides /usr/bin/chromium).
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

WORK="${DBK_HANDBOOK_WORK:-/tmp/dbk-handbuch}"
PGPORT_="${DBK_HANDBOOK_PGPORT:-55433}"
APPPORT="${DBK_HANDBOOK_PORT:-3222}"
export APP_URL="http://localhost:$APPPORT"

# --- a cluster of our own -----------------------------------------------------
# Only ever our own app process, never one someone else started: the pid is
# written below and nothing here uses pkill.
[ -f "$WORK/app.pid" ] && kill "$(cat "$WORK/app.pid")" 2>/dev/null || true
pg_ctl -D "$WORK/pg" stop -m fast 2>/dev/null || true
sleep 1
rm -rf "$WORK"
mkdir -p "$WORK/archive"

initdb -D "$WORK/pg" -U postgres --locale=C.UTF-8 --encoding=UTF8 -A trust >/dev/null
# -k /tmp, not $WORK: the Unix socket path is capped at 107 bytes and a work
# directory under /tmp/claude-* already spends most of them.
pg_ctl -D "$WORK/pg" -l "$WORK/pg.log" \
  -o "-p $PGPORT_ -k /tmp -c listen_addresses=127.0.0.1 -c temp_file_limit=256MB" start
sleep 2

cd "$REPO"
PGHOST=127.0.0.1 PGPORT="$PGPORT_" POSTGRES_USER=postgres \
  DBK_APP_DB_PASSWORD=secret bash db/init/00-bootstrap.sh

# --- the app ------------------------------------------------------------------
cd "$REPO/app"
npm run build >/dev/null
PGHOST=127.0.0.1 PGPORT="$PGPORT_" DBK_APP_DB_PASSWORD=secret \
  DBK_SESSION_SECRET="handbuch-demo-session-secret-that-is-long-enough-here" \
  DBK_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  DBK_BOOTSTRAP_ADMIN_PASSWORD="handbuch-admin-2026" \
  DBK_ARCHIVE_DIR_CONTAINER="$WORK/archive" \
  DBK_PUBLIC_URL="https://datebaenkli.schaffner.xyz" \
  DBK_COOKIE_SECURE=false \
  PORT="$APPPORT" TZ=Europe/Zurich \
  nohup node dist/server.js > "$WORK/app.log" 2>&1 &
echo $! > "$WORK/app.pid"
sleep 5

# --- demo data, screenshots, WebP --------------------------------------------
cd "$HERE"
node demo_seed.mjs
node shots.mjs

mkdir -p "$HERE/shots/web"
cd "$HERE/shots"
for f in *.png; do
  b="${f%.png}"
  magick "$f" -resize 66.7% -quality 82 -define webp:method=6 "web/$b.webp"
done

kill "$(cat "$WORK/app.pid")" 2>/dev/null || true
pg_ctl -D "$WORK/pg" stop -m fast 2>/dev/null || true
echo "screenshots refreshed — now run: node build.mjs"
