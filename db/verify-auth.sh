#!/bin/bash
# Datebänkli — end-to-end check of the phase 1 HTTP surface against a RUNNING app.
#
# app/test covers the service layer against PGlite. It cannot cover what only
# exists once Fastify is up: signed session cookies, the global auth hook, the
# must-change-password gate, role guards, and the cross-teacher checks. That is
# what this script drives, over real HTTP.
#
#   DBK_ADMIN_PASSWORD=... ./db/verify-auth.sh
#   DBK_BASE_URL=http://127.0.0.1:3111 DBK_ADMIN_PASSWORD=... ./db/verify-auth.sh
#
# Re-runnable: every account and class it creates carries a random suffix, and
# it soft-deletes them again at the end. It never changes the admin password —
# the forced-change flow is exercised on a teacher it creates itself.
set -uo pipefail

# NB: no apostrophes in this message — bash opens a quote context inside ${x:?...}.
: "${DBK_ADMIN_PASSWORD:?set DBK_ADMIN_PASSWORD, the current password of the admin account}"
B="${DBK_BASE_URL:-http://127.0.0.1:3000}"
ADMIN_USER="${DBK_ADMIN_USER:-admin}"

JAR_DIR=$(mktemp -d); trap 'rm -rf "$JAR_DIR"' EXIT
A="$JAR_DIR/admin.jar"; T="$JAR_DIR/t1.jar"; T2="$JAR_DIR/t2.jar"; S="$JAR_DIR/s.jar"
BODY_FILE="$JAR_DIR/body"
PASS=0; FAIL=0

# Distinguishes this run's objects from any earlier run's, so nothing collides
# on the unique indexes and a re-run is always clean.
SFX=$(head -c 3 /dev/urandom | od -An -tx1 | tr -d ' \n')

json() { node -e "
  let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
    try { const v=JSON.parse(s)$1; console.log(v===undefined?'':v) } catch { console.log('') }
  })" < "$BODY_FILE"; }

# check <label> <expected-status> <curl args...>
check() {
  local label="$1" want="$2"; shift 2
  local code
  code=$(curl -s -o "$BODY_FILE" -w '%{http_code}' "$@")
  if [ "$code" = "$want" ]; then
    echo "  PASS  $label"; PASS=$((PASS+1)); return 0
  fi
  echo "  FAIL  $label  << expected $want, got $code >>"
  echo "        $(head -c 160 "$BODY_FILE")"
  FAIL=$((FAIL+1)); return 1
}

post() { local j="$1"; shift; curl -s -X POST -H 'content-type: application/json' -d "$j" "$@"; }
JSON=(-H 'content-type: application/json')

echo "=== target: $B ==="
if ! curl -sf "$B/health" >/dev/null; then
  echo "  FAIL  the app is not answering on $B/health"; exit 1
fi

echo "=== closed by default ==="
check "GET /health is public"                    200 "$B/health"
check "GET /login is public"                     200 "$B/login"
# The handbook is linked from the login page, so a teacher who cannot get in is
# the reader it is most for. A 401 here means the route lost its
# `config: { public: true }` — and nobody would find that out until she did.
check "GET /handbuch is public"                  200 "$B/handbuch"
check "GET /api/me needs a session"              401 "$B/api/me"
check "GET /api/teachers needs a session"        401 "$B/api/teachers"
check "GET /api/classes needs a session"         401 "$B/api/classes"
check "an unmatched URL is a 404, not a 401"     404 "$B/api/no-such-route"

echo "=== login ==="
check "wrong password is rejected"               401 -X POST "${JSON[@]}" -d "{\"username\":\"$ADMIN_USER\",\"password\":\"definitely-wrong-$SFX\"}" "$B/api/login"
check "unknown user gives the same answer"       401 -X POST "${JSON[@]}" -d "{\"username\":\"ghost-$SFX\",\"password\":\"x\"}" "$B/api/login"
check "a missing field is a 400"                 400 -X POST "${JSON[@]}" -d "{\"username\":\"$ADMIN_USER\"}" "$B/api/login"
check "a forged cookie is ignored"               401 -H "Cookie: dbk_sid=not-a-signed-value" "$B/api/me"
check "admin logs in"                            200 -c "$A" -X POST "${JSON[@]}" -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$DBK_ADMIN_PASSWORD\"}" "$B/api/login" || exit 1

if [ "$(json .user.mustChangePassword)" = "true" ]; then
  echo "  NOTE  the admin still owes a password change; skipping admin-only checks."
  echo "        Change it once (POST /api/me/password) and re-run for full coverage."
  exit 1
fi

echo "=== admin creates teachers ==="
check "create a teacher"                         201 -b "$A" -X POST "${JSON[@]}" -d "{\"firstName\":\"Ver\",\"lastName\":\"Ifya$SFX\"}" "$B/api/teachers" || exit 1
T1U=$(json .user.username); T1P=$(json .password); T1ID=$(json .user.id)
check "a same-surname teacher gets a suffix"     201 -b "$A" -X POST "${JSON[@]}" -d "{\"firstName\":\"Zwo\",\"lastName\":\"Ifya$SFX\"}" "$B/api/teachers" || exit 1
T2U=$(json .user.username); T2P=$(json .password); T2ID=$(json .user.id)
[ "$T2U" = "${T1U}2" ] \
  && { echo "  PASS  collision resolved: $T1U / $T2U"; PASS=$((PASS+1)); } \
  || { echo "  FAIL  expected ${T1U}2, got $T2U"; FAIL=$((FAIL+1)); }
check "an admin must name a class's owner"       403 -b "$A" -X POST "${JSON[@]}" -d "{\"code\":\"zz$SFX\",\"name\":\"X\"}" "$B/api/classes"

echo "=== the forced password change gates everything ==="
check "the new teacher can log in"               200 -c "$T" -X POST "${JSON[@]}" -d "{\"username\":\"$T1U\",\"password\":\"$T1P\"}" "$B/api/login" || exit 1
check "…and owes a change"                       403 -b "$T" "$B/api/classes"
[ "$(json .error.code)" = "password_change_required" ] \
  && { echo "  PASS  the reason is password_change_required"; PASS=$((PASS+1)); } \
  || { echo "  FAIL  wrong error code: $(json .error.code)"; FAIL=$((FAIL+1)); }
check "…but can still read /api/me"              200 -b "$T" "$B/api/me"
check "a too-short new password is refused"      400 -b "$T" -X POST "${JSON[@]}" -d "{\"currentPassword\":\"$T1P\",\"newPassword\":\"kurz\"}" "$B/api/me/password"
check "a wrong current password is refused"      403 -b "$T" -X POST "${JSON[@]}" -d "{\"currentPassword\":\"nope\",\"newPassword\":\"lange-genug-1\"}" "$B/api/me/password"
check "the change succeeds"                      200 -b "$T" -c "$T" -X POST "${JSON[@]}" -d "{\"currentPassword\":\"$T1P\",\"newPassword\":\"lehrperson-$SFX\"}" "$B/api/me/password"
check "…and the gate is now open"                200 -b "$T" "$B/api/classes"

echo "=== role guards ==="
check "a teacher cannot list teachers"           403 -b "$T" "$B/api/teachers"
check "a teacher cannot create a teacher"        403 -b "$T" -X POST "${JSON[@]}" -d '{"firstName":"A","lastName":"B"}' "$B/api/teachers"

echo "=== classes ==="
check "a malformed class code is a 400"          400 -b "$T" -X POST "${JSON[@]}" -d '{"code":"K 3a!","name":"X"}' "$B/api/classes"
check "the teacher creates a class"              201 -b "$T" -X POST "${JSON[@]}" -d "{\"code\":\"v$SFX\",\"name\":\"Verify $SFX\",\"schoolYear\":\"2026/27\"}" "$B/api/classes" || exit 1
CID=$(json .class.id)
check "a duplicate code is a 409"                409 -b "$T" -X POST "${JSON[@]}" -d "{\"code\":\"v$SFX\",\"name\":\"Nochmal\"}" "$B/api/classes"

echo "=== roster ==="
check "bulk enrolment"                           201 -b "$T" -X POST "${JSON[@]}" \
  -d '{"students":[{"firstName":"Lena","lastName":"Muster"},{"firstName":"Tim","lastName":"Meier"},{"firstName":"Zoë","lastName":"Bühler"}]}' \
  "$B/api/classes/$CID/students" || exit 1
SU=$(json '.students[0].user.username'); SP=$(json '.students[0].password'); SID=$(json '.students[0].user.id')
EXPECT="u_v${SFX}_muster_lena"
[ "$SU" = "$EXPECT" ] \
  && { echo "  PASS  identifier is $SU"; PASS=$((PASS+1)); } \
  || { echo "  FAIL  expected $EXPECT, got $SU"; FAIL=$((FAIL+1)); }
check "an empty batch is a 400"                  400 -b "$T" -X POST "${JSON[@]}" -d '{"students":[]}' "$B/api/classes/$CID/students"
check "the roster lists all three"               200 -b "$T" "$B/api/classes/$CID/students"
[ "$(json '.students.length')" = "3" ] \
  && { echo "  PASS  three students, umlauts folded: $(json '.students.map(s=>s.username).join(", ")')"; PASS=$((PASS+1)); } \
  || { echo "  FAIL  expected 3 students"; FAIL=$((FAIL+1)); }

echo "=== a student can do nothing but be a student ==="
check "the student logs in with the slip password" 200 -c "$S" -X POST "${JSON[@]}" -d "{\"username\":\"$SU\",\"password\":\"$SP\"}" "$B/api/login" || exit 1
[ "$(json .user.mustChangePassword)" = "false" ] \
  && { echo "  PASS  no forced change (the slip password is the credential)"; PASS=$((PASS+1)); } \
  || { echo "  FAIL  students should not be forced to change"; FAIL=$((FAIL+1)); }
check "reads their own profile"                  200 -b "$S" "$B/api/me"
check "cannot list classes"                      403 -b "$S" "$B/api/classes"
check "cannot list teachers"                     403 -b "$S" "$B/api/teachers"
check "cannot list students"                     403 -b "$S" "$B/api/students"
check "cannot create a class"                    403 -b "$S" -X POST "${JSON[@]}" -d '{"code":"hack","name":"X"}' "$B/api/classes"
check "cannot reset anybody's password"          403 -b "$S" "${JSON[@]}" -X POST "$B/api/students/$SID/password"

echo "=== CSRF: state-changing calls must declare application/json ==="
# text/plain, x-www-form-urlencoded and multipart are the CORS-safelisted types,
# so a cross-origin form can POST them with no preflight — and SameSite=Lax
# treats every sibling app on the same registrable domain as same-site.
check "text/plain is refused"                    415 -b "$T" -X POST -H 'content-type: text/plain' --data 'x' "$B/api/students/$SID/password"
check "form encoding is refused"                 415 -b "$T" -X POST -H 'content-type: application/x-www-form-urlencoded' --data 'x=1' "$B/api/students/$SID/password"
check "no content-type is refused"               415 -b "$T" -X POST "$B/api/students/$SID/password"
check "a body-less JSON POST still works"        200 -b "$T" "${JSON[@]}" -X POST "$B/api/classes/$CID/archive"
check "…so un-archive it again for the rest"     200 -b "$A" "${JSON[@]}" -X PATCH -d "{\"name\":\"Verify $SFX\"}" "$B/api/classes/$CID"
check "logout sends the header too"              200 -b "$S" "${JSON[@]}" -X POST "$B/api/logout"
check "…and really did end the session"          401 -b "$S" "$B/api/me"
check "the student logs back in"                 200 -c "$S" -X POST "${JSON[@]}" -d "{\"username\":\"$SU\",\"password\":\"$SP\"}" "$B/api/login"

# The first of the student's own-database routes to be checked here, added with
# the quota line in the schema browser (7.2). It is the only automated reach
# there is into the *composed* response: `catalog.live.test.mjs` drives the
# reader as a service, so the join between the tree and the quota exists only in
# routes/workspace.ts and only this sees it.
echo "=== the schema browser carries the student's own quota ==="
check "a student reads their own workspace"      200 -b "$S" "$B/api/workspace"
# `quotaBytes`, not `bytes`: usage on a fresh schema is legitimately 0 and would
# pass an "is a number" test while being indistinguishable from a field that was
# never filled in. The limit is non-zero whenever the route wired its guard at
# all, so it is the one that fails loudly when the wiring goes.
echo "$(json '.quota.quotaBytes')" | grep -qE '^[1-9][0-9]*$' \
  && { echo "  PASS  the workspace states a quota limit"; PASS=$((PASS+1)); } \
  || { echo "  FAIL  the workspace has no quota limit in it"; FAIL=$((FAIL+1)); }
check "an admin has no workspace to read"        403 -b "$A" "$B/api/workspace"

echo "=== malformed input is a 4xx, never a 500 ==="
check "a bogus X-Forwarded-For does not 500"     401 -X POST "${JSON[@]}" -H 'X-Forwarded-For: not-an-ip' -d "{\"username\":\"$SU\",\"password\":\"wrong-$SFX\"}" "$B/api/login"
check "an unparseable body is a 400"             400 -b "$T" "${JSON[@]}" -X POST -d '{ not json' "$B/api/classes"
check "an empty optional field is not a 400"     201 -b "$A" "${JSON[@]}" -X POST -d "{\"firstName\":\"Drei\",\"lastName\":\"Ifya$SFX\",\"locale\":\"\"}" "$B/api/teachers"
T3ID=$(json .user.id)

echo "=== one teacher cannot reach another's class ==="
check "the second teacher logs in"               200 -c "$T2" -X POST "${JSON[@]}" -d "{\"username\":\"$T2U\",\"password\":\"$T2P\"}" "$B/api/login" || exit 1
check "…changes password"                        200 -b "$T2" -c "$T2" -X POST "${JSON[@]}" -d "{\"currentPassword\":\"$T2P\",\"newPassword\":\"zweite-$SFX\"}" "$B/api/me/password"
check "…sees none of the first teacher's classes" 200 -b "$T2" "$B/api/classes"
echo "$(json '.classes.filter(c=>c.id===Number('"$CID"')).length')" | grep -q '^0$' \
  && { echo "  PASS  the class is not in their list"; PASS=$((PASS+1)); } \
  || { echo "  FAIL  the class leaked into another teacher's list"; FAIL=$((FAIL+1)); }
check "…cannot open it by id"                    403 -b "$T2" "$B/api/classes/$CID"
check "…cannot read its roster"                  403 -b "$T2" "$B/api/classes/$CID/students"
check "…cannot enrol into it"                    403 -b "$T2" -X POST "${JSON[@]}" -d '{"students":[{"firstName":"Mal","lastName":"Ory"}]}' "$B/api/classes/$CID/students"
check "…cannot reset its students' passwords"    403 -b "$T2" "${JSON[@]}" -X POST "$B/api/students/$SID/password"
check "…cannot archive its students"             403 -b "$T2" -X PATCH "${JSON[@]}" -d '{"state":"archived"}' "$B/api/students/$SID/state"

# Enrolment IS the authorisation primitive, so an unrestricted "add by id" would
# let any teacher grant themselves a colleague's students and then read their
# slip password out of the reset endpoint. Student ids are sequential bigints.
check "…creates a class of their own"            201 -b "$T2" -X POST "${JSON[@]}" -d "{\"code\":\"x$SFX\",\"name\":\"Fremd $SFX\"}" "$B/api/classes" || exit 1
CID3=$(json .class.id)
check "…and CANNOT enrol the other's student"    404 -b "$T2" -X POST "${JSON[@]}" -d "{\"userIds\":[$SID]}" "$B/api/classes/$CID3/members"
check "…so the student is still not theirs"      403 -b "$T2" "$B/api/students/$SID"
check "an admin may move a student across"       200 -b "$A" -X POST "${JSON[@]}" -d "{\"userIds\":[$SID]}" "$B/api/classes/$CID3/members"
check "…and only then can they see them"         200 -b "$T2" "$B/api/students/$SID"
# Undo it: the lifecycle block below asserts on a student who is in exactly one
# class, and leaving them enrolled here would make that assertion vacuous.
check "…and the admin can undo the move"         200 -b "$A" -X DELETE "${JSON[@]}" "$B/api/classes/$CID3/members/$SID"
check "…leaving the student unreachable again"   403 -b "$T2" "$B/api/students/$SID"

check "an admin, by contrast, can open it"       200 -b "$A" "$B/api/classes/$CID"

echo "=== sessions ==="
check "logout"                                   200 -b "$S" -c "$S" "${JSON[@]}" -X POST "$B/api/logout"
check "…the cookie is dead"                      401 -b "$S" "$B/api/me"
check "…logging out again is still fine"         200 "${JSON[@]}" -X POST "$B/api/logout"
check "the student logs back in"                 200 -c "$S" -X POST "${JSON[@]}" -d "{\"username\":\"$SU\",\"password\":\"$SP\"}" "$B/api/login"
check "the teacher resets their password"        200 -b "$T" "${JSON[@]}" -X POST "$B/api/students/$SID/password" || exit 1
NEWP=$(json .password)
check "…which kills the student's live session"  401 -b "$S" "$B/api/me"
check "…and the old password"                    401 -X POST "${JSON[@]}" -d "{\"username\":\"$SU\",\"password\":\"$SP\"}" "$B/api/login"
check "…while the new one works"                 200 -c "$S" -X POST "${JSON[@]}" -d "{\"username\":\"$SU\",\"password\":\"$NEWP\"}" "$B/api/login"

echo "=== lifecycle ==="
check "an unknown state value is a 400"          400 -b "$T" -X PATCH "${JSON[@]}" -d '{"state":"banana"}' "$B/api/students/$SID/state"
# The teacher/admin split on `cold`, which phase 7.3 put a button behind and so
# made worth asserting in both directions. A teacher gets 400 rather than 403:
# from where they stand it is not a state that exists (routes/students.ts), and
# `roster.js` does not render the button for them at all. An admin gets 200,
# which is the half that would silently rot if only the refusal were checked.
check "'cold' is refused for a teacher"          400 -b "$T" -X PATCH "${JSON[@]}" -d '{"state":"cold"}' "$B/api/students/$SID/state"
check "…but an admin may cold-store"             200 -b "$A" -X PATCH "${JSON[@]}" -d '{"state":"cold"}' "$B/api/students/$SID/state"
echo "$(json .user.state)" | grep -q '^cold$' \
  && { echo "  PASS  …and the account really reads cold"; PASS=$((PASS+1)); } \
  || { echo "  FAIL  the state did not stick"; FAIL=$((FAIL+1)); }
check "…and restoring from cold works"           200 -b "$T" -X PATCH "${JSON[@]}" -d '{"state":"active"}' "$B/api/students/$SID/state"
check "archive the student"                      200 -b "$T" -X PATCH "${JSON[@]}" -d '{"state":"archived"}' "$B/api/students/$SID/state"
check "…an archived account cannot log in"       401 -X POST "${JSON[@]}" -d "{\"username\":\"$SU\",\"password\":\"$NEWP\"}" "$B/api/login"
check "…and restoring it works"                  200 -b "$T" -X PATCH "${JSON[@]}" -d '{"state":"active"}' "$B/api/students/$SID/state"
check "…after which login works again"           200 -X POST "${JSON[@]}" -d "{\"username\":\"$SU\",\"password\":\"$NEWP\"}" "$B/api/login"
check "a student cannot leave their only class"  409 -b "$T" "${JSON[@]}" -X DELETE "$B/api/classes/$CID/members/$SID"
check "a second class for the same teacher"      201 -b "$T" -X POST "${JSON[@]}" -d "{\"code\":\"w$SFX\",\"name\":\"Verify $SFX b\"}" "$B/api/classes" || exit 1
CID2=$(json .class.id)
check "…the student joins it"                    200 -b "$T" -X POST "${JSON[@]}" -d "{\"userIds\":[$SID]}" "$B/api/classes/$CID2/members"
check "…now they can leave the first"            200 -b "$T" "${JSON[@]}" -X DELETE "$B/api/classes/$CID/members/$SID"
check "…and the account is still administrable"  200 -b "$T" "$B/api/students/$SID"

echo "=== teardown ==="
for cid in "$CID" "${CID2:-}" "${CID3:-}"; do
  [ -n "$cid" ] || continue
  curl -s -b "$T" "$B/api/classes/$cid/students" > "$BODY_FILE"
  for sid in $(json '.students.map(s=>s.id).join(" ")'); do
    post '{"state":"deleted"}' -X PATCH -b "$T" "$B/api/students/$sid/state" >/dev/null
  done
  curl -s -b "$T" "${JSON[@]}" -X POST "$B/api/classes/$cid/archive" >/dev/null
done
for tid in "$T1ID" "$T2ID" "${T3ID:-}"; do
  post '{"state":"deleted"}' -X PATCH -b "$A" "$B/api/teachers/$tid/state" >/dev/null
done
echo "  removed the accounts and archived the class this run created"

echo
echo "=== $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
