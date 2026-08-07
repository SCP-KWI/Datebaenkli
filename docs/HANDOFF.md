# Datebänkli — Handoff

Running state document. Update it at the end of every working session.

**Last updated:** 2026-08-07 (evening) · **Phases 0–9 are DEPLOYED**, on
`0.9.0`. The repo and the server are in step; there is no undeployed code.

**Two corrections to what this file used to say at the top.** It claimed `0.8.0`
and "no undeployed code" from 2026-07-30 until today, and both were wrong from
2026-07-31 onwards: `0.8.1` (the security release, `e550eaf`) went out on 31 July
and nobody updated this line, and the handbook commit `92a67d4` went out on
6 August under the same version. The lesson is the cheap one — **this line is not
self-maintaining, and `curl /api/version` is** (§7). When the two disagree,
believe the curl.

---

## Phase 9 in one screen

A teacher builds an exercise's tables (CSV upload or a SQL script), writes the
task in Markdown, hands it to a class, and reads the hand-ins. **No
auto-checking** — that design was dropped rather than deferred, and its columns
were removed rather than left as a decoy. ARCHITECTURE §5 is amended in place and
is the thing to read before touching any of this.

**The one decision everything follows from: a student's copy of an exercise is
its own schema, owned by them** (`x7_u_k3a_muster_lena`). Not prefixed tables in
their playground. That makes isolation the same Postgres-enforced thing it is
everywhere else, and makes "reset just this exercise" a `DROP SCHEMA` rather than
a prefix match somebody can break by renaming a table.

Read in this order before changing anything:

1. `services/exercise.ts`'s header — the design, and why this file builds no SQL
   by string despite needing to.
2. `meta/003_exercises.sql` — what was dropped from the phase-0 stub and why, and
   why the workspace name is *stored* rather than derived.
3. **§4xx below** — the four findings, including one where a comment I wrote was
   wrong and a test that did not test what it claimed.

Verified on 2026-08-07 against a real cluster: 311 unit tests, 79 live tests,
`verify-isolation.sh` 41/41, `verify-auth.sh` 95/95, and the whole loop driven in
a browser — two students, one wrecking their copy while the other's stayed
intact, reset, hand-ins, both downloads, take-back, delete.

**Deployed the same day** (§7). Production serves `0.9.0`; the author created an
exercise on the live instance, solved it from a student account and read the
hand-in back. §5 says precisely which parts of the local acceptance run were
*not* repeated there.

**`npm test` runs its files serially now** (`--test-concurrency=1` in
`package.json`). In parallel it peaked at 9.4 GB and OOM-killed a developer
machine; serialised it is 4.5 GB and ~230 s. Not a leak and not new, but phase 9
made it worse — §4xx (4) has the measurements and the cause that is still there.

---

**Everything through 7.5 remains deployed and in step.** What follows is the
pre-phase-9 state of this file.

The first attempt at 7.2+8 silently did nothing — `docker compose up` with no
`build`, so compose started the image it already had — and §4vv is both the
catch and the confirmed cause. **Read it before the next deploy**: `up -d`
succeeding proves nothing, and one curl for a string the previous release did
not contain is what actually settles it.

**The version was `0.8.0` at that point and covered everything through §4ww.**
It was bumped once, during 7.4; 7.5's accent change went out under the same
number with a fresh `builtAt`, which is the pair working as §10 (14) intended —
the timestamp carried the deploy, the semver named the phase. (It went to
`0.8.1` on 31 July and `0.9.0` on 7 August; see the top of this file.)

**It is deliberately not `1.0.0`.** ARCHITECTURE §9's v1 scope is complete, which
is the milestone; what a 1.0 usually also claims is that the thing has met its
users, and no class has yet used it in a lesson. That is the last acceptance
test, and §5 lists the two things only a real lesson exercises.

**The one thing still outstanding is operational, not code:
`db/prune-archive.sh` is on the server but NOT in cron.** Retention on the
archive is a decision now — six months — and the script implements it, but
nothing runs it. §4vv has the install, including the `/var/log` file that has to
exist *before* the first run or the job dies at the redirect writing nothing
anywhere.

- **7.2** — the student's own disk usage in the schema browser, and a hint layer
  on the CSV import (§4tt).
- **8** — buttons for cold storage and deletion, at two deliberately different
  weights of confirmation (§4uu).
- **8.1** — §8's leftovers: the boot reconcile moved after `listen`, the archive
  sweep observed firing for the first time, the sweeper's log line made true
  under any `TZ`, `verify-isolation.sh`'s fixtures moved out of the app's
  namespace, and six-month retention on the archive (§4vv).

§4tt also carries a `db/verify-isolation.sh` fix that has nothing to do with any
of them and matters more than all three: that script would have destroyed a real
account.

**The version is `0.8.0` now**, and it had been stuck at `0.7.0` through two
phases — which is half of why the failed deploy was invisible. See §4vv.

**The 7.1 deploy is now closed.** `GET /api/version` against production answers
`{"version":"0.7.0","builtAt":"2026-07-28T23:10:54Z"}` — the running container
is the 7.1 image, not a survivor of the failed first attempt. That check is off
§5's list for good.

**The overnight locale check is CLOSED and it passed** (2026-07-30). After ~39 h
without an authenticated request, the student logged in and was still in
English — so the locale does come from `app_user.locale` once the cookie has
expired, and §4mm's claim holds. Open since 6b; §5 keeps the method, because
what resets that clock is narrower than three sessions assumed.

**One thing is open on the production cluster, and it is probably benign.** Of
the four role names `verify-isolation.sh` uses, production holds exactly one:
`t_schaffner` — and *not* `u_k3a_muster_lena`, which a leak would have left
beside it. The likeliest reading is a real teacher account colliding with a
fixture name. §5 and §7 have the query that decides it. **Do not drop it on the
name.**

**Version is now visible.** `GET /api/version` is public, so
`curl -s https://datebaenkli.schaffner.xyz/api/version` answers "what is actually
running" without logging in — the cheapest deploy confirmation this project has,
and the only one that reads the container rather than the build log.

**The 7.1 deploy broke first, and the reason is §4ss.** `postbuild` gained
`node tools/stamp-build.mjs`, but `app/Dockerfile` copies only `package.json`,
`tsconfig.json` and `src` — so the image build died at `RUN npm run build` after
passing every check on the dev machine. Fixed with `COPY tools ./tools`. **The
lesson is bigger than the line**: `npm run build` says nothing about the image,
and the pre-deploy check that would have caught it is
`sudo docker compose build datebaenkli-app` on the dev machine. §4ss also
corrects a claim that this file used to make — Docker here is *not* unusable; it
needs `sudo`, which an agent does not have.

**Phases 0–6b complete; 0–5b DEPLOYED**, verified
against real PostgreSQL 18.4 locally and **17.10 on the server**. Live at
`datebaenkli.schaffner.xyz`, on ICU `de-CH` databases with nightly backups in
cron. The restore drill is done on the server's own backups and found §4dd,
which is fixed, deployed and verified.

**Phase 5b — cold storage, the restore, and the nightly archive sweep — is
deployed**, and it was the first migration since phase 0. `meta/002_lifecycle.sql`
applied cleanly, the sweep is armed, and one real student was driven through
cold and back on the server, ending with **her** reading the rows she wrote
before the drop. §7 records the run. **§4ee is still the most important thing in
this file**: the restore direction cannot be run as `dbk_app`, for a reason that
is §4a in its fifth disguise, and the first design of it was wrong.

There is **no outstanding operational work** on anything through 6b. Phase 7 is
built but undeployed; that is the only gap between this repo and the server.

**Since then, three changes, none of them deployed yet:**

- **The live suites' copy-pasted plumbing moved into `test/support/live-pg.mjs`**
  (§8.2, now done). §4ii records what the hoist found — three of the five suites
  had no leak assertion, and every suite's `DBK_APP_DB_PASSWORD ??= 'secret'`
  line had been dead since it was written.
- **Phase 6a: the SQLSTATE hint layer.** `web/assets/hints.js` turns a Postgres
  error into one German sentence and, where the catalog backs it up, names the
  table or column the student meant. 20 codes, 38 unit tests, driven in a
  browser against a real cluster. **Read §4jj before adding a code** — four of
  the message shapes it parses are not what they look like, and the only place
  they are documented is a running server.

- **Phase 6b: i18n, German and English, switchable.** Every page, both locales,
  a `<select>` in each nav, `de-CH`/`en-CH` for the four `Intl` sites, and the
  hint layer restructured so its twenty handlers serve both languages instead of
  one. Driven in a browser against a real cluster, in both locales. **The three
  decisions §8.0 asked for were taken and two did not land where §8a
  recommended** — see §4mm, which is the entry to read before touching any of
  this.

**6a and 6b shipped as one deploy, not two** (2026-07-28, `d4ac149`) — the hint
layer is the thing 6b restructured, so deploying either alone would have been
half of a change that was made together. §7's first subsection is the run.

**309/309 with a cluster up, nothing skipped** — 251 unit plus 58 live. Phase 7
added the two in `test/chalk.test.mjs`; the live count is unchanged, because
nothing it touched has a server-side surface.

**The live suites report a different count depending on whether they run**, and
it wastes an afternoon if you do not know: 58 tests when a cluster is up, **63
when they skip**. That is one extra registration per file, five files —
`liveSuite()`'s skip marker. So a no-cluster run says `314 tests, 251 pass, 63
skipped` and a cluster run says `309 tests, 309 pass`, and neither number is
wrong. Phase 6b added 17 (16 in the new `test/i18n.test.mjs`, 1 in
`hints.test.mjs`), taking it 290 → 307; phase 7 added 2 in `test/chalk.test.mjs`,
307 → 309. The 58 was confirmed against a real cluster on 2026-07-28 and again
on 2026-07-29; do not quote the skipped figure as if it were the suite's size.

**Where the code is:** **`main`**, `github.com/SCP-KWI/Datebaenkli` — changed on
2026-07-29, and it is the one convention in this file that has reversed. Phases
0–7.1 were built on `phase-0-foundation` and merged in three PRs; the server
pulls `main`, so `main` is now also where work happens. `phase-0-foundation` is
historical: left in place rather than deleted, but nothing new should land on it.

The repo is **public** — `.env` and `setupReference` are gitignored and must stay
that way.

---

## 0. Start here (read this before opening any file)

**Phase 9 — exercises — is DEPLOYED** (2026-08-07). Production serves `0.9.0`
and there is nothing undeployed. It was the second migration this project has
done; §7's phase-9 subsection records the run, and the short version is that it
went exactly as the 5b runbook said it would.

If you are here to change anything about exercises, read the top of this file
first (the one-screen summary), then `services/exercise.ts`'s header, then §4xx.
If you are here for something else, phase 9 touched five things outside its own
files and each is a place a stale assumption now bites:

- **`services/quota.ts` measures by *owner*, not by schema name.** A student owns
  their playground plus one schema per exercise; `usage(pgRole)` sums all of it.
- **`services/lesson.ts` takes a `workspacesByUser` function** and sums a
  student's workspaces into their disk figure. Without it the teacher's roster
  under-reports, by more the more the feature is used.
- **`services/query.ts` takes an optional context** and sets `search_path`, and
  now `RESET search_path` unconditionally beside its `ROLLBACK`.
- **`import.ts`'s `createAndFill` is exported** and has a second caller.
- **`coldStore` sweeps workspaces** before its early return — §4xx (2) is the
  correction, and it is smaller than it first looks.

**Phases 7.2 through 7.5 are all DEPLOYED**
(2026-07-29/30). The first attempt at 7.2+8 did not replace the running
container — §4vv, and the cause is confirmed: `docker compose up` with no
`build`. Re-run properly, everything went out. Production served `0.8.0` with
the darkened accents from that deploy until 31 July.

**The only outstanding operational item is unchanged and is now the oldest thing
on this list**: `db/prune-archive.sh` is on the server and not in cron (§4vv).
It has survived three deploys. Retention on the archive is decided (six months)
and implemented; nothing runs it.

- **7.2** — the student's own quota in the schema browser (§8 item 6) and the
  hint layer on the CSV import's failure pane (item 0). §4tt.
- **8** — buttons for cold storage and deletion (§8 items 2 and 5, taken
  together because they were one problem). §4uu.
- **And one incidental fix that matters more than either**:
  `db/verify-isolation.sh` would have **destroyed a real account** if anyone had
  followed its own instruction to run it against the live server. §4tt.

**Phases 7 and 7.1 are done and DEPLOYED** (2026-07-29). §4pp and §4qq are the
entries to read before touching any of the front end; §4ss is the one to read
before touching `postbuild` or the `Dockerfile`.

The short version of what changed: there is now **one stylesheet**
(`web/assets/app.css`), a real top bar on all six pages, a light/dark toggle,
self-hosted fonts, a footer that says which build is running, and the language
`<select>` 6b left bare finally has a shell. `chalk-tokens.css` gained two
accents and became the family's master copy.

**Work now happens on `main`.** That reversed on 2026-07-29 — see the top of this
file. Everything through 7.1 was built on `phase-0-foundation` and merged in
three PRs; that branch is historical now.

**Phases 6a and 6b are done and DEPLOYED** (2026-07-28). If you are here to
change a string, a catalogue or the locale plumbing, read §4mm and §4nn and
stop. The three decisions §8.0 used to pose were taken — two against
ARCHITECTURE §8a's own recommendation — and §8a has been amended in place so it
no longer describes a design that was not built. §7 records the deploy, which
was the first this project has done with **no migration in it**; §5 has the one
thing it deliberately could not close on the day.

**Read §4dd first, before anything else.** The restore drill was run against
the server's own backups and the restore *succeeded* — roles, schemas, rows,
collation, admin login, and a reconcile pass reporting "nothing to repair" —
and then no student could run a query. `CONNECT` on the teaching database lives
in `pg_database.datacl`, which neither dump carries back, and `inventory()` was
structurally unable to see it. Fixed, deployed and verified. The general lesson
is bigger than the bug: **a restore is not proven by a restore, it is proven by
running the workload on it**, and "admin can log in" is worth nothing because
scrypt hashes survive things that break everything else.

That rule is now what the 5b deployment was signed off against: a real student
was driven through cold storage and back on the server, and the deploy was not
called done until **she** had logged in and read her own rows. `provisioning.ok:
true` was not accepted as the end of it, and §7 records the sequence to repeat.

**Phase 5a is done and DEPLOYED, and it closes §4aa.** `/roster` creates
teachers, classes and students from a browser; before it, nothing on the
deployed instance could create an account without `curl`. Driven for real on the
server: a class created through the page, a sheet of slips printed on paper,
and the printed address checked against `DBK_PUBLIC_URL` rather than the address
bar.

**Read `web/assets/roster.js`'s header before changing anything on that page.**
It records the one design decision the whole phase turns on: a slip password
exists exactly once, in the body of the response that created it, and the three
things the page does instead of storing it. §4bb has the argument in full. The
short version is that "put it in `localStorage`" is the obvious fix and the
wrong one, and the reason it is wrong is written down so it does not get
re-invented.

**Phase 5b is done, deployed, and §4ee is what it cost.** Cold storage dumps a student's
schema and drops it, keeping the role NOLOGIN; `cold -> active` restores it; a
nightly in-process sweep archives students idle past `DBK_ARCHIVE_AFTER_DAYS`.
Read `services/provision.ts`'s `restoreStudent` header before touching any of
it — it records why the restore runs `--role` with the dump's schema entry
filtered out of a `--use-list`, which is a strange-looking construction with a
short and non-obvious argument behind it.

**The second thing to read is §4ff**, which is not about a bug but about how
five of the six real defects in 5b were found: not by the tests, which were
green, but by a review pass over the diff. They clustered in one place, and the
shape of that cluster is worth knowing before writing the next irreversible
operation.

**Phase 4 is done.** The teacher's live lesson view: a per-class roster of who
holds a session, what each student last ran and when, statements and errors in
a window, the disk they are using — and a drill-down with their recent
statements beside their tables. Nothing in phases 0–4 is outstanding.

**Read `services/lesson.ts`'s header before changing anything in it.** It
records why the quota is in a view about queries at all, and the two words
(`online`, `idle`) it refuses to use.

**It is also deployed and live**, on Postgres 17, where the suite passes with
nothing skipped. The privilege model every later phase rests on is therefore
confirmed on the version that actually runs it, not just on the dev machine's
18.4.

**The two overdue items are done on the server** (2026-07-28), in the order that
mattered — backups first, because they were the safety net for the second:

- **Nightly backups are installed and running.** `db/backup.sh` from the host
  crontab at 03:17 under `flock`, both databases plus roles, 14 runs kept,
  each dump verified, each run published by a single rename. `pgdata` is no
  longer the only copy.
- **Both databases are ICU `de-CH`.** The cluster was recreated on an empty
  data directory, which was free because nothing was in it. That window is now
  **closed and irrelevant**: the deployed databases already have the collation,
  and any future rebuild gets it from `00-bootstrap.sh` as a matter of course.
  There is no destructive runbook left in §7 to run by mistake.

**The deployed instance now has a real class, created by clicking.** §4aa is
closed on the server, not just in the repo. It also means the dev-cluster hazard
of §4cc is now the deployed cluster's normal state: accounts a human made,
which a live suite must never derive an identifier that could collide with.

**§4a is still the trap that matters** (`dbk_app` cannot cancel — or see — a
student's objects the obvious way, because it holds their roles NOINHERIT). It
has now bitten three times in three different disguises: cancellation (§4a),
`information_schema` returning empty (§4o), and the quota nearly measuring every
student as 0 bytes (§4q). Whenever `dbk_app` asks a question *about* a student,
check which of the two it is asking as.

You do **not** need `users.ts`, `classes.ts`, `reconcile.ts` or `provision.ts`.
And **do not read ARCHITECTURE.md end to end** — see below.

**Do not read ARCHITECTURE.md end to end.** It is 600 lines and most of it is
settled. §5, §6, §7, §8 and §9 are background you can look up if a question
comes up.

### Reading this repo without drowning in it

The 5b session ran its context almost dry, and the causes were mechanical
rather than unavoidable. In rough order of cost:

- **Grep for anchors, then read a window.** This file is 1800 lines and
  `provision.ts` is 900. `grep -n` for the symbol or the § marker and read
  ±40 lines around the hit. Reading a 200-line span "for context" is what
  costs, and it is almost never what answers the question.
- **Pipe every test run through `tail -15` or `grep -E '^(✔|✖|ℹ)'`.** A full
  `npm test` is 250 lines of green ticks. A single failure prints a stack, a
  driver error object and a serialised query — 3 000 tokens for one assertion.
  Get the summary first, then `grep -A20` for the one test that failed.
- **Do not write throwaway shell scripts with inline `node -pe` JSON
  extraction.** Two attempts at that produced pages of `SyntaxError` stacks and
  proved nothing. If a route's response shape is in question, `curl` it once and
  `head -c 300` the body.
- **If you delegate a review, ask for terse findings.** Six subagents returning
  richly-argued JSON is 25k tokens landing at once, and their value was in the
  one-line summaries. Ask for `file:line` plus one sentence, and pull the
  reasoning only for the ones you are going to act on.
- **`npm run build` before any live suite**, always. The live suites import from
  `dist/`, so a stale build makes them fail against code you have already fixed,
  and diagnosing that costs more than the build.

---

## 1. Where things stand

| Phase | State |
|---|---|
| 0 — compose stack, Postgres bootstrap, migrations, demo seed | **Done and deployed.** The compose/Docker path — open since phase 0 — is now verified on the server. |
| 1 — auth, sessions, admin→teacher→student CRUD | **Done.** 88 end-to-end HTTP checks green. |
| 2 — provisioning engine | **Done.** Roles, schemas, grants, reset, archive, deprovision, reconciler. 12 live-Postgres tests green. |
| 3 — query runner + cancellation watchdog | **Done.** 13 live-Postgres tests green, plus 8 unit. Exercised over HTTP. |
| 3 — student page UI | **Done.** CodeMirror 6, result grid, schema browser, Cancel, self-reset. Driven in a browser against a real cluster. |
| 3 — CSV upload | **Done.** Sniffing, Swiss coercion, editable preview, batched INSERT. 35 unit + 10 live tests green; driven in a browser with a real Windows-1252 Excel export. |
| 3 — quota enforcement | **Done.** On-demand measurement, both write paths refused. 14 unit + 5 live tests green; driven end to end over HTTP. |
| 4 — teacher's live lesson view | **Done and deployed.** Roster, per-student drill-down, quota as state. 8 unit tests; driven over HTTP and in a browser, then on the server. |
| 5a — roster UI, bulk-create, credential slips | **Done and deployed.** `/roster` for admin and teacher. 9 unit tests on the name parser; driven in a browser end to end, then on the server with paper coming out of a printer. |
| — backup **restore** drill | **Done, on the server's own backups.** Found §4dd. The backup path is now proven by the only thing that proves one. |
| 5b — lifecycle/archival job | **Done and deployed.** Cold storage, the restore, the nightly sweep. 20 unit + 10 live tests. Driven over HTTP end to end, then on the server through a real account and back. The first migration since phase 0 — §7 records how it went. |
| 6a — the SQLSTATE hint layer | **Done and deployed.** German explanations for 20 SQLSTATEs on the SQL page, plus a did-you-mean drawn from the student's own catalog. 38 unit tests; driven in a browser against a real cluster, then on the server in both languages. |
| 6b — i18n (de/en) | **Done and deployed.** Both locales on every page, `app_user.locale` the only source of truth, a `<select>` in each nav, `de-CH`/`en-CH` for the four `Intl` sites. `hints.js` returns a key plus substitutions and both catalogues carry the phrasing. §4mm has the three decisions, §4nn the traps. Shipped together with 6a — one deploy, not two, because 6b restructured what 6a built. |
| 7 — the Chalk pass | **Done and deployed.** One stylesheet where there were six inline blocks, a top bar on all six pages, light/dark with a no-flash script, self-hosted subsetted fonts, and the 6b language `<select>` finally styled. 2 unit tests; driven in a browser as a student and as admin, both locales, both themes. §4pp is what it turned up. |
| 7.1 — fixes from real use | **Done and deployed.** The autocomplete popup was white-on-white in dark mode (a phase 7 regression, 1:1 → 13.2:1); the schema browser invited students to `CREATE TABLE` in `public`, where Postgres refuses it; and a footer now names the running build. §4qq. The deploy failed first — §4ss. |
| 7.2 — the quota a student can see, and the import's hints | **Done and deployed.** §8 items 6 and 0, taken because neither has a confirmation flow in it. 5 unit tests (a new SQLSTATE), 3 HTTP checks, 1 isolation check. Driven in a browser as a student against a real cluster: both locales, both themes, the over-quota state forced with `DBK_STUDENT_QUOTA_MB=1`, and a real `2BP01` through the import dialog. §4tt. |
| 7.3 — cold storage and deletion get buttons | **Done and deployed.** §8 items 2 and 5, taken whole. Cold is admin-only and confirmed once because it is reversible; deletion is teacher-initiated per §8b and confirmed twice, in two dialogs that say different things. 3 HTTP checks. Driven in a browser in both locales, as admin and as teacher, with the cold round trip and a real deletion verified against `pg_roles`, `pg_namespace` and the archive directory. §4uu. |
| 7.4 — §8's leftovers | **Done and deployed.** Boot reconcile moved after `app.listen`, the nightly sweep watched firing for the first time, the sweeper's log line made true under any `TZ`, `verify-isolation.sh`'s fixtures moved out of the app's namespace, and six-month archive retention. §4vv — which also caught a deploy that had silently done nothing. |
| 7.5 — the Chalk contrast fix | **Done and deployed.** White on the accent measured 2.87:1 and failed WCAG AA — on all six accents in the family, not just this one. All six darkened to the lightest L at which white clears 4.5; hue and chroma untouched. §4ww. |
| **v1 complete** | Phases 0–7.5. ARCHITECTURE §9 scoped v1 as phases 0–7; everything in it is built, deployed and verified. |
| 8 — v2: exercises, auto-checking, class matrix | **Not started, and not the same thing as the 7.x work above.** ARCHITECTURE §9 reserves phase 8 for v2. The `exercise` and `submission` tables have been in `meta/001_init.sql` since phase 0, unused, waiting for it. |

**Deployed 2026-07-28** to `/opt/apps/datebaenkli` on the server, behind
the reverse proxy at `datebaenkli.schaffner.xyz` with a Let's Encrypt
certificate. §5 records what that confirmed and what it found; §7 is the
runbook, corrected against what actually happened.

**Later the same day**, the cluster was recreated onto ICU `de-CH` while it was
still empty, nightly backups went into cron at 03:17, and phase 4 was built and
deployed. **Then 5a, 5b, and finally 6a+6b as a single code-only deploy**
(`d4ac149`). The deployed instance is therefore the one the repo describes, with
no pending operational work.

---

## 2. Code map

```
db/init/00-bootstrap.sh     runs once as superuser on first DB start; creates
                            both databases with ICU de-CH and refuses without it
db/backup.sh                host-side nightly dumps + `--check`. No password, no
                            postgres client on the host: it goes via docker exec
db/verify-isolation.sh      28 checks: the SQL sequences, against a real server
db/verify-auth.sh           88 checks: HTTP, against a running app
app/src/
  config.ts                 env validation; throws on boot for bad input
  server.ts                 migrate → bootstrap admin → reconcile → listen
  auth/                     password (scrypt), identifiers, sessions, ratelimit
  crypto/secretbox.ts       AES-256-GCM for stored student PG passwords
  db/pools.ts               meta + teach admin pools; per-student pool cache
  db/query.ts               the Db/Queryable interface the services take
  db/ident.ts               PHASE 2. Role-name allow-list + SQL quoting.
  db/migrate.ts             checksum-guarded SQL migration runner
  http/                     auth hooks, one error shape, hand-rolled validation
  services/users.ts         accounts; owns the meta half of provisioning
  services/classes.ts       classes and rosters; grants follow the roster
  services/provision.ts     PHASE 2. The engine. The only file that builds SQL
                            by string — DDL takes no bind parameters.
  services/reconcile.ts     PHASE 2. Diffs app_user against pg_roles and repairs.
  services/query.ts         PHASE 3. Runs student SQL. Streams rows to cap them.
  services/watchdog.ts      PHASE 3. The only thing that actually stops a query.
  services/catalog.ts       PHASE 3. The schema browser's tree, read AS the student.
  services/quota.ts         PHASE 3. The per-schema disk limit. Measures on
                            demand; `mayGrow()` decides whether to bother.
  services/csv.ts           PHASE 3. Parse, sniff, infer, coerce. Pure — no db.
  services/import.ts        PHASE 3. CSV → a table. The SECOND file that builds
                            SQL by string; its header says why that is a
                            different hazard from provision.ts.
  services/lifecycle.ts     PHASE 5b. The nightly active->archived sweep and the
                            timer that fires it. In-process on purpose; its
                            header says why, and why NOT at boot.
  services/lesson.ts        PHASE 4. The teacher's live lesson view. Reads
                            query_log, the roster and schemaUsage; opens no
                            student connection of its own. Takes a
                            `workspacesByUser` fn since 9 — a student's disk is
                            their playground PLUS their exercise workspaces.
  services/exercise.ts      PHASE 9. The whole exercises feature. Builds NO SQL
                            by string: the schema goes through provision.ts, the
                            CSV fixtures through import.ts's createAndFill. Its
                            header is the design.
  services/audit.ts         append-only administrative record
  routes/                   session, teachers, classes, students, query,
                            workspace, admin, lesson, pages, exercises
  routes/exercises.ts       PHASE 9. Two prefixes in one file: /api/exercises is
                            the teacher's and gates on ownership, /api/my/… is
                            the student's and names no owner at all.
  web/                      seven HTML pages (styling is phase 7)
  web/uebungen.html         PHASE 9. One page, two audiences, branching on role
                            the way home.html does. Carries a SECOND copy of the
                            CSV dialog's markup — test/pages.test.mjs is what
                            keeps the two in step.
  web/assets/sql.js         the student page's logic; served as-is
  web/assets/csv-import.js  the upload dialog; served as-is
  web/assets/hints.js       PHASE 6a. German explanations per SQLSTATE + the
                            did-you-mean. Pure; its header says why every
                            message pattern was read off a real server
  web/assets/markdown.js    PHASE 9. The task-text renderer. Pure, and the
                            fourth module to clear CLAUDE.md's bar for splitting
                            one out — the way it is wrong is an injection.
                            ESCAPE FIRST, then insert tags. Do not reorder.
  web/assets/uebungen.js    PHASE 9. The exercises page's logic
  web/assets/util.js        esc(), json() and wireThemeToggle(), shared by every
                            page script. The toggle's header records why it is
                            the ONLY owner of that aria-label (§4pp)
  web/assets/app.css        PHASE 7. The whole stylesheet — shell above, the
                            page-scoped rules below the banner. Read its note on
                            `.row`/`.cols` before adding a utility class
  web/assets/chalk-tokens.css  PHASE 7. Served copy of the design-system tokens;
                            byte-identical to chalk-design-system/, and
                            test/chalk.test.mjs is what keeps it that way
  web/assets/theme.js       PHASE 7. No-flash light/dark. A CLASSIC script, in
                            its own file — both deliberate, header says why
  web/assets/fonts.css      PHASE 7. GENERATED by tools/vendor-fonts.mjs
  web/assets/fonts/         PHASE 7. 17 self-hosted .woff2, 483 KB. Reached by
                            its own route: /assets/:file is one path segment
app/tools/                  NOT part of the build; both need the network or
                            write generated files, and both outputs are committed
  vendor-fonts.mjs          PHASE 7. Fetches + subsets the webfonts
  stamp-build.mjs           PHASE 7.1. Writes dist/build-info.json. Runs IN
                            postbuild, so the stamp cannot be forgotten
  web/assets/lesson.js      the lesson view; polls, and stops when tab hidden
  web/assets/roster.js      PHASE 5a. Teachers, classes, rosters, slips. Its
                            header is the argument about one-time passwords.
  web/assets/names.js       PHASE 5a. Splitting a pasted class list. Its own
                            module because it is the only part that can be
                            wrong silently — and permanently.
  web/assets/editor.entry.js  the ONLY bundled file — esbuild → dist/web/assets/editor.js
app/test/
  support/meta-db.mjs       shared PGlite meta database (not a test file)
  support/live-lock.mjs     advisory lock; the live suites cannot provision at once
  support/live-pg.mjs       the rest of the live plumbing: coordinates, the probe,
                            liveSuite(), asUser/tryAsUser, and dropRoles — the
                            §4u teardown, in one copy instead of five
  sql.test.mjs              migrations parse (libpg-query) and execute (PGlite)
  markdown.test.mjs         PHASE 9. The task renderer; no db, no DOM. The
                            safety cases come FIRST in the file on purpose
  pages.test.mjs            PHASE 9. The HTML on disk: the duplicated CSV dialog
                            has not drifted, and no page grew an inline script
  exercise.test.mjs         PHASE 9. The exercise bookkeeping against PGlite
  exercise.live.test.mjs    PHASE 9. Workspace isolation against a REAL server
  crypto / identifiers      unit
  csv.test.mjs              parsing, Swiss coercion, inference, name folding
  names.test.mjs            the pasted-roster name splitter; no db, no DOM
  hints.test.mjs            PHASE 6a. The German hint catalogue and the
                            did-you-mean; no db, no DOM
  chalk.test.mjs            PHASE 7. Two file assertions, no db, no DOM: the two
                            copies of chalk-tokens.css are byte-identical, and
                            the accent is both declared and aliased
  quota.test.mjs            the keyword scan and the arithmetic; a stub Queryable
  services.test.mjs         the real services against migrated PGlite
  provision.test.mjs        identifier safety + the reconciler's diff
  watchdog.test.mjs         the watchdog's bookkeeping, against a recording fake
  provision.live.test.mjs   the engine against a REAL server; skips without one.
                            Includes the §4dd case: REVOKE CONNECT, prove the
                            denial, prove inventory() SEES it, repair, reconnect
  query.live.test.mjs       the runner + watchdog against a REAL server; ditto
  catalog.live.test.mjs     the schema browser's isolation; ditto
  import.live.test.mjs      CSV upload: own schema, real values, rollback; ditto
  lifecycle.live.test.mjs   PHASE 5b. Cold storage and the restore against a
                            REAL server. The central case ends by connecting AS
                            the student and reading rows written before the
                            schema was dropped — §4dd's standard, not
                            pg_restore's exit code. Also pins that reconcile
                            does NOT recreate a cold account's schema, which is
                            a test that asserts an absence.
```

**The web build.** `npm run build` is `tsc`, then a `postbuild` that copies
`src/db/sql` and `src/web` into `dist` and runs esbuild over
`src/web/assets/editor.entry.js`. CodeMirror 6 is two dozen ESM packages with
bare specifiers and cannot be served to a browser unbundled, so it is confined
to that one entry file behind a `createEditor()` function — everything else,
including `sql.js`, is plain JS served as written. `codemirror`,
`@codemirror/*` and `esbuild` are **devDependencies**: the Dockerfile runs
`npm ci` → `npm run build` → `npm ci --omit=dev`, so none of them reach the
runtime image. The bundle is a build artefact and is not committed.

`/assets` is served by `@fastify/static` registered with `serve: false`, fronted
by one route of ours that carries `config: { public: true }`. Public is
deliberate and load-bearing — §4k is the bug that taught us why — and it is the
same argument `routes/pages.ts` makes for the pages: these files are program
text, not data.

---

## 3. Design decisions you should not silently reverse

**The host-specific values in this repo are placeholders, deliberately** (2026-08-07).
The repo is public, so paths, hostnames, the proxy network name and the hardware
measurements were replaced with generic equivalents: `/opt/apps/datebaenkli`,
`/mnt/bulk/datebaenkli`, `https://datebaenkli.example.com`, "the reverse proxy",
"the server". They are *examples*, not the deployment, and nothing in the app
reads them — the real values live in the server's `.env` and in the operator's
own notes outside this repo.

Two consequences worth knowing before touching deployment:

- **`DBK_PROXY_NETWORK` and `DBK_PUBLIC_URL` must be set in the server's `.env`.**
  `docker-compose.yml` no longer hardcodes either. The compose default for the
  proxy network is the literal string `proxy`, which almost certainly is not
  what `docker network ls` calls yours; an unset value fails at `up`, loudly,
  which is the right direction for this to fail in.
- **Do not "correct" a placeholder to a real value.** Putting the deployment's
  hostname or filesystem layout back into a public repo is the change this
  section exists to prevent. If a doc needs a concrete example, keep it generic.

**From phase 1:**

- **Isolation is enforced by Postgres, not app code.** Every student gets a real
  login role plus a schema of the same name; the app opens connections *as that
  student*. A shared pool with `SET ROLE` is not a substitute — a student can
  type `RESET ROLE;` and escape it.
- **Role name == schema name == app username.** One string. The first makes
  `search_path` (`"$user", public`) resolve with no setup; the second means the
  name a student types to log in is the one they type in
  `SELECT * FROM u_k3a_muster_lena.kunden`.
- **The HTTP layer is closed by default.** Auth and the must-change-password
  gate are *global* hooks; a route is open only if it says
  `config: { public: true }`.
- **Session tokens are stored hashed.** A read of the meta database yields
  nothing replayable.
- **A student cannot be removed from their last class** (`409 last_class`) — a
  classless student is reachable by nobody but an admin.
- **A teacher may only enrol students they already have.** Enrolment *is* the
  authorisation primitive. Moving a student across teachers is an admin action.
- **State-changing `/api` calls must send `Content-Type: application/json`.**
  That is the CSRF control; `text/plain` parsing is removed.
- **Identifiers are never re-issued**, not even after a soft delete.
- **Cookie `Secure` comes from `DBK_PUBLIC_URL`'s scheme, not `NODE_ENV`** — §5
  brings the proxy up without TLS first, and a Secure cookie over plain http is
  silently discarded.
- **A database outage must not log anyone out.**
- **`@fastify/static` stays pinned `^10.1.2`** — 8.x/9.x have path-traversal
  advisories. Phase 3 will want it. Don't downgrade.

**From phase 3:**

- **The disk quota bounds accumulation, not any one statement.** It cannot
  refuse the statement that takes a student over — nothing knows how big a
  result is until it has been written. The watchdog bounds that one. Do not
  "fix" this by measuring after the fact and rolling back; the write has
  already hit the disk by then, and the transaction that would undo it is what
  `temp_file_limit` exists to bound.
- **There is no cached usage number and no background job**, against
  ARCHITECTURE §4's original plan. A cached value is wrong in the direction that
  matters, and `mayGrow()` makes the uncached one free for read-only lessons.
- **A student over quota can still `SELECT`, `DELETE`, `DROP` and `VACUUM`.**
  Removing any of those turns the quota into a trap whose only exit is wiping
  the whole schema.

**From the deployment (2026-07-28):**

- **Both databases are ICU `de-CH`, and the bootstrap refuses to run without
  ICU.** Byte order puts Bühler after Zimmermann; the first `ORDER BY` a class
  runs would return output they have to be told to ignore. The refusal is
  deliberate and must not be softened into a fallback — a fallback hands you a
  byte-order database silently, and you learn about it in a term, when the only
  fix left destroys student work. ARCHITECTURE §10 (10), and §4x below.
- **A backup is not a backup until it has been restored, and `.env` is part of
  it.** `db/backup.sh` verifies each dump by reading its table of contents back
  and publishes a run by a single rename, so a half-written dump can never be
  the newest one. It copies `.env` alongside because without
  `DBK_ENCRYPTION_KEY` the meta dump's `pg_password_enc` column is noise — §4y
  is what that actually looks like at boot.

**From phase 5b:**

- **`cold` keeps the role, NOLOGIN, and drops only the schema.** The schema is
  the disk; a `pg_authid` row is not. That is what makes `cold -> active` the
  same identifier, the same stored `pg_password_enc` and no new slip. Dropping
  the role would make cold indistinguishable from `deleted` inside Postgres
  while still claiming to be reversible.
- **`app_user.archive_path` is the one column that does not violate "Postgres is
  the source of truth".** §3 refuses a `provisioned_at` flag because `pg_roles`
  already answers that question; nothing in either database can answer "where is
  this account's dump", because it is a file outside both. Migration 002 carries
  the argument in full. It is written only once a dump exists and cleared only
  once a restore has been *proved*, so it never claims a backup that is not there.
- **`archive_after_days` moved from the `setting` table into config, and 002
  deletes the seeded row.** Everything that decides whether a job takes logins
  away from students is validated at import and crashes the container on a bad
  value. An unvalidated jsonb row with no writer and no UI is a decoy, and
  leaving it there invites somebody to edit it and expect something to happen.
- **The restore runs `--role`, never as `dbk_app`.** §4ee. Do not "simplify" it
  back; the live suite fails immediately, which is the good outcome, but the
  reason is worth reading before spending an hour on it.
- **A failed restore must leave the account cold-shaped** — no schema, NOLOGIN,
  dump still named. That is the only state the reconciler can retry from, and
  §4ff is what leaving a schema behind actually costs.

**From phase 9:**

- **A student's copy of an exercise is its own schema, owned by them.** Not
  prefixed tables in their playground. Everything else about the feature is
  downstream of this: isolation is Postgres's, "reset this exercise" is
  `DROP SCHEMA`, and the schema browser needed no change at all.
- **The workspace name is allocated once and stored, never derived.** The recipe
  `x<id>_<pgRole>` has to be clamped to 63 bytes and two long names clamp to the
  same string — deriving it at the call site would resolve that collision to one
  schema shared by two students. That is an isolation break, not a cosmetic bug.
- **`db/ident.ts` keeps two disjoint allow-lists.** A workspace cannot match the
  `^[ut]_` a role must have. Do not "simplify" them into one pattern: the
  disjointness is what stops a workspace name reaching `DROP ROLE`.
- **A query in an exercise gets `search_path = <workspace>, public` — without
  `"$user"`.** An unqualified `DELETE FROM kunden` during an exercise must not
  reach the student's own `kunden`, or "reset this exercise only" stops being
  true. Driven in a browser; the playground table survived.
- **A CSV fixture is stored as CSV, not as generated SQL.** Storing
  `INSERT INTO … VALUES ('Müller')` text would be this app building *data* by
  concatenation from an unvalidated file, which `import.ts` refuses to do.
- **Materialisation is lazy, never eager at distribution.** The absence of the
  schema is the trigger, which is what makes a workspace lost to a full reset
  come back by itself.
- **Take-back deletes the hand-ins too, and is behind two dialogs.** The user
  chose that over keeping them. Two dialogs saying *different* things, per
  `roster.js`'s rule: the second names the counts.
- **Auto-checking was dropped, and its columns with it.** Not deferred. Adding it
  back is a phase with its own columns, not a revival of `solution_sql`.

**From phase 2:**

- **Provisioning runs outside the meta transaction, always.** Two databases
  cannot share one. Callers commit the account row first, then provision, and
  report the outcome in a `provisioning` field rather than failing the request.
  A crash in between leaves an account with no role — visible, and repaired.
  The reverse (a role with no account) is invisible and holds a name forever.
- **There is no `provisioned_at` column, on purpose.** Postgres is the source of
  truth for what exists. A flag would be a second one that can disagree.
- **Every provisioning operation is idempotent** — "make it so", not "do it
  once". The reconciler replays them over accounts that already exist.
- **`services/provision.ts` is the only file allowed to concatenate SQL**, and
  every identifier goes through `db/ident.ts` first. The allow-list requires the
  `u_`/`t_` prefix specifically so that `pg_catalog`, `postgres` and `dbk_app`
  fail it — shape alone does not distinguish them from a student.
- **A deletion dumps before it drops, and does not drop if the dump failed.**
  That is the one irreversible failure in the whole system.
- **The reconciler is a security control, not just a repair tool** — see §4(a).
- **`inventory()` must be able to see everything the reconciler can repair**, or
  a clean report means nothing. §4dd is what that costs: it read roles, schemas
  and schema ACLs, and the one privilege it could not see was the one a restore
  loses. Adding a repair without adding the corresponding read gives you a
  reconciler that truthfully reports success over a broken cluster.

---

## 4. Findings

### (xx) From phase 9 — exercises

Four, and the second is the one to read: it is a correction to something this
session wrote and briefly believed.

**(1) The layout bug a screenshot would not have caught.** The exercise bar on
`/sql` is a *fifth child of a four-row grid*. `#work`'s `grid-template-rows` is
positional — toolbar, editor, results heading, results — so inserting the bar in
front shifted every one down: the toolbar took the editor's
`minmax(8rem, 2fr)` and grew to eight rems, the editor took an `auto` row and
collapsed to nothing, and the results fell out of the template into an implicit
row. **The page still looked plausible.** It was caught by measuring
`#editor`'s height, not by looking at it — and the lesson is that a grid with a
positional row template has an invariant (its child count) that nothing states
and nothing checks. Fixed with `#work:has(> .ex-bar:not([hidden]))`, which is
`:has()` earning its keep: a static five-row template cannot serve both cases,
because with the bar hidden it is not a grid item at all.

The same pass found the teacher's two tables overflowing a phone viewport. The
repo already had `.table-wrap` for exactly that; the tables scroll inside it now
and the page does not.

**(2) A comment I wrote was wrong, and the test that "proved" it did not test
it.** I added a workspace sweep to `coldStore` and wrote that without it a
workspace would survive cold storage — leaked, undumped, and enough to make a
later `DROP ROLE` fail. Then I deleted the sweep and ran the live suite, and it
**still passed**.

The reason: `coldStore` already ends with `DROP OWNED BY CURRENT_USER CASCADE`,
there for large objects, and that drops every schema the role owns — workspaces
included. The sweep is redundant on the ordinary path.

It is *not* redundant on one path, and that is the narrow thing it should have
claimed from the start: `coldStore` **returns early** when the playground is
already gone, so nothing after that point runs. An account can be in exactly that
state — `restoreStudent`'s failure path drops the playground by name and leaves
the workspaces, which is the cold-shaped state §4ff requires it to leave behind.
Re-cooling that account is what an operator or the reconciler does next.

The comment now says that and nothing more, and the live suite has two cases: the
ordinary one, which passes either way and says so out loud, and
`re-cooling an account with no playground still drops its workspaces`, which
fails when the sweep is removed. **Verified by removing it.**

Two things worth carrying forward. A test that passes is not evidence the code
under it is load-bearing — the only way to find out is to delete the code. And
CLAUDE.md's own rule was the one being broken: *a line that looks like a control
and is not one is worse than no line*, and a comment that overstates what its
code does is that line.

**(3) The teacher's disk column was quietly wrong, in the direction that
matters.** `services/lesson.ts` narrowed `schemaUsage(only)` to the class's
playground schemas, so once exercises existed it reported a fraction of what a
student held — and by more the more the class used the feature. A teacher would
read "12 of 50 MB" for someone about to be refused a write. The fix sums a
student's workspaces into their figure and keeps the query narrowed to the class
(`schemaUsage()` unfiltered is a roster of every other teacher's students).

`services/quota.ts` had the same shape and got a different fix: `usage()` now
measures **by owner** rather than by schema name, so it collects the playground
and every workspace in one round trip without being told which exist. It keeps
the by-name condition as a safety net for a schema named after a student but
owned by somebody else — a broken state nothing else checks for, where the
direction to be wrong in is over-counting.

**(4) `npm test` peaked at 9.4 GB and OOM-killed a developer machine. Fixed with
one flag.** Not new and not a leak, but phase 9 made it worse.

`node --test` runs test *files* in parallel, and `support/meta-db.mjs`'s
`freshMeta()` does `new PGlite()` per test without ever closing it — PGlite is
Postgres compiled to WASM, so the instances accumulate for the life of a file.
Measured 2026-08-07, each file **on its own**: `services.test.mjs` 4.6 GB,
`exercise.test.mjs` 4.6 GB, `sql.test.mjs` 4.3 GB. Phase 9 added the
second-largest of those to the parallel pool, which is what tipped it over on a
machine also running a browser.

`package.json`'s test script now carries **`--test-concurrency=1`**. Measured
after: **4.5 GB peak, 232 s wall clock**, same 311 passing. The before/after on
memory is a 52 % cut; the wall-clock cost is not stated as a delta because the
parallel run was never timed cleanly and re-running it to find out would mean
provoking the OOM again.

**The real fix is still not done** — closing the PGlite instances, which touches
every test file. Until it is, this flag is the only thing between the suite and
the machine. Two consequences worth knowing: removing it to speed the suite up
brings the 9 GB back, and adding a fourth PGlite-backed test file now costs
runtime rather than memory.

The general lesson is the cheaper one: **a test suite has a resource footprint
and nothing in this repo was measuring it.** It surfaced as an OOM kill on a
developer's desktop rather than as a number anyone had looked at, and the
measurement that found it was four lines of `ps` in a sampling loop.

### From phase 5b — read before touching cold storage, the restore, or the sweep

**(ee) `dbk_app` cannot restore into a schema it has just given away, and that
killed the obvious design.** `dumpSchema` connects as `dbk_app` and passes
`--role`, because `dbk_app` holds student roles NOINHERIT and a plain dump would
produce an empty archive and report success (§4a). The restore looks like it
should mirror that in the other direction — run as `dbk_app`, let the dump's own
`CREATE SCHEMA` and `ALTER … OWNER TO u_x` put ownership back, since `dbk_app`
holds `SET TRUE` on the role and those statements therefore succeed. It was
written that way, it typechecked, and the live suite failed on the first case:

```
pg_restore: error: could not execute query: ERROR:  permission denied for schema u_llt_muster_lena
Command was: CREATE TABLE u_llt_muster_lena.kunden (...)
```

`dbk_app` creates the schema, the dump's *next* statement transfers ownership to
the student, and from that instant `dbk_app` has no `CREATE` on it — NOINHERIT
means it does not pick up the student's privileges, only the ability to *become*
them. The ownership transfer is the thing that locks it out, one statement in.

**This is §4a's fifth appearance**, after cancellation, `information_schema`
returning empty, the quota measuring 0 bytes, and §4dd's scope problem. The rule
has earned a stronger form: **whenever `dbk_app` touches a student's objects,
assume it must `SET ROLE` first, and require a reason for any case where it does
not.** The exceptions so far are all reads of `pg_catalog`, which is world-readable.

So the restore runs `--role` too. That costs one thing, and the fix for it is the
odd-looking part of `restoreStudent`: a student role is `NOCREATEDB
NOCREATEROLE` and never holds `CREATE ON DATABASE` — `ensureRole` creates their
schema *for* them — so `SET ROLE u_x` cannot execute the dump's `CREATE SCHEMA`
either. Hence: `ensureStudent` makes the schema first, and the dump's schema
entry is filtered out of the restore through a `pg_restore --list` /
`--use-list` pair. `--no-owner` then comes free and removes a class of failure,
because with `--role` every object is created *by* the student and ownership is
right by construction.

The rejected alternative is worth knowing so it is not re-proposed: grant the
student `CREATE ON DATABASE` for the duration of the restore. It opens a window
in which a student can own a second schema, a crash mid-restore leaves that
window open, and `inventory()` cannot see database-level CREATE — which is
exactly the blindness §4dd is the story of.

**`--no-privileges` is also deliberate and is a real isolation property.** A
year-old dump carries the ACLs the schema had when it was cooled, including
USAGE to a teacher who may no longer teach that student. The roster is the
source of truth for who may read a schema, so the dump's ACLs are dropped and
`ensureStudent` applies the current ones.

**(ff) The tests were green and the design was wrong in six places, all in the
same place.** 5b's unit and live suites passed, both shell nets passed, and the
whole thing had been driven over HTTP — and a review pass over the diff then
found six defects, five of them variations on one theme: **what happens when
something fails after the irreversible step has already succeeded.**

Concretely, `restoreStudent` used to do its verification and its second
`ensureStudent` *outside* the try/catch that rolls back. Any failure there —
a count mismatch, a dropped connection, a transient pool error — left the schema
restored, `archive_path` still naming the dump, and the account in a shape
nothing repairs: the reconciler's retry fires only for an account with *no*
schema, so it skipped it and reported the instance clean, while every later
reactivation died on the "schema already exists" guard. The same shape appeared
four more times: the bookkeeping `UPDATE` inside `tryProvision` (a meta blip
reporting a successful restore as a failed one), the sweep's loop throwing on
one account and abandoning the rest along with the audit row for the ones it had
already archived, `coldStore` reporting success for an account with no role, and
reconcile requiring a live role before it would restore — which sent an account
whose role *and* schema were both gone down the `ensureStudent` path, creating
an empty schema over a term's work and filing it under `created`.

**The sixth was a genuine coverage hole, and it is the instructive one.**
`restoreStudent` verifies by connecting *as the student* — §4dd's standard of
proof. The reconciler restores an account into whatever state its row says, and
for an archived account that is NOLOGIN, which cannot connect. So the one check
that makes the method worth having failed on exactly the unattended path, after
the data had landed. Every test in the suite exercised `canLogin: true`. There
is now a case that does not, and `restoreStudent` holds LOGIN for the duration
of its own verification and applies the requested state at the end.

Two things generalise:

1. **A rollback path must cover everything after the irreversible step, not just
   the irreversible step.** The `catch` was around `pg_restore` because that is
   the part that feels dangerous. The dangerous part is everything downstream of
   it, because that is where a failure leaves a state no invariant describes.
2. **A live suite that only ever exercises the happy parameters is a live suite
   with a hole in it**, and the parameter most likely to be missed is the one
   only the *unattended* caller passes. The reconciler is the unattended caller
   here; it is worth asking, for any new seam, what it passes that a human never
   would.

### From deploying phase 5b — read before trusting a time in a log line

**(gg) "03:40 local" is 03:40 UTC, and the deployment does not run
`TZ=Europe/Zurich`.** Confirmed on the server after the 5b deploy:

```
$ docker exec datebaenkli-app date;  docker exec datebaenkli-app sh -c 'echo TZ=$TZ'
Tue Jul 28 14:01:43 UTC 2026
TZ=
```

Nothing in `docker-compose.yml` or `app/Dockerfile` sets `TZ`, and the runtime
image is Alpine, so the container is UTC. `startArchiveSweeper` logs the word
"local" because the timer really is computed against the process's local zone —
it is just that the process's local zone is UTC. **The sweep therefore fires at
05:40 CEST in summer and 04:40 CET in winter, not 03:40 Swiss time.**

Three consequences, in ascending order of how much they matter:

- **The sweep's actual hour is harmless.** It does `active -> archived`, which
  takes LOGIN away and touches no schema; there is no dump, no drop, and nothing
  to race. Cold storage — the direction that *does* dump and drop — is manual
  and admin-only. So this is a misleading log line, not a scheduling bug, and
  the fix is to the wording or to `TZ`, not urgent either way.
- **The host is UTC too**, so the 03:17 backup cron and the 03:40 sweep are
  genuinely 23 minutes apart and in that order. Do not "fix" one of them into a
  different zone without moving the other; the useful invariant is that the
  sweep runs *after* the night's backup, and it currently does.
- **CLAUDE.md was wrong**, and this is the part worth remembering. It said to run
  the live suite with `TZ=Europe/Zurich`, "which is what the deployment uses
  anyway". It is not. The claim has been corrected rather than deleted, because
  the *instruction* is still right for the reason §4l gives: the two date
  assertions in `query.live.test.mjs` are invisible under `TZ=UTC`, so the suite
  must run in a non-UTC zone to be worth anything. The suite is deliberately
  stricter than production here — which is the safe direction, and is now said
  out loud instead of being justified by a false statement about the deployment.

The general shape: **a documented fact about the deployment that no test asserts
will drift, and the drift is invisible because the sentence still reads
plausibly.** This one cost nothing. The next one might be about a zone that
matters.

**(hh) Nothing prunes the archive directory.** `/mnt/bulk/datebaenkli/archive`
accumulates a `.dump` per cold-store and per deletion, forever. After the 5b
deploy it holds the three `u_vcaa95e_*` and two `t_ifyacaa95e*` dumps that
`verify-auth.sh` left behind in the morning, plus the drill's own — and a
restored account's dump stays after `archive_path` is cleared, deliberately,
because the file is history and the column means *current*.

That is correct behaviour and an unbounded directory at the same time. It is on
a bulk disk holding kilobyte-sized dumps, so it is not a problem yet, and a
retention policy is a real decision (how long is a term's work worth keeping
after the account is gone?) rather than a chore. Recorded so that whoever finds
a full disk in 2029 finds this paragraph first. `db/backup.sh`'s 14-run
retention is the precedent for what the answer looks like.

### From phase 6b — read before touching a string, a catalogue or the locale plumbing

**(mm) Three decisions were taken before the sweep, and two went against
ARCHITECTURE §8a's recommendation.** They are recorded here because the
arguments are not re-derivable from the code:

- **No `class.default_locale`, and no locale select on the roster form either.**
  §8a recommended the column and this session argued for it. Both were
  overruled, and the reason is worth having in full because it makes the
  "November student" argument moot rather than merely outweighed: **German first
  for everyone, with a toggle, is the intended design and not a shortfall.**
  Every student meets a German interface and switches it if they want to — so
  there is no state to inherit, nothing silently reverts, and the immersion class
  differs from any other class only in how many students click the select once.
  Do not re-derive the column as a fix for a problem that was declined.
  The wire is already ready for
  either fix — `POST /api/classes/:id/students` accepts a per-student `locale`
  (`routes/classes.ts`), and `createStudents` resolves
  `person.locale ?? config.i18n.defaultLocale` — so the form-select version is
  *zero* backend work whenever it is wanted. The column is a migration.
  **The credential slips inherit this**: they render in the *teacher's* locale,
  and they are printed, so they are the one output that cannot be re-rendered
  after a student switches.

- **The `Intl` calls follow the UI language, but only in the language subtag:
  `de-CH` and `en-CH`.** §8a posed this as "follow the UI *or* stay Swiss" and
  both horns are wrong — **the region tag is the Swiss part and the language tag
  is the interface part**, so there was never a trade to make. `en-CH` keeps the
  apostrophe group separator, the day-first date and the 24-hour clock; across
  the four call sites the only visible difference from `de-CH` is that dates gain
  zero-padding (`25.03.2026` rather than `25.3.2026`). Two students side by side,
  one reading English, still see the same numbers in the same shape, which was
  the requirement that decided it.
  **`en-US` would break it** — `3/25/2026` and `2:03 PM` put the month before the
  day in a Swiss classroom. If a third locale is ever added, keep the `-CH`.
  There are **four** such sites, not the three §8.0 counted — `roster.js`'s
  `toLocaleDateString` was missed. All four now go through `formats()` in
  `i18n.js`, which holds the rule and the argument in one place; the two in
  `sql.js` and `csv-import.js` are lazy wrappers because the locale is not known
  at module-eval time.
  `test/i18n.test.mjs` pins this, and pins it as a *relation* rather than as
  literal glyphs: the two locales must agree on numbers and on the clock, and
  both must stay day-first. The `de-CH` group separator has changed between ICU
  versions (U+0027 vs U+2019), so asserting the character would only report on
  the Node build. The same test builds its sample date from *local* components
  rather than `Date.UTC`, because `toLocale*` renders in the process zone and no
  single instant is on the same calendar day everywhere — §4l one layer down.

- **The language control is a bare `<select>` in each page's existing nav, and
  the top bar is phase 7's.** §8a describes a 36–38 px bordered square button
  beside the theme toggle, per a Chalk top-bar recipe. **None of that exists in
  this repo**: no top bar, no theme toggle, no `chalk-theme` key, and no
  stylesheet at all — six pages, six inline `<style>` blocks, and only `sql.html`
  has a `<header>`. Building it would have made 6b a styling phase, which §8.0
  warned about in advance. There is also **no `localStorage` mirror**, against
  §8a: it was specified to match a convention that does not exist, and adding it
  would mean answering "which side wins after a switch on a second device?" for
  no present benefit.

  > **Overtaken by phase 7 (2026-07-29), and kept because the reasoning is what
  > matters.** All of it now exists: one stylesheet, a top bar on every page, a
  > `chalk-theme` toggle, and the `<select>` styled into it. The mirror exists
  > too — and the question that deferred it turned out to have no answer because
  > it had no second side: `chalk-lang` is a paint-ahead cache and
  > `app_user.locale` always wins (§4pp, ARCHITECTURE §10 (13)). 6b was right
  > not to guess at that in advance; the convention it would have matched had to
  > be built before the question was answerable.

**(nn) Four things about the plumbing that are not obvious from reading it.**

- **The pages cannot be rendered in the reader's language by the server.**
  `routes/pages.ts` reads each file once at boot and sends the identical string
  every request — no template engine, no substitution of any kind. So §8a's
  "server renders the initial page in the stored locale so there's no flash of
  German" **is not what happens**, and getting it would mean introducing
  templating. Every page instead ships with German in its markup and swaps it
  after `/api/me` answers. The German left in the markup is also the fallback
  when the script does not run at all, which is §4k one level down. The
  file's header used to claim `/assets` was *not* public, which §4k reversed
  long ago; that is corrected now.

- **`apply()` writes `textContent`, so `data-i18n` on an element with markup
  inside it eats the markup.** A `<label>` that wraps its own `<input>` becomes a
  dead form field — and only in whichever locale was swept second, which is the
  kind of thing that ships. Every such string is a `<span data-i18n>` inside the
  label instead. Five paragraphs with a `<code>`/`<em>` mid-sentence are split
  into `_1`/`_2` keys around the tag; that constrains word order across the two
  languages, which is a real cost and is why it was only done five times.

- **English falls back to German, not to the key.** A key present in `i18n-de.js`
  and missing from `i18n-en.js` renders German on an English page. That is the
  safe direction — a bilingual page is ugly and readable, a page of
  `roster.students.none` is not — but it means **a missing translation is
  invisible in a screenshot**. `test/i18n.test.mjs` is what catches it: it
  asserts the two catalogues have identical key sets, that every `{placeholder}`
  matches between them, that backticks are balanced, that no German string
  contains a `ß`, and — reading `http/errors.ts` directly — that every error code
  the server can emit has an entry. Those five assertions are the only thing
  standing between this and silent rot. Do not delete them to make a sweep pass.

- **`hints.js` handlers return `{ key, vars, suggestion }` and `renderHint(hint,
  t)` puts the sentence together.** Forking twenty handlers into an English copy
  was explicitly rejected (§4jj is why the branching is the part worth
  protecting). Two rules inside it: a **scalar** substitution goes in bare and
  the *template* decides whether it is shown as code, because that is a phrasing
  decision; an **array** is backticked per element and joined with the locale's
  own conjunction, because the number of names is not known until runtime. Every
  value goes through `plain()` on the way out of a handler, which strips
  backticks so a table named `` a`b `` cannot unbalance the caller's pairs.

**(oo) Two pre-existing bugs in `lesson.js`, found by the 6b sweep and fixed
afterwards.** Neither was caused by 6b. Recorded because the *third* thing the
fix turned up is the part worth remembering:

1. **`get()` had no `.catch()` on its `fetch`**, and its result is consumed by a
   top-level `await`. An offline blip therefore aborted module evaluation and
   left the teacher on the bare HTML shell with no error — §4k's failure in a new
   costume. It now carries `.catch(() => null)` and a null guard, which is
   `roster.js`'s `get()` exactly; a transport failure returns null like a non-ok
   response already did.
2. **`get()` redirected on 401 without stopping the module.** Now matched to
   `sql.js`: the bootstrap throws `redirecting` after its two redirects. That is
   also what let the locale load go back to `me.user.locale` from the
   `me?.user?.locale` this section used to explain.

3. **The fix that mattered was neither of those.** `.catch()` alone would have
   turned a blank page into a *lying* one. The bootstrap read
   `(await get('/api/classes'))?.classes ?? []`, which flattens "the request
   failed" and "this teacher has no classes" into the same empty array — so the
   guarded version would have rendered "Noch keine Klasse", a confident and
   wrong statement about the account, where it previously rendered nothing. The
   two are now separate branches: only a 200 may say `common.no_classes`,
   anything else says `error.offline`. **Any `?? []` sitting on the result of a
   fetch helper that returns null on failure is worth re-reading for this** —
   the default is invisible at the call site and it is always the empty state's
   sentence that gets shown for an error.

   A related judgement, deliberately the other way: `poll()` leaves the last
   good table standing when a refresh fails instead of replacing it with the
   offline message. Mid-lesson that is usually a five-second blip, and stale
   rows beat an empty screen for a teacher reading the room. The clock in `sub`
   silently stops advancing, which is the tell.

### From phase 6a — read before adding a SQLSTATE, or before trusting a parsed error message

**(jj) Four of the message shapes the hint layer parses are not what they look
like, and all four were found by asking a server instead of remembering.** Ten
minutes of `psql` with a `GET STACKED DIAGNOSTICS` loop corrected four guesses
that would each have shipped as a confidently wrong German sentence:

- `SELECT * FROM demoo.kantone` is **42P01** `relation "demoo.kantone" does not
  exist` — not 3F000, and the schema is **inside the quotes**. 3F000 `schema
  "demoo" does not exist` exists too, but comes from DDL like `CREATE TABLE
  demoo.x`, not from a SELECT.
- **42703 has three phrasings**, and only one names its table: `column "x" does
  not exist`, `column "x" of relation "y" does not exist`, and — for an
  alias-qualified reference like `SELECT k.x` — `column k.x does not exist`,
  **with no quotation marks at all**.
- **42P01 also covers** `missing FROM-clause entry for table "x"`, which is a
  different mistake (a table not in FROM, or an alias being ignored) and needed
  its own sentence.
- **42883 covers both** `function lenght(text) does not exist` and `operator does
  not exist: text + integer`. One is a typo, the other is a type mismatch, and
  one German sentence cannot serve both.

The general rule: **a message you parse is an interface, and the only place its
shape is documented is a running server.** `test/hints.test.mjs` holds the real
strings verbatim so the next addition has examples to copy the method from.

**(kk) A security probe found a correctness bug, which is the usual way round.**
Pasting `SELECT * FROM "<img src=x onerror='document.title=…'>"` into the editor
was meant to check the escaping, and the escaping was fine — `esc()` runs before
the backtick-to-`<code>` pass, so there was no `<` left to open a tag. What it
actually exposed was that the hint split the name on its last dot and announced
that the schema `<img src=x onerror='document.title=String` did not exist.

That is not a contrived input. **`CREATE TABLE "kunden.2025"` is legal SQL**, and
its 42P01 is *indistinguishable* from a schema-qualified one, because the schema
is inside the quotes either way. The message alone cannot answer it. The fix is
that the schema reading is now only taken when the catalog backs it up — the
prefix is a schema the student can see, or is one typo from one — and otherwise
the dot is treated as part of an ordinary name.

The transferable part: **when a probe for one class of bug renders output you
did not expect, read the output rather than just the verdict.** The check
passed; the sentence beside it was nonsense.

**(ll) The German hint leads and the raw Postgres text stays, in full.** Both
halves matter. The raw message is the only part that is certainly true, and it
is what a student pastes into a search engine — `hints.js` returns `null` rather
than guess, and it does so often (an unlisted SQLSTATE, or a listed one whose
message did not match). The CSS demotes the raw line **only when a hint is
present** (`.hint-de + .msg`, an adjacent-sibling selector) because that same
line is the *only* text for a cancelled query or a 4xx from our own API, and
shrinking it there would leave those cases with nothing to read.

Also: hints carry no markup but backticks, which the page turns into `<code>`.
An asterisk for emphasis reaches the student as an asterisk — one was written
and caught before it shipped.

### From hoisting the live-suite plumbing — read before adding a live suite

**(ii) Three of the five live suites had no leak check at all, and nobody could
have told from reading them.** The §4u fix — report a failed drop instead of
swallowing it, then *verify* against `pg_roles` that the roles are gone —
existed in `query.live.test.mjs` and `lifecycle.live.test.mjs`, the two whose
teardown ran in an `after()` hook. The other three had a `teardown()` that
issued one `DO` block over a fixed role list and asserted nothing. That is not
carelessness: `catalog`, `import` and `provision` drop *hardcoded* roles, so
"did I get the order right" is answerable by reading the array, which is exactly
why nobody added the check. But the check is not about the order. It is about
`DROP ROLE` failing for any of the reasons a shared cluster can produce, and
those suites would have reported success while leaving a role behind.

`test/support/live-pg.mjs` now holds one `dropRoles`, and all five get the
assertion. It was proved armed rather than assumed: provision a teacher and a
student, drop them teacher-first on purpose, and it prints
`[teardown] could not drop t_drill_probe: … some objects depend on it` and then
fails on `["t_drill_probe"]`. **Do that again if you touch it** — a teardown
that quietly does nothing is indistinguishable from one that works, which is
the whole of §4u.

**Order is still the caller's problem and deliberately so.** `dropRoles` drops
in the order it is given, because the suites disagree about which order that is:
`catalog`/`import`/`provision` build `ALL` students-first, `lifecycle` pushes
students first, and `query.live` builds `created` teacher-first and reverses at
the call. Sorting inside the helper would need it to know which role is a
teacher, which it cannot, and guessing from the `t_`/`u_` prefix would be a
rule invented in a test helper.

**A latent trap found on the way, now gone.** Each live suite opened with
`process.env.DBK_APP_DB_PASSWORD ??= 'secret'`, and every one of them was dead:
`support/meta-db.mjs` sets the same variable to `'test'` in its module body, and
ESM evaluates imports before the importing module's own statements. So the
fallback was `'test'`, not `'secret'` — invisible because every documented
command sets the variable explicitly, and because the failure mode is a live
suite silently *skipping* rather than failing. `live-pg.mjs` reads the variable
at call time instead of capturing it into a `const`, so import order cannot
decide the answer. **If a live run reports `skipped` when you expected it to
connect, suspect the password before the server.**

### From the restore drill — read before trusting any backup, and before phase 5b

**(dd) A restored cluster has every role, every schema, every row, and not one
student who can connect.** Drilled on the server against its own nightly
backup, following §7's procedure exactly. Everything reported success:
`globals.sql` with the two expected "already exists" errors, both
`pg_restore`s clean, ICU `de-CH` and `upper('straße') = 'STRASSE'` intact, the
account and class lists identical to what was written down beforehand, admin
login fine, and the boot log saying `reconcile: N accounts checked, nothing to
repair`. Then a student logged in with her printed slip, ran a `SELECT`, and got
**"Your previous query is still running."**

The chain, because every link is worth knowing separately:

- `00-bootstrap.sh` does `REVOKE ALL ON DATABASE datebaenkli FROM PUBLIC` on a
  freshly created database, and `provision.ts` grants `CONNECT` per role.
- That privilege lives in **`pg_database.datacl`** — a property of the database,
  not of the role and not of anything inside the database.
- **Neither dump carries it.** `pg_dumpall --globals-only` covers roles,
  memberships and tablespaces. A `pg_restore` *into* a database that already
  exists never touches that database's own ACL; only `--create` would, and the
  procedure deliberately restores into the bootstrapped database so it gets the
  collation.
- So the restore is complete and correct in every respect except one, and that
  one silently denies every student.
- **The reconciler could not see it.** `inventory()` read `pg_roles`,
  `pg_namespace` and `nspacl` — every privilege except this one. Its "nothing to
  repair" was *true*. That is the part worth remembering: a safety net reported
  success over a locked-out class, and it was not lying.

Fixed by teaching `inventory()` to read `has_database_privilege` — the
behaviour, not the ACL spelling, the same principle as the bootstrap's collation
probe (§4x) — and giving the reconciler a narrow `grantConnect` seam beside its
existing `setLogin` one. A restored cluster now repairs itself at boot and the
report says `N database connect grants restored`, which names what was wrong
instead of calling every account "created". Verified on the server: the deployed
instance was in the broken state, the deploy healed it, the second restart
reported nothing to repair, and the student's query returned rows.

The repair runs for **every** state, not only active accounts. NOLOGIN is the
archival boundary; CONNECT is not. Skipping archived roles would leave a restore
that looks healthy until somebody reactivates an account mid-lesson.

**Three things this generalises to, all of which outlive the bug:**

1. **A restore is proven by running the workload on it, not by restoring.**
   §8.3 used to say a backup is not a backup until restored. The sharper version:
   admin login proves *nothing* here, because account passwords are scrypt
   hashes and survive a restore that has destroyed everything else — that is
   also exactly what §4y found about a wrong `DBK_ENCRYPTION_KEY`. The only
   sufficient check is **a student logging in and running a query**, because
   only that path decrypts `pg_password_enc` and opens a connection as them.
2. **`dbk_app` asking a question about a student is wrong until proven right**
   — §4a's rule, in its fourth disguise. Here it was not NOINHERIT but scope:
   the inventory asked about roles and schemas, and the missing privilege was on
   neither.
3. **`too_many_queries` is a guess presented as a fact**, and it is why this
   took a diagnosis instead of a glance. `pool.connect()` failing is reported to
   the student as "Your previous query is still running", which is right for the
   common case and actively misdirecting for every other cause — here it hid
   `permission denied for database`. The driver's real message *is* logged
   (`[query] … could not get a connection:`), which is what made the diagnosis a
   one-liner once someone thought to look. **Deliberately not changed**: deciding
   what a student should see when the cause is not theirs is a UI decision, and
   phase 6/7 is where that lives. Do not "fix" it by leaking the driver error to
   a fifteen-year-old.

**What phase 5b inherits from this, before a line of it is written:**

- The `cold` **restore** direction has the same shape. A per-schema
  `pg_dump -Fc` carries tables and ownership, not database-level grants — so its
  live suite must restore a dump and then **connect as the student and query
  it**, not check that `pg_restore` exited 0.
- `reconcile` does not yet know what `cold` means. Today
  `!inventory.schemas.has(pgRole)` triggers a full re-provision, which would
  recreate an empty schema and silently undo a cold-storage decision — while the
  dump sits on disk unreferenced. **That is a data-loss-shaped bug and it is
  already in the tree**, waiting for the first `cold` account to exist.

### From phase 5a — read before touching the roster page

**(bb) A slip password exists once, and the obvious way to make that safe is the
wrong one.** `POST /api/classes/:id/students` returns the plaintext in its
response body and nowhere else; `password_hash` is scrypt. For a student this is
sharper than it looks, because `mustChangePassword` defaults to *false* for them
on purpose — the slip **is** the credential, not a first-login formality. So a
teacher who pastes thirty names and then closes the tab has thirty dead
accounts, and there is no bulk-reset route: recovery is thirty requests.

The obvious fix is to stash the response in `localStorage`. It was rejected:
thirty non-expiring plaintext passwords left in a school laptop's browser
profile is a worse trade than the one it buys, and it buys less than the third
measure below. What the page does instead:

- **The slip view is not a `<dialog>`.** `lesson.js` uses one for its drill-down
  and is right to, but Esc closes a dialog, and Esc must not be able to destroy
  thirty passwords. The slips replace `<main>` and go away only on an explicit
  click, itself behind a `confirm`.
- **`beforeunload` while slips are unprinted.** It cannot promise anything and
  the browser will not let us say why, but it turns "closed the tab" into "was
  asked first", which is most of the accidents.
- **Losing them costs one click, with provably no collateral damage.** "Neue
  Zettel" re-slips only students whose `lastLoginAt` is null **and** whose state
  is `active`. A student who has never signed in cannot have used their slip, so
  nothing already handed out is invalidated — that filter is what makes the
  button safe to press mid-lesson with twenty of thirty slips already out.

That last claim is the one worth re-proving if it is ever changed, and it was
proved by execution, not by reading: log one student in, press the button, and
her original slip still authenticates (200) while a never-logged-in classmate's
old slip does not (401).

**The `state === 'active'` half of that filter was a real bug, found by driving
it.** Archiving takes the Postgres login away, so a slip for an archived account
cannot be used; the first version counted them and would have printed paper that
does not work. `lastLoginAt === null` alone is necessary and not sufficient.

**The name splitter's escape hatch existed and nobody could find it — found by
driving the deployed page.** A student called "Diego Armando Maradona" came out
as `u_aaa_maradonadiego_armando`, because two first names and a two-word surname
are the same string shape and the multi-word remainder goes to the surname. That
half is the documented trade and is not fixable from the string. The comma
already overrides it (`Maradona, Diego Armando`), and the hint was even on the
page — but the **placeholder demonstrated only the shape that goes wrong**, and
the placeholder is the worked example people actually read. It now shows all
three forms. A hint nobody reads is not a feature; the example is the interface.

**And a real bug next door**: the comma branch required *exactly* two fields, so
`Muster, Lena, 3a` — a paste from a CSV opened as text — fell through to
space-splitting with the commas still embedded and produced the surname
`"Muster, Lena,"`. Permanent, like every identifier. It now takes the first two
fields and drops the rest, which is also what a teacher wants from a trailing
class or mail column.

**A semicolon was considered as a second separator and rejected.** A comma
carries one universal convention (`Nachname, Vorname`); a semicolon is the Swiss
Excel CSV delimiter, so its order would be the *column* order, and the two would
disagree about what they mean. Copying cells out of Excel yields tabs, which the
tab branch already handles — the semicolon only appears if you open the `.csv`
as text, which is the path that also brings a header row. Two separators
disagreeing is a silent-wrongness surface in the one module that exists
specifically to not be silently wrong.

**Two smaller things the page settled.** The name splitter is its own module
(`names.js`) with its own test file, because it is the only part of the page that
can be wrong *silently* and its mistakes are permanent — identifiers are never
re-issued, so a line parsed the wrong way round is `u_k3a_lena_muster` for the
life of the account. Hence also the preview table: the order is a `<select>` the
teacher sets, and the split is shown before anything is created rather than
trusted. A comma and a tab override the select, because they carry the order
themselves; a multi-word remainder goes to the *surname*, because "Von Gunten
Anna" is a name this school has and "Von" is not a first name.

**The address on a slip does not come from the address bar.** `location.host` is
the obvious source and it is wrong: it records however the *teacher* happened to
reach the page — a dev port, the server's LAN address behind the proxy — onto
paper handed to a student, permanently. Found by printing a real sheet, which
said `127.0.0.1:3111`. It is now `config.publicUrl`, returned from `/api/me` as
`app.publicUrl` beside `user`; that value is already validated at import and
already load-bearing (it decides whether cookies are `__Host-`/`Secure`), so a
slip and a cookie can never disagree about what this deployment is called. The
consequence to know: **a wrong `DBK_PUBLIC_URL` is now wrong paper**, not just a
wrong cookie flag.

That coupling has a dev-only edge worth knowing before it wastes an hour.
Setting `DBK_PUBLIC_URL=https://…` on a **plain-http** local instance makes
`cookieSecure` true, so login answers 200 and issues `__Host-dbk_sid; Secure`
— which no client will send back over http, and every subsequent request is
`unauthenticated`. It looks like broken auth and is not. Add
`DBK_COOKIE_SECURE=false` for that case only; §6 has it. **Do not copy that
override into the server's `.env`** — the deployment terminates TLS at
the reverse proxy with a real certificate, where the derived `true` is right.

And the **print CSS is deliberately about pagination, not appearance** — four
rules, scoped to `/roster`, which phase 7 should extend rather than replace. Two
of them are not cosmetic: `break-inside: avoid` on a slip, because a slip split
across a page boundary carries the username on one sheet and the password on
another; and explicit black-on-white, because `color-scheme: light dark` means a
teacher printing from a dark browser otherwise gets a blank sheet.

**(cc) The roster UI broke a live suite, and the reason generalises.**
`query.live.test.mjs` runs against a *fresh meta* database but a *shared*
teaching one, so its identifier allocator cannot see accounts that exist in the
real meta. It created its teacher from a bare `lastName: 'Schaffner'`, deriving
`t_schaffner` — and provisioning is idempotent, so it silently adopted a teacher
a human had already created by clicking. Teardown then failed with 2BP01
(`cannot be dropped because some objects depend on it`), because that teacher's
real students hold grants on it, and the suite reported a leak that was not one.

Harmless before phase 5, when the only way to create a teacher was `curl` and
nobody populated a dev cluster by accident. The roster UI makes a populated dev
cluster the normal case, so the surname is now namespaced — which is what
`catalog`, `import` and `provision` were already doing with their hardcoded
`t_lct_` / `t_lit_` / `t_lvt_` roles, for exactly this reason. The class code
already namespaces students; only the teacher needed it.

**The general rule: a live suite must not derive an identifier a human might
also derive.** The whole suite now passes against a cluster full of
hand-created accounts, which is the state a dev machine will normally be in.

**One thing left for phase 6, noticed here.** The roster surfaces `ServiceError`
messages straight to the user, and they are English (`"This is the student's
only class…"`) on a German page. Phase 6's i18n has to cover service messages,
not just page text — this page is where that becomes visible.

### From collation and backups — read before recreating a cluster or restoring one

**(y) A restore with the wrong `DBK_ENCRYPTION_KEY` does not fail; it starts.**
Drilled for real: dumps taken by `db/backup.sh`, restored into a brand-new
cluster, then the app booted with a freshly generated key. What you get is

```
ERROR: reconcile failed; serving anyway
    Error: Unsupported state or unable to authenticate data
        at decryptSecret (crypto/secretbox.js)
        at toIdentity (services/users.js)
```

followed by `Server listening`. The site comes up, admins can log in — the
account passwords are scrypt hashes and survive — and every path that needs a
student's Postgres password is dead, including the reconciler that would
otherwise repair the cluster. `app_user.pg_password_enc` is AES-GCM, so a wrong
key is indistinguishable from corruption, and the only way back is regenerating
every student's password and re-provisioning by hand.

That is why `db/backup.sh` copies `.env` into each run directory. It makes the
backup directory as sensitive as `.env` itself — 0700, on a disk the app cannot
reach — and that is the trade, taken deliberately. `DBK_BACKUP_ENV=0` opts out
if the secrets are kept somewhere better.

The rest of the drill did work, and is the procedure in §7: bootstrap a fresh
cluster, restore `globals.sql` (the two "role already exists" errors for
`dbk_app` and `postgres` are expected), then `pg_restore --clean --if-exists`
each database. Roles, student schemas, the demo data and the ICU collation all
came back.

One trap found while writing it, worth the sentence because it is the failure
mode the script exists to prevent: an in-progress run is `<stamp>.partial`, and
`find -name '2*'` matches that too. Retention and `--check` both need
`! -name '*.partial'`, or a run that died half way through becomes "the newest
backup" and `--check` reports green.

**(x) ICU is now a hard requirement, and the bootstrap proves it before it
needs it.** Both databases are created `LOCALE_PROVIDER icu ICU_LOCALE 'de-CH'`.
Three things that were not obvious:

- **The probe asserts behaviour, not a name.** It runs
  `SELECT ('Zürcher' COLLATE "de-CH-x-icu") < ('Zwahlen' COLLATE "de-CH-x-icu")`
  against `postgres` before creating anything, and stops if the answer is not
  `t`. A server without ICU errors (no such collation); a server with ICU but
  only root locale data still answers `t`, which is fine — root ICU already
  sorts umlauts as their base letter, and that is the property being bought.
  Probing first matters because a `CREATE DATABASE` that fails *inside*
  `docker-entrypoint-initdb.d` leaves a half-initialised data directory and a
  restart loop that only `rm -rf pgdata` clears.
- **`LC_COLLATE`/`LC_CTYPE` are deliberately not stated**, only `TEMPLATE
  template0`. They are inherited, so the script does not care which locale the
  image's initdb settled on — and with an ICU provider they no longer decide
  sort order anyway. `postgres:17-alpine` installs `icu-data-full` as a runtime
  package and is built `--with-icu`; verified there by execution (§5), not only
  on 18.4 locally. Leaving those two unstated earned its keep immediately: on
  the server they came out **`C` and `C.UTF-8`, mismatched**, because musl
  provides one and not the other. Stating either would have been a guess that
  failed the `CREATE DATABASE` inside `docker-entrypoint-initdb.d` — the one
  place a failure costs an `rm -rf pgdata`.
- **Second-order effects, both wanted.** `upper('straße')` is now `'STRASSE'`
  rather than `'STRAßE'`, and mixed case sorts `apfel, Apfel, Ärzte` rather than
  all uppercase first. One that is not: `LIKE 'name12%'` no longer turns into an
  index range scan without `text_pattern_ops`. Irrelevant at 1000-row teaching
  tables; remember it before concluding an index "doesn't work".

Two more consequences live elsewhere: a dump of these databases will not restore
into a server built without ICU (`MANIFEST` records the provider for exactly
that reason), and a PostgreSQL major upgrade that changes ICU version wants
`ALTER DATABASE … REFRESH COLLATION VERSION` plus a `REINDEX` — seconds at this
size, but it is now an upgrade step that did not exist under `C`.

### From phase 4 — read before touching the lesson view

**(z) A refusal is a state, not an event, and that is what closed §4s's hole.**
The quota check throws before the runner connects, so nothing reaches
`query_log` (§4s, unchanged and still right). The consequence only becomes
visible in a view *about* activity: a student being refused on every keystroke
renders exactly like one who has typed nothing, and telling those two apart is
the whole job of the screen. Logging the refusal would have fixed the symptom
and broken the thing §4s protects. Carrying the student's *current* quota
reading beside their activity fixes it without touching the log at all — and is
strictly better, because it says the condition is still true rather than that
something once happened. `services/lesson.ts` has the argument in full; a test
asserts an over-quota student who has run nothing is still visibly over quota.

Generalises past the quota: before adding a row to `query_log` to explain
something a view cannot see, check whether the thing is a condition you could
read instead.

**(aa) The instance cannot create an account without `curl`, and that is phase
5's actual scope.** Discovered by deploying phase 4 and having nowhere to click:
the lesson view needs a class with students in it, and there is no page that
makes one. `POST /api/teachers`, `POST /api/classes` and
`POST /api/classes/:id/students` all exist, are tested, and work — the roster
UI is simply the phase that was never built. The first teacher on the deployed
instance was created this way.

Two things follow that are easy to get wrong later. A password cannot be looked
up: `app_user.password_hash` is scrypt, so the only operations are "create,
which returns a one-time slip" and `POST /api/{teachers,students}/:id/password`,
which issues a new slip and invalidates the old one. And creating a duplicate
is permanent — identifiers are never re-issued (§3), so a second
`Philip Schaffner` becomes `t_schaffner2` forever. Check `GET /api/teachers`
before creating.

**`schemaUsage()` needed a filter before a teacher could be shown any of it.**
Unfiltered it returns every schema in the instance — the reason
`/api/admin/usage` is admin-only. Filtering in the service would have kept it
off the wire; the argument for pushing it into the query is that we then never
hold it. The recording fake asserts *which* schemas were asked for, so the
filter cannot be quietly dropped later.

**Three roles survive `verify-isolation.sh` on purpose.** It tears down at the
*start* of a run, not the end, so `u_k3a_muster_lena`, `u_k3a_meier_tim` and
`t_schaffner` are still there when it finishes. On a throwaway cluster that is
just idempotence; on a real one it means §7's "check for leftover `^[ut]_`
roles" will always find these three, and they are not the §4u kind of leak.
Worth knowing before someone reads them as a failure.

### From the first deploy — read before running a live suite anywhere real

**(w) Two things the deploy needs that §6 does not mention.**

`db/verify-auth.sh` **requires `node`** — its `json()` helper shells out to it to
parse responses. §6 presents it as a plain shell script, and on a server with no
node it does not fail: every extracted username comes back empty and the run
collapses into a cascade of confusing 400s about `"username" must be at least 1
characters`. Worse, it aborts *before* its teardown at the end of the file (the
only `trap` covers the cookie directory, not the accounts), so a failed run
leaves provisioned teachers behind. Run it from a container that has node —
`--network host` plus `--add-host` reaches the reverse proxy on port 80 with
the right `Host` header, with the repo mounted.

And `docker compose` needs the **compose v2 plugin**, which §6 already records
was missing on the dev machine. Check it before anything else.

**(v) The compose file forbade what the app instructs.** On first boot the app
logs "Log in, change the password, then blank `DBK_BOOTSTRAP_ADMIN_PASSWORD` in
.env" — and `docker-compose.yml` interpolated that variable with `:?`, which
fails on **empty as well as unset**. So doing what you are told made the next
`docker compose up` refuse to start, which in practice is the reboot weeks
later, with an error naming the variable you were told to blank. Now `:-`.
Nothing is lost: `bootstrap.ts` returns early once an admin exists, and still
throws when there is no admin *and* no password — the only case where empty is
genuinely dangerous. The lesson generalises: a required-variable guard in
compose duplicates a check the app already makes better, and the two can drift
apart in a direction where compose is wrong.

**(u) `query.live.test.mjs` leaked a role on every run, silently, and the deploy
is what found it.** Its teardown built `created` as `[teacher, student]` and
dropped in that order. A teacher holding USAGE/SELECT on a student's schema
**cannot** be dropped — `2BP01`, "cannot be dropped because some objects depend
on it" — and those grants only go away with the student's schema. So the teacher
drop failed every time, the student drop succeeded, and a `.catch(() => {})` two
lines down meant nobody ever saw it. `import.live.test.mjs` and
`catalog.live.test.mjs` both order students first and say why in a comment; this
file simply had it backwards.

Invisible on the dev cluster, where a stray role looks like leftover manual
testing. Not invisible on the **production** teaching database, where the first
live run left `t_schaffner` behind — and:

- it is an orphan: a Postgres role with no `app_user` row, which §3 already
  names as the bad direction ("invisible and holds a name forever");
- `reconcile.ts` cannot remove it, because it is driven from `app_user` and a
  role nothing claims is not in its diff;
- identifiers are never re-issued (§3), so it had permanently taken the
  identifier the *real* teacher of that surname would be given.

Fixed by reversing the drop order, replacing the swallow with a logged error,
and — the part worth keeping — **asserting afterwards** that none of the created
roles still exist. A teardown that only intends to clean up is not good enough
for a suite that can be pointed at a real cluster. Clean it up by hand as
`postgres`, not `dbk_app`: NOINHERIT means `DROP OWNED BY` from the app role
fails with "permission denied to drop objects" (§4a, yet again).

### From quota enforcement — read before touching `services/quota.ts`

**(q) `DELETE` frees no disk, so it must not be the advice.** The first draft of
the refusal message said "DELETE, DROP TABLE and TRUNCATE all still work". They
do — but `DELETE` leaves the dead tuples in the heap until `VACUUM FULL`
rewrites it, so `pg_total_relation_size` does not move a byte. Caught by driving
it over HTTP, not by any test: deleting 39 900 of 40 000 rows left the schema at
exactly the 4.0 MB it started at, and the student was still refused. A student
following that sentence would have destroyed all their data and gained nothing.
The message now names `DROP TABLE` and `TRUNCATE`, and says why `DELETE` will
not do. `query.live.test.mjs` pins the underlying fact so the sentence cannot
drift back.

`DELETE` and `VACUUM` are still *allowed* while over quota — they are steps on
the way out. Allowed and recommended are different things.

**(r) The quota nearly measured every student as zero.** Same NOINHERIT trap as
§4a and §4o, third disguise: this runs on the admin handle, as `dbk_app`, about
a *student's* schema. `information_schema` answers for `current_user`, so it
would have reported 0 bytes for everybody and the quota would simply never have
fired — a safety rail that is present, tested, green, and doing nothing.
`pg_namespace`/`pg_class`/`pg_total_relation_size()` are world-readable and
answer truthfully. The live test asserts `bytes > 0` *before* it asserts the
refusal, because a refusal alone would have passed on a zero reading.

**(s) A refusal must not reach `query_log`.** The check throws before the
runner opens a connection, so nothing is recorded. That is deliberate: phase 4's
lesson view reads `query_log`, and a row saying a student ran `CREATE TABLE`
when they were refused would be a lie in the one place a teacher trusts. Pinned
in both live suites by asserting the log count is unchanged.

**(t) The classifier is a deny-list, and that is the right way round here.**
`db/ident.ts` is an allow-list because a name that slips through becomes
privileged SQL. `mayGrow()` is the opposite, because a keyword that slips
through costs exactly one unmeasured write — after which the schema is bigger,
the next check sees it, and the student is refused anyway. The control
self-corrects. An allow-list would instead refuse every statement nobody thought
of, and the student who is *already over quota* is the one person who cannot
afford a false refusal.

### From CSV upload — read before touching the importer or the result grid

**(l) The result grid was showing every date one day early, and had been all
along.** node-postgres parses a `date` into a JS `Date` at **local** midnight;
`sql.js` serialises a non-scalar cell with `JSON.stringify`, so `2025-04-03`
reached the student as `2025-04-02T22:00:00.000Z` — Zurich is UTC+2 in April.
Pre-existing, invisible until CSV upload made date columns ordinary, and
precisely the silent wrongness the whole coercion layer exists to prevent,
reintroduced at the last step.

`services/query.ts` now passes a per-query `types` parser that hands `date`,
`timestamp`, `timestamptz`, `time` and `timetz` over as the text Postgres sent.
Scoped to that one query, **not** `pg.types.setTypeParser` — the global would
also change every `created_at` the meta database returns and with it the shape
of half the API. Two cases in `query.live.test.mjs` pin it, and they only fail
under a non-UTC `TZ`.

**(m) Postgres will read `03.04.2025` as 4 March and not tell you.** The default
`DateStyle` is `ISO, MDY`. Handing a Swiss date straight to a `date` column does
not error — it stores the wrong day, in a file where every other row looks
fine. `services/csv.ts` normalises to ISO before anything is sent, which is the
reason that file exists at all rather than being three lines of `client.query`.
Slash dates (`03/04/2025`) are deliberately left as `text`: genuinely ambiguous,
and nothing in the file resolves it.

**(n) `file.text()` silently destroys a German Excel export.** It assumes UTF-8
and substitutes U+FFFD, so every `ä` becomes `�` and the original bytes are gone
before anyone notices. Excel on Windows still writes Windows-1252 by default —
the commonest file this app will ever be handed. `csv-import.js` decodes with
`new TextDecoder('utf-8', { fatal: true })` and falls back to `windows-1252`
when it throws; valid UTF-8 is a strong enough signal that the guess is safe.
Verified with a real Latin-1 file, not a synthesised one.

**(o) `information_schema` answers for `current_user`, so `dbk_app` cannot see a
student's columns.** The same NOINHERIT trap as §4a, in a new place: an
assertion about a freshly imported table's types came back as an empty array
from the admin pool, which reads as "the import created no columns" rather than
"you are not allowed to look". Live assertions about a student's objects must be
made **as that student** (or from `pg_catalog`, which is world-readable).

**(p) Inference must be conservative where a wrong guess is unrecoverable.** A
column of `0`/`1` is inferred as `integer`, never `boolean`, even though
`coerce` accepts both once the student has *chosen* boolean. Guessing "boolean"
on an id column destroys the data and needs a re-import; guessing "integer" on a
flag costs one dropdown. `INFERENCE_REJECTS` in `services/csv.ts` is the only
place the two directions diverge, deliberately.

### From phase 3's UI — read before touching the page or the live suites

**(f) A multi-statement script is ONE transaction, so a failure undoes all of
it.** §8 of the previous handoff assumed the opposite — "a script whose third
statement failed (the first two committed)" — and that assumption is wrong.
Postgres wraps a simple-protocol query string in an implicit transaction, so
`CREATE TABLE …; INSERT …; SELECT 1/0;` leaves **no table**. Verified live, with
a runtime error rather than a parse error, so it is not merely "nothing ran":
statements 1 and 2 execute and are then rolled back. An explicit `COMMIT;`
mid-script *does* break out and keeps everything before it.

This was the open UI question, and it answers itself: the page says so in words
(`MULTI_STATEMENT_ROLLBACK` in `web/assets/sql.js`) whenever a script of more
than one statement fails. Anything else would have students hunting for rows
that were never there.

**(g) A command tag does not tell you what a statement did.**
`CREATE TABLE zahlen AS SELECT …` reports its tag as **SELECT**, so the obvious
"skip the schema-browser refresh for read-only commands" filter leaves the
student staring at "no tables yet" immediately after making one. Caught in the
browser, not by any test. The page now reloads the catalog after *every*
execution — including failed ones, because of the explicit-`COMMIT` case in (f).

**(h) The live suites cannot provision concurrently.** `node --test test/*.test.mjs`
runs the files in parallel processes, and `ensureRole` ends with
`GRANT CONNECT ON DATABASE datebaenkli TO <role>` — which updates the single
`pg_database` row, so two provisioners in flight get **XX000 "tuple concurrently
updated"** followed by a cascade of "relation does not exist" from tests whose
setup half-ran. It was survivable with two suites and became a hard failure with
three. `test/support/live-lock.mjs` is a Postgres advisory lock every live suite
takes for its duration; a session-level lock is released when the connection
drops, so a crashed suite cannot wedge the next one. `--test-concurrency=1`
would have fixed it too, at the cost of serialising the unit tests as well.

**(k) A page whose script is behind the auth gate cannot redirect to the login
form.** `/sql` is the first page with an *external* module (`/assets/sql.js`)
rather than an inline `<script>`, and the asset tree was first registered
closed-by-default — which felt like the safe choice and was the wrong one. The
HTML shell is public and rendered fine; the script answered 401, never ran, and
so the `location.href = '/login'` inside it never fired. A student with an
expired session got a permanently dead page: header, empty editor, "wird
geladen …", forever. Worse for a student mid-password-change, where `/api/me`
is `passwordChangeExempt` but the asset was not, so it answered 403.

`/assets` is now served by an explicit route carrying `config: { public: true }`
(`@fastify/static` with `serve: false`, so the route options are ours), for the
same reason routes/pages.ts gives for the pages themselves: these files are
program text, not data, and every action they offer goes through an `/api`
route that enforces the real rules. **Closed-by-default is right for data and
wrong for the code that decides what to render.** Verified: logged out, `/sql`
now lands on the login form; `/assets/../server.js` is still 404/403.

**(j) A live test that names a table must say which schema.**
`provision.live.test.mjs` asserted that an unqualified `CREATE TABLE kunden`
landed in the student's own schema via
`SELECT schemaname FROM pg_tables WHERE tablename = 'kunden'` — unscoped, so any
*other* `kunden` in the instance sorts in and answers for it. A leftover account
from manual browser testing was enough to fail it. `kunden` is the likeliest
table name in the whole instance, because the demo schema teaches that
vocabulary. Now scoped to the suite's own `u_lvt_` prefix. Worth remembering
when writing the next live assertion: the throwaway cluster accumulates state
across a session.

**(i) An empty schema must still be listed.** The catalog query was first
written driven from `pg_class`, so a schema holding nothing produced no rows and
vanished. For a teacher that made "this student has no tables yet" and "I have
lost my grant on this student" the same picture — nothing. It is now driven from
`pg_namespace` with the relations left-joined on. `catalog.live.test.mjs` pins
it, and the teacher's grant surviving a student's *self*-reset was confirmed
separately against `has_schema_privilege`.

### From phase 3 — read before touching the runner or cancellation

**(a) `dbk_app` cannot cancel a student's backend the obvious way.**
`pg_cancel_backend` and `pg_terminate_backend` check `has_privs_of_role()`,
which respects `INHERIT` — and provisioning grants student roles to `dbk_app`
`WITH INHERIT FALSE`. A plain `SELECT pg_cancel_backend($1)` from the admin pool
fails with **42501, "permission denied to cancel query"**. Confirmed live before
any of the runner was written.

This is the same NOINHERIT trap as phase 2's "the teacher's grant must be issued
*by the student*", and it is worse here, because nothing in a PGlite test can
see it: the watchdog would have shipped, looked correct, recorded the right SQL
in every mock, and never once stopped a query.

The fix is to step into the role first. `watchdog.ts` uses
**`set_config('role', $1, true)`** rather than `SET ROLE`, for two reasons: it
takes a bind parameter, so the watchdog does not have to join `provision.ts` as
a file that concatenates SQL; and the third argument makes it `SET LOCAL`, so
the admin connection unwinds back to `dbk_app` at COMMIT instead of going back
to the pool wearing a student's identity. That is why the signal runs inside a
transaction it does not otherwise need.

Free benefit worth keeping: once we are the student, Postgres itself refuses to
signal a backend that is not theirs, so a recycled pid cannot take out someone
else's query.

**(b) Cancel, then escalate — and the escalation needs a `done` flag, not just
`clearTimeout`.** `pg_cancel_backend` is a request a backend can miss, so the
watchdog terminates after a grace period. But the cancel is usually *what ends
the query*, so the runner disarms while the cancel round trip is still in
flight — before the escalation timer exists. Arming it afterwards leaves a timer
nothing holds a handle to, which fires later and terminates whatever that pid
has become: in a pool, the student's **next** query. Caught by the live suite as
a stray "Connection terminated unexpectedly" on an idle connection. Both guards
in `fire()` are load-bearing; `test/watchdog.test.mjs` pins the behaviour.

**(c) The row cap has to be applied while rows arrive, not afterwards.**
`SELECT * FROM generate_series(1, 1e9)` puts every row in the Node heap before
the result object exists — the process dies, and with it everyone's lesson, long
before any timeout fires. The runner attaches a `row` listener, which makes
node-postgres stop accumulating (`_accumulateRows` in `pg/lib/query.js`) and
hand rows over one at a time. The statement still runs to completion on purpose:
Postgres reports the true count in the CommandComplete tag, which is what turns
a clipped grid into an honest "showing the first 1000 of 4812".

**(d) A pooled connection must be rolled back before release.** A cancelled
statement inside a transaction leaves the session in `25P02`, and a bare
`BEGIN;` leaves it idle in one; either would be inherited by the next request on
that connection. This does mean a transaction cannot span two executions — but
that never really worked, since a pool hands out whichever connection is free.
Consistently not working beats intermittently working.

**(e) `rowCount` is rows *affected* for a statement with no result set**, so
`truncated` must mean "we hit the cap", not "those two numbers differ".
Otherwise every `INSERT` reports itself as a clipped grid. Found over HTTP,
after the unit tests were green.

### From phase 2 — still current

**(a) A student can share their own schema, and only the reconciler stops it.**
They *own* it, so `GRANT USAGE ON SCHEMA u_me TO u_other` is theirs to issue and
Postgres cannot forbid it without taking ownership away. `reconcile.ts` compares
the USAGE grants on every student schema against the roster and revokes anything
that is not one of that student's teachers (`reason: "peer_student"`, logged to
`audit_log`). So architecture §8b's "strict isolation, always" is **restored
periodically, not prevented**. Two students who agree can see each other's work
until the next pass; nobody can reach a student who did not agree. Verified live.

**(b) Three corrections to ARCHITECTURE.md §2, now in the document:**

1. **A reset destroys the teacher's grants.** `DROP SCHEMA` takes USAGE *and*
   the default privileges with it. Recreating the schema without re-granting
   would have cost a teacher sight of a class one reset at a time, silently.
2. **A late grant needs `GRANT SELECT ON ALL TABLES`.** §2's sequence grants on
   an empty schema, so it never needed it. Every other grant — class handover,
   second subject, reconciler repair — lands on a full one, and
   `ALTER DEFAULT PRIVILEGES` only covers what comes next.
3. **`pg_dump` needs `--role=<student>`.** `dbk_app` has NOINHERIT membership and
   therefore SELECT on nothing, so a plain dump writes an **empty archive and
   exits 0**. Connecting as the student is not an option — the account is set
   NOLOGIN before it is dumped.

**(c) A revoke must not overreach.** A student taking two subjects from the same
teacher keeps the grant when one of them ends. `studentsLosingTeacher` in
`classes.ts` is that predicate; both directions are covered by tests.

**Still true from phase 1:**

- **`statement_timeout` is not a security boundary.** It is `USERSET`: a student
  can `SET statement_timeout = 0` *and* persist `ALTER ROLE <self> SET
  statement_timeout = '1h'`. Confirmed against a real server; Postgres offers no
  way to prevent it. **The app-side watchdog this called for is now built**
  (`services/watchdog.ts`, and 4a above for the trap it hides). The role default
  stays as the cheap path for the ordinary accident: it fires at 15s, the
  watchdog at 20s, and `config.ts` refuses to boot if that order is inverted.
  Hard limits that *do* hold: `CONNECTION LIMIT 4`, cluster-wide
  `temp_file_limit=256MB`, and every schema/database privilege.
- ~~Collation is still undecided~~ — **decided and live**: ICU `de-CH` on both
  databases, on the dev machine and on the server (architecture §10 (10), §4x,
  §5). Left here because the phase-2 note it replaces was right about the
  deadline: a byte-order default is only fixable while no class has work.
- **`hashtext()` is stable within a Postgres major, not across.** Do not hardcode
  expected demo rows in exercises.

### pp. Phase 7 — four things the Chalk pass turned up

**The first is the one to read**, because it is a class of bug rather than a bug.

- **Two owners for one attribute, and only one mode shows it.** The theme
  toggle's `aria-label` was set by *both* `wireThemeToggle()` (which knows which
  way the button currently points) and a `data-i18n-attr` on the markup (which
  names one constant key). `apply()` runs after the wiring on every page, so it
  won. Result: a reader in **dark** mode got the `light_mode` icon beside the
  label "Auf dunkles Design wechseln" — the icon and the label saying opposite
  things. In light mode the two agree by coincidence, which is why clicking
  around never finds it. Caught by asserting the two against each other in a
  browser (`icon === 'light_mode'` iff the label says *hell*), not by looking.
  `wireThemeToggle` now owns the attribute alone and returns its `paint` so the
  page can re-run it once the locale settles. **The general lesson: when a
  translated attribute also depends on state, `data-i18n-attr` cannot express
  it, and having both is worse than having neither.**

- **`.row` and `.cols` are booby traps in a shared stylesheet.** `lesson.js` and
  `roster.js` put `class="row"` on a `<tr>`; a `.row { display: flex }` utility
  of the kind every CSS file grows would silently destroy every table on two
  pages. `.cols` is worse — it means three different things: a flex split in
  `lesson.js`, the column list under a table in `sql.js`'s schema browser, and a
  `<table>` in the CSV import dialog. Both are now either renamed (`.hstack`) or
  page-scoped, with the reason in `app.css`. **Before adding a utility class to
  that file, grep the four page scripts for the name.**

- **ARCHITECTURE §8's hue ring was wrong, and the inventory is gone.** §8 listed
  which accent sat at which hue, written from memory. Checked against the
  stylesheets that actually serve them: one accent was 5° off, and another had
  no accent at all — it re-points the `:root` alias at an existing one and
  introduces no hue, so the number recorded for it had never existed. Two
  entries checkable, two wrong. The table was removed rather than corrected,
  because nothing makes a table like that fail loudly when it drifts. The method
  that settled it is the rule worth keeping: **read the deployed app's own CSS,
  not the design doc.**

- **Google Fonts rejects an unsorted `icon_names` list with an HTML error page,
  not an error status.** `200 text/html`, so a naive fetch is "successful" and
  the parse simply finds no `@font-face` rules — which would have shipped no icon
  font at all while the script printed success. `vendor-fonts.mjs` now asserts the
  list is sorted *before* the request and throws if a stylesheet yields zero
  rules. The subset itself is worth having: **5 KB against 361 KB**, and an icon
  outside the list renders as its own name in words, so the failure is loud.

### qq. Phase 7.1 — three fixes from the first real lesson on the deployed build

All three were reported by the author after using the deployed instance. The
first was a phase 7 regression; the other two were pre-existing.

- **The autocomplete popup was white-on-white in dark mode.** `editor.entry.js`
  sets the editor to `color: inherit` so its text follows the page, but
  CodeMirror themes its *floating* UI separately and keeps a white background
  there. Before phase 7 the pages carried `color-scheme: light dark` and
  CodeMirror's default theme matched them; once `data-theme` drove the palette,
  the popup inherited a near-white `--ink` onto its own white background.
  Measured at **1:1**, now **13.2:1**. The rule to carry forward is in
  `editor.entry.js`'s header: **inheriting is only safe for things inside the
  editor** — anything that floats needs an explicit background.

- **Fixing it exposed a specificity trap worth knowing.** CodeMirror's rule is
  `.ͼ1 .cm-tooltip.cm-tooltip-autocomplete > ul` — three classes, one of them a
  scope class it generates — so a selector naming only `.cm-tooltip-autocomplete`
  loses. It loses *silently and partially*: `font-size` applied (CodeMirror sets
  none) while `font-family` did not, so the rule looked live. **Check the
  computed value, not whether the selector matches.**

- **The schema browser invited students to run a statement Postgres refuses.**
  `sql.no_tables` — "Leg mit CREATE TABLE eine an" — was shown for *every* empty
  schema, including `public`, where `00-bootstrap.sh` revokes CREATE from PUBLIC
  and hands ownership to `dbk_app`. Now gated on `schema.own`, with
  `sql.no_tables_readonly` for the rest. Note the rule is **ownership, not
  role**: a teacher cannot create in `public` either, so "show it only to
  teachers" would have been wrong in the same way.

- **A footer, and with it the first thing that says what is running.**
  `tools/stamp-build.mjs` writes `dist/build-info.json` during `postbuild`;
  `config.build` pairs it with `package.json`'s version; `GET /api/version`
  serves both and is **public**, because `login.html` is the one page with no
  session and the one a confused reader is most likely to be looking at.
  `builtAt` is null under `npm run dev`, which is a fact rather than a failure.

  The version is bumped by hand (§7's runbook now says so) and the build time is
  not. That pairing is the point: `package.json` sat at `0.1.0` through seven
  phases, so a semver alone would have named the wrong release with nothing to
  contradict it.

**One thing found while verifying and deliberately NOT changed** — see §8.

### ss. The image build context is not the repo — and `npm run build` hides it

**Phase 7.1 broke the first deploy that used it**, and the failure is worth
keeping because the class of it will recur.

`postbuild` gained `node tools/stamp-build.mjs`. `app/Dockerfile` copies
`package.json`, `tsconfig.json` and `src` — and nothing else. So the image build
died with `Cannot find module '/build/tools/stamp-build.mjs'` at
`RUN npm run build`, having passed every local check, because on the dev machine
that same script runs in a working tree that *has* the directory.

Fixed by `COPY tools ./tools`. Two things to carry forward:

- **`npm run build` says nothing about the image**, because it runs in a working
  tree that has everything. The image gets only what `COPY` names.

  **Docker on the dev machine works.** Daemon active, client 29.6.2, compose
  5.3.1, measured. What does not work is Docker *from an agent's shell*: the
  socket is `root:docker` and `pip` is not in the `docker` group, so it needs
  `sudo`, and an agent has none — the failure reads `permission denied while
  trying to connect to the docker API`. **An earlier version of this note said
  "Docker here is unusable", and that was simply wrong**; it was repeated from a
  session brief instead of being checked, and it is what let this bug reach a
  deploy. Do not re-derive that claim from a one-line permission error.

  Two checks, and the first is the real one:

  1. **`sudo docker compose build datebaenkli-app` on the dev machine, before
     deploying.** It is the only thing that actually exercises the build
     context, and it would have caught this in seconds.
  2. **Reproduce the context by hand** — copy only the files the Dockerfile
     copies into a scratch directory, symlink `node_modules`, run
     `npm run build`. No Docker, no sudo, so an agent can run it unattended; it
     reproduced this exact failure and then the fix in about ten seconds. Good
     while iterating, not a substitute for (1).

  **Do one of the two whenever `postbuild` or the Dockerfile changes** — and if
  you are an agent, ask for (1) rather than assuming (2) was enough.

- **Anything a build step reads must be `COPY`ed, and the list is short on
  purpose.** The context deliberately excludes `.git`, `test`, `docs` and
  `tools` was simply never needed before. If a future step reaches for a file,
  check that line first — the failure is loud, but it is loud *on the server*,
  in the middle of a deploy.

The stamp step is deliberately still fatal rather than tolerant: a build with no
`build-info.json` would serve a footer that quietly lies about what is running,
and stopping the image build is the better of those two.

### rr. An account whose key is gone cannot be deleted

Found by accident on the dev cluster, but it describes a real operational edge.

Deleting a student dumps their schema before dropping it, and `pg_dump --role`
needs the student's *decrypted* role password. If `DBK_ENCRYPTION_KEY` has
changed since the account was provisioned, that decryption throws
`Unsupported state or unable to authenticate data` and the deletion fails with a
`500` — so the account is stranded: active, unusable, and unremovable through
the app.

On the dev cluster this is self-inflicted (§6's start command generates a fresh
key every run). In production it would mean the key had been rotated or lost,
and the recovery is the same one used here: drop the schema and role in the
teach database and the row in the meta database, by hand, as `postgres`.
**Which is worth knowing before rotating that key rather than after** — the
correct order is to re-encrypt every stored role password, not to restart with a
new key and discover this account by account.

### tt. Phase 7.2, and a role leak found beside it

Three things, and the third is the one to read.

**The quota line (§8 item 6).** `/api/workspace` now answers
`quota: { bytes, quotaBytes, overQuota }` beside the tree, and `sql.js` renders
`12.4 MB von 50.0 MB belegt` under the schema browser. Two decisions worth not
re-litigating, both argued at the site in `routes/workspace.ts`:

- **The join is in the route, not in `catalog.read`.** The two halves run as
  different roles on purpose — the catalog *as the student*, because
  `has_*_privilege` answering for `current_user` is the isolation boundary; the
  quota as `dbk_app` against `pg_class`, because asking as the student reports
  zero bytes (§4o, §4q). And `routes/lesson.ts` calls the same reader for the
  teacher's drill-down, which already renders this number from
  `services/lesson.ts` — putting it in the reader would measure it twice and
  give one screen two sources for one figure.
- **A failed measurement answers `quota: null` and the tree still renders.** The
  pane's reason to exist is the tree. `renderQuota(null)` hides the line rather
  than printing a dash.

`mb()` and `ticked()` moved into `web/assets/util.js`. Not because they are used
twice — because the second copy can be wrong without anyone seeing it. `mb` in
particular: the argument for showing the student this number at all is that it
is the *same* number their teacher reads, and two `toFixed` calls in two files
is how that stops being true.

**Contrast, measured rather than assumed.** The resting line was written with
`--faint`, the token the rest of that pane uses, and rasterising it said 2.75
(light) / 3.03 (dark) against AA's 4.5. Moved to `--muted` — 4.83 / 5.35. The
`.bad` over-quota state was already fine at 5.20 / 7.62. The distinction that
justifies differing from the neighbours: `.est` and the `TABELLEN` heading
annotate something the reader is already looking at, whereas this line *is* the
information. Note this is not the white-on-accent question in §8 — that one is
a family-wide decision and is still untouched.

**The hint layer on the CSV pane (§8 item 0)** was three lines, as advertised,
plus one new SQLSTATE that turned out to be the point. `2BP01` — a drop blocked
by a dependent object — is the *characteristic* failure of that pane rather
than the editor's: "replace existing table" issues `DROP TABLE` without
`CASCADE` on purpose, so a view the student built on last week's table stops the
re-import. Without a handler the new hint layer would almost never have fired
there. It also matters more in that dialog than anywhere else, because the
dialog renders the message and the SQLSTATE and **not** `error.detail` — so the
hint is the only place the student is told *which* view is in the way.

Its strings are the one set in `hints.test.mjs` that did not come off a deployed
server: they were taken from PGlite (PostgreSQL **18.3**) with a real
`CREATE VIEW` and a real `DROP TABLE`, because no cluster existed on the machine
at the time. That is still Postgres's own error machinery, not a composed
string, but production runs 17 — believe the server over the file if it ever
disagrees. It was afterwards driven end to end through the real dialog against
18.4 and produced exactly those shapes.

**And the thing that was not part of the task: `db/verify-isolation.sh` leaked
two login roles on every single run.**

Its teardown ran only at the **top** of the script — clean on entry, not on
exit. That made a re-run tidy, which is precisely what hid it: on a throwaway
cluster the next run cleans up, and the script's own header says to point it at
the live server *once*. A single run there leaves `u_k3a_muster_lena` and
`t_schaffner` behind permanently. They are `LOGIN` roles whose passwords the
script sets to `'pw_' || rolname` — a deterministic value in a public repo — and
they occupy two identifiers that a real class could want. The same mechanism as
§4u, which is where this project already burned a name.

The header even claimed it "creates and destroys three throwaway roles". It
destroyed one.

Fixed by hoisting the teardown into a function and calling it at both ends, with
an assertion against `pg_roles` after the second call — the rule `dropRoles` in
`test/support/live-pg.mjs` already states and that CLAUDE.md calls not optional.
A teardown whose failure is swallowed is indistinguishable from one that worked,
which is how §4ii went unnoticed for months. 28 checks became 29.

**Asked of the server on 2026-07-30, and the answer inverted the finding.**
Production holds `t_schaffner` and *not* `u_k3a_muster_lena`, and the author
confirmed it: **`t_schaffner` is their own teacher account, made by hand.** So
the script never leaked into production. The leak was real but only ever hit
throwaway clusters.

**What that uncovered instead is worse than the leak was.** This script drops
every name it uses, and its teardown is `DROP OWNED BY CURRENT_USER CASCADE`
followed by `DROP ROLE`. Its header said "run it after any change to
provisioning, **and once against the live server**". Doing that would have
deleted the author's teacher account and every object in their schema — not as
an edge case, as the script's normal first action.

The collision is structural rather than unlucky. `db/ident.ts`'s `ROLE_NAME` is
`^[ut]_[a-z0-9_]{1,61}$`, so *every* name the app can generate begins `u_` or
`t_` — and so do three of the four fixtures. `t_schaffner` is precisely what
`/roster` names a teacher for an author called Schaffner. This is §4cc pointed
at a shell script instead of a live suite, and it had a live target.

**Fixed three ways**, in the order they matter:

1. **The "and once against the live server" sentence is gone**, because it was
   an instruction to destroy data.
2. **A guard runs before anything is created**: it asks `app_user` in the meta
   database whether any fixture name is a real account and refuses if one is.
   It **fails closed** — an unreachable meta database aborts rather than
   proceeding — because what it prevents is unrecoverable and the cost of a
   false alarm is re-running with the right coordinates.
3. **`deleted` is the only state it ignores**, and that exclusion is
   load-bearing in both directions. Deletion deprovisions, so the name really is
   free and blocking on the tombstone would make the script unrunnable on any
   cluster that had ever hosted such an account — which is what the dev cluster
   looked like the moment 7.2 cleaned up its own fixtures, and is how this
   distinction got found. `archived` and `cold` both **keep the role**; for
   `cold` the role *is* the account, its schema already being in an archive, so
   dropping it would strand a term's work with nothing to restore against.

Verified by flipping a tombstone to `archived` and to `active` and watching it
refuse (naming the state), by pointing `DBK_META_DB` at a database that does not
exist and watching it refuse, and by confirming `pg_roles` held nothing
afterwards in every aborted case. Both refusals exit `1`.

The fixture names themselves are *not* renamed. They are shared with the whole
live suite (`u_k3a_muster_lena` appears in six test files) and renaming them
there is a fifteen-file change with its own risk; the guard makes the dangerous
run impossible, which is the property that was actually missing. Renaming
remains available if anyone wants belt and braces — see §8.

### uu. Phase 7.3: cold storage and deletion get buttons

§8 items 2 and 5, taken together because they are one problem — and the problem
was never the CSS. Every route already existed and was tested; `PATCH
/api/students/:id/state` has accepted `cold` and `deleted` since 5b. This is
entirely `roster.js`, the two catalogues and twenty lines of stylesheet.

**The two actions are confirmed at deliberately different weights**, and that
asymmetry is the design rather than an inconsistency:

- **Cold gets one confirm**, because it is reversible: "Aktivieren" restores the
  dump, and that button has always been there — `roster.js` renders any
  non-active state with it. Driven end to end here: the schema was dropped, the
  role kept `NOLOGIN`, a dump appeared in the archive, and "Aktivieren" brought
  the schema and the login back.
- **Deletion gets two**, saying *different* things. The first names the person
  and asks; the second names person *and username*, states what is destroyed and
  what survives, and asks again. Two identical dialogs would be one dialog and
  an extra click — the click is not the safeguard, reading is.

  The author chose the two-step over a type-the-username gate. The concern with
  it, recorded because it is the thing to watch: two OK presses is the pattern
  people click through fastest, and neither step can catch *wrong student*. The
  mitigation available inside that choice is that both dialogs name the student
  and the second adds the username, because the button one row up is "Aus
  Klasse" and the two failures — wrong button, wrong row — are equally likely.

**The copy must not overclaim, in either direction.** Deletion dumps first and
skips the drop if the dump fails, so the work is *not* gone from the server — but
nothing in this app can bring the account back, since only `cold -> active` has
a restore path. The strings say exactly that: the data survives, the account does
not. And when `provisioning.ok` is false, the page says so rather than staying
quiet: the row has vanished from the roster while the schema is still on disk,
and a teacher who is not told would believe the disk was freed.

**Cold is admin-only and the button is not rendered for a teacher.** Not
disabled — absent. `routes/students.ts` does not list the state in a teacher's
`oneOf`, so from where they stand it does not exist, and a rendered button would
be one that returns 400.

Three things this turned up that were not on the list:

- **The state column printed the raw enum.** `archived` and `cold` reached a
  German page as English words. It went unnoticed because `archived` was the
  only non-active state a teacher could get to; adding `cold` would have put a
  second one on screen. Now mapped through `common.*`, with `cold` rendered
  **"ausgelagert"** rather than a translation of the temperature metaphor, which
  is internal vocabulary.
- **The roster has always scrolled the whole page sideways on a phone.** At
  375 px the document was 714 px wide *before* this change and 852 px after —
  Chalk §8's rule is that wide content scrolls in its own container and the body
  never does. Fixed for all three tables by giving the containers `overflow-x`,
  which is on the container because a `<table>` cannot be its own scroll port.
  Widening it is what made anyone measure.
- **A 0 px gap between two buttons.** Interpolating the conditional cold button
  directly onto `</button>` ate the whitespace text node that draws the 3 px gap
  between inline-blocks, so "Archivieren" and "Auslagern" touched and read as
  one control. Measured, not seen — at that scale a screenshot looks fine.

**§8 item 5's second half was already done.** `error.too_many_queries` in both
catalogues had been reworded — with a comment citing §4dd — so the student never
saw the guess stated as fact. What was left was the *developer*-facing
`ServiceError` message in three services, which still said "Your previous query
is still running" to the log, to `curl` and to any client without a catalogue.
Now hedged to match. The §8 bullet was simply stale, which is worth knowing
before trusting another one of them.

### vv. Phase 7.4 — the menu's leftovers, and a deploy that did not happen

Five small items from §8, plus the finding that mattered more than any of them.

**THE DEPLOY OF 7.2 AND 8 DID NOT TAKE — and the cause is confirmed:
`docker compose up` was run with no `build` first**, so compose started the
image it already had. Re-run with a build, it went out fine and production now
answers `0.8.0`. The evidence that caught it took thirty seconds:

```
GET /api/version → {"version":"0.7.0","builtAt":"2026-07-28T23:10:54Z"}
```

That `builtAt` is byte-identical to the 7.1 deploy from the previous day, and
two public assets confirm it independently — the served `app.css` contains no
`#quota` rule (7.2) and the served `roster.js` no `data-delete` (phase 7.3), while
the local copies have four and two. This is exactly the `up -d`
reports-`Running`-and-changes-nothing trap §7 warns about, caught by exactly the
check §5 exists for. **A deploy is not confirmed by the commands exiting 0.**

**The version had been stuck, which is half of why this was invisible.**
ARCHITECTURE §10 (14) says `package.json`'s version is bumped by hand per phase,
and 7.2 and 8 both shipped without it — so `/api/version` would have answered
`0.7.0` even on a *successful* deploy, leaving `builtAt` as the only signal.
Bumped to **0.8.0** here (and `package-lock.json`, which had drifted to `0.1.0`
independently). The next deploy is self-verifying on both fields.

**Item 4 — the boot reconcile now runs after `app.listen`.** It could shell out
to `pg_restore` at up to `DBK_DUMP_TIMEOUT_MS` (300 s) per account,
sequentially, *before* binding the port: three accounts needing a restore is
fifteen minutes of a container failing its health check, being killed, and
starting over restoring the same three. Phase 7.3 is what made this worth fixing
rather than noting — cold storage has a button now, so reaching the state that
needs a restore no longer takes `curl`.

Demonstrated rather than asserted: three students' roles were dropped behind the
app's back, and on the next boot `/health` answered **0.33 s** after start while
reconcile settled at 0.34 s, having re-provisioned all three. The margin is
small because re-provisioning is fast; the guarantee is structural, and
reproducing the fifteen-minute case was not necessary to prove an ordering.

What this newly allows is a request landing mid-reconcile, which was impossible
before. `server.ts` argues at the site why that is acceptable: both sides do DDL
as `dbk_app`, Postgres serialises DDL on the same objects, provisioning is
idempotent (a pinned property in `provision.live.test.mjs`), and the pass is
non-fatal and runs again next boot. Worst case is a logged error and a repair
deferred by one restart — against a crash loop as the alternative.

**Item 1 — the sweep has now been observed firing.** Armed two minutes out with
`DBK_ARCHIVE_SWEEP_HOUR`/`_MINUTE` on the throwaway cluster, threshold dropped to
30 days, two students backdated 400 days and a third left as a control:

```
17:22:45 archive sweep armed for 17:24 Europe/Zurich, threshold 30 days
17:24:00 archive sweep: 2 students idle past 30 days, 2 archived, 0 failed
```

74 ms after the armed minute. Both backdated students went `archived` with
`NOLOGIN`; the control kept `active` and its login. The wiring between
`setTimeout` and a real clock is no longer inferred.

**The re-arm is still not observed, and cannot be in under 24 h.** `arm()` is
re-entered from `.finally`, but the "armed" line sits *outside* it and logs once
at boot — so a nightly heartbeat does not exist. Left alone deliberately:
`lifecycle.ts` argues that a log line per uneventful sweep trains a reader to
skip the ones that matter, and adding one to answer a question nobody has asked
since would trade a documented decision for a smaller one.

**Item 3, first half — the log line no longer lies.** It said "03:40 local",
which a reader in Switzerland reads as Swiss time; the container sets no `TZ`,
so it is UTC (§4gg). Rather than pick a wording it now prints
`Intl.DateTimeFormat().resolvedOptions().timeZone`, so it says `03:40 UTC` in
the container and `03:40 Europe/Zurich` on the dev machine — true under any
setting, and it puts the answer to "what zone is this thing in" in the boot log
rather than in a findings section. **The `TZ` decision itself is untouched and
still the author's**; it no longer has a wrong log line riding on it.

**Item 7 — the fixture rename, in `verify-isolation.sh` only.** `vfy_lena`,
`vfy_tim`, `vfy_teacher`: outside `^[ut]_`, so collision with a real account is
now impossible by construction rather than caught by the guard. The guard stays
as a tripwire for whoever adds a fixture back inside the app's namespace, where
it should now never fire. `u_test` was dropped from the cleanup list entirely —
it sits in the app's namespace, and the one rule this script now has is that it
never drops a name `/roster` could have produced.

**The six live suites keep the realistic names, deliberately.** They were never
this script's exposure — nothing points them at production, `live-pg.mjs`
asserts their roles are gone afterwards, and names that look like a real class
are what make those tests readable. Renaming them would have been fourteen more
files of churn buying nothing.

**Item 3, second half — archive retention — was a decision, and the author took
it: anything older than six months may go.** `db/prune-archive.sh` implements
it. `DBK_BACKUP_KEEP` was offered as the precedent and it does *not* transfer,
which is why this is a second script rather than a flag on the first: a backup
is one of fourteen rolling snapshots, so dropping the oldest loses nothing,
whereas each archive dump is one file per person and may be the only copy of
their work.

**The rule is not "older than six months". It is "older than six months AND not
referenced by a live account", and the second half is load-bearing:**

- **A cold account's dump IS that account's data.** The schema has been dropped;
  `archive_path` points at the file and it is what `reconcile.ts` and
  `restoreStudent` read to bring the student back. A cold account can sit cold
  for well over six months — that is what cold storage is *for* — so age alone
  would silently delete live accounts and leave them unrestorable behind a
  button that still says "Aktivieren".
- **A deleted account's dump really is unreferenced** once the drop succeeded:
  `reconcile.ts` skips a deleted account whose role is already gone
  (`if (!inventory.roles.has(pgRole)) continue`), so nothing reads it again.
  That is the case the six months is about.

So the keep-list comes from the database rather than from the filenames, and a
file it names is kept **regardless of age**. If the meta database cannot be
reached the script deletes nothing and exits 1 — an unreadable keep-list and an
empty one look identical and mean opposite things.

Verified by backdating *every* dump in the archive to 400 days, including a real
cold-stored student's, then running it: 44 deleted, that one kept, and the
student restored afterwards through the app with her schema intact. Then a run
against a nonexistent meta database, which deleted nothing and exited 1.

Weekly in cron rather than nightly, and `--dry-run` exists, because a job that
deletes data should run rarely enough for a mistake to be noticed.

### ww. The accents are darker, and the reason is a number

**White on the accent measured 2.87:1 and failed WCAG AA. It is 4.50 now.** The
author chose to darken the accent rather than change the foreground, which keeps
Chalk §7's white-on-accent pattern intact — it is a token change, not a pattern
change, and nothing but the colour value moved.

**The first thing this turned up is that `--accent` is not one colour.** It is a
per-app alias: `[data-app="datebaenkli"]` points it at `--datebaenkli`, and
there are six solids in the file. They all sat at L 0.68–0.705, so **white
failed on every one of them** — this was never a Datebänkli problem, it was the
palette's. All six moved:

| accent | was | now | white before → after |
|---|---|---|---|
| terracotta 45° | 0.700 | **0.578** | 2.77 → 4.49 |
| sage 152° | 0.705 | **0.557** | 2.53 → 4.54 |
| plum 340° | 0.700 | **0.581** | 2.82 → 4.50 |
| slate 255° | 0.680 | **0.567** | 2.88 → 4.54 |
| teal 200° | 0.690 | **0.551** | 2.65 → 4.50 |
| violet 300° (this app) | 0.690 | **0.578** | 2.87 → 4.50 |

**Hue and chroma are untouched; only L moved, and the target L differs per hue**
because luminance at a fixed OKLCH lightness does not. Green carries the most,
so sage falls furthest (0.705 → 0.557); plum the least (0.700 → 0.581). Each
is the *lightest* value at which white still clears 4.5, so none is darker than
it has to be.

**A second failure was fixed by the same change, unnoticed until now.**
`--accent` is also used as *text* — `a:hover` — and on light paper it measured
2.5–2.8, failing AA in exactly the same way and for the same reason. It is now
4.4.

**And one thing got worse, which is why `a:hover` changed too.** The same
`--accent`-as-text on a *dark* background falls from ~5.9 to ~3.7. The accent
solid is deliberately identical in both modes, so as a text colour it can only
ever suit one of them — trading a light-mode failure for a dark-mode one is not
a fix. `a:hover` now underlines instead of recolouring, and the resting colour
stays `--accent-ink`, which does shift per mode and measures 7.0 light / 9.7
dark. The affordance is stronger than it was and legible in both.

**The focus ring was checked and did not need changing.** `input:focus` borders
with `--accent`; at 3.72 on dark paper it still clears the 3:1 that WCAG asks of
a non-text UI component, which is a different threshold from text and is why
this one survives where `a:hover` did not.

**Both copies of `chalk-tokens.css` were edited and are byte-identical**, which
`test/chalk.test.mjs` asserts. That test also **pins Datebänkli's exact accent,
and it caught this change** — which is the test working, not an obstacle. Its
comment now records that `0.578` is *derived*: it is the lightest this hue can
be with white on it, so raising it back is not a palette preference but a
re-break.

**Changing all six rather than only this app's was put to the author and
confirmed** — "all six is right". Doing one would have left this app's violet
darker than the rest of the ring, which reads as a mistake rather than a fix,
and the whole framing of this item was that whoever took it should take it once
for the whole system.

**This file is the ring's master, so any repo consuming it is now behind.**
Syncing `chalk-design-system/chalk-tokens.css` back out is the remaining work,
and until it happens those repos' primary buttons are still at 2.5–2.9.

---

### xx. A security review, and the one fix that did not work

A full security pass over the repo on 2026-07-30. The long version is a separate
report; what belongs here is what changed, what was measured, and the one thing
that is still open.

**Two remote denial-of-service holes, both reachable by any logged-in student,
both reproduced before and after.**

- `parseCsv` capped rows and not columns, then padded every row to the widest
  record — `width × rows` cells out of `width + rows` bytes. A **100 KB** upload
  produced 100 M cells: 8.2 s of blocked event loop and +801 MB of heap; 400 KB
  gave 35 s and 3.2 GB; the 10 MB cap allowed OOM at any heap size. Now
  195 ms / +3 MB and 466 ms / +7 MB. The clamp is inside `parseCsv` because
  every allocation is `width`-sized — a check *after* it returns has already
  paid for what it was meant to prevent. `totalColumns` carries the real width
  out so `import.ts` can still refuse with `csv_too_many_columns` rather than
  silently importing the first hundred columns.
- `mayGrow`'s block-comment strip was `/\/\*[\s\S]*?\*\//g`, which restarts at
  end-of-string for every unterminated `/*`. `"/*" + "/*x".repeat(33000)`, well
  inside `MAX_SQL_LENGTH`, cost **792 ms** of synchronous CPU on `POST
  /api/query` — before a pool connection is taken, so `statement_timeout`, the
  watchdog and `CONNECTION LIMIT` all miss it. Now a linear scan: 3 ms, flat,
  and it handles nesting correctly, which the regex admitted it did not.

**Slip passwords were 14.1 bits, not the ~22 both comments claimed.**
22 × 9 × 90 = 17 820. `ratelimit.ts` had sized the per-account budget by
reasoning from the wrong figure — the true answer was ~9 days to a targeted
account, and usernames are guessable by construction and readable out of
`pg_roles`. Now 64 words × 16 colours × 64 words × 9000 = **29.1 bits**,
`randomInt` instead of `% length`, shape `hafer-blau-tanne-4821`. A new test
counts the alphabet rather than matching the format, because a format regex is
exactly what passed for the whole life of the bug. **Existing slips are
unaffected** — they are scrypt hashes and keep working; only newly issued ones
are wider.

**A successful login no longer wipes the per-IP budget.** It could not have
worked: every student has a valid account, so one login of your own after every
199 failures reset it forever. `ipLimiter` still clears (that is what keeps an
honest classroom out of a shared lockout); `ipHardLimiter`, 500/hour, never
does.

**`work_mem` is USERSET and this file said so about the other two settings but
not that one.** `mem_limit`/`memswap_limit` of 6g on the db container is the
only real control — it bounds the blast radius to a contained Postgres restart
rather than host pressure. `provision.ts`'s `roleSettings` docblock now names it.

**The backup mount is gone from the app container.** `db/backup.sh` writes a
copy of `.env` into every run, and its comment justified that with "0700 on a
disk the app cannot reach" — which was false: compose mounted that directory
into the container read-write, under the same uid. Nothing read it;
`config.paths.backups` was declared and never used. Both are deleted and the
comment is corrected.

#### The confused deputy — narrowed, and honestly not closed

Three correct behaviours compose: `GRANT SELECT ON ALL TABLES` covers **views**;
a view resolves table access as its *owner* but a function inside it is
`SECURITY INVOKER` and runs as the *caller*; `EXECUTE` on a new function goes to
`PUBLIC` by default. So a student's innocuously named view, calling a function
that inserts from a classmate's schema into her own table, hands over that
classmate's rows the moment her teacher reads it.

**Demonstrated end to end on a real cluster.** The payload observed
`current_user` = the teacher's role and the row landed in the student's table.

`grantTeacherSql` now issues `REVOKE EXECUTE ON ALL ROUTINES IN SCHEMA s FROM
PUBLIC`, and `web/assets/sql.js` no longer auto-runs a relation in a schema the
caller does not own — clicking a foreign table loads the statement and waits.

**The companion statement does not work, and this is the part to remember.**
`ALTER DEFAULT PRIVILEGES IN SCHEMA s REVOKE EXECUTE ON ROUTINES FROM PUBLIC` is
accepted, and on PostgreSQL 18 a function created afterwards still comes out
with `proacl = NULL` — EXECUTE to PUBLIC — because the built-in `acldefault()`
is unioned back in. Measured every way: as the owner via `SET ROLE`, via a real
login, with an explicit `FOR ROLE`, and after materialising the row with a
positive grant first. The teacher could still execute the function each time.
The statement was removed rather than left in looking like a control, and
`grantTeacherSql` carries the finding at the site.

**So: a routine a student creates *after* provisioning is still executable by
their teacher.** `test/provision.live.test.mjs` pins that as an explicit
expectation — the assertion says so and says to invert it rather than delete it
when it starts failing. Closing it needs one of:

- an **event trigger** revoking EXECUTE on every routine created in a `u_%`
  schema. Airtight, but event triggers are superuser-only, so it belongs in
  `db/init/00-bootstrap.sh` *and* needs a one-off statement against the live
  cluster, since bootstrap only runs on a fresh data directory;
- or a **scheduled re-issue** of the REVOKE. Note `reconcile` is not a home for
  it as things stand: it runs at boot and on demand, not on a timer.

That is a deployment decision and was left to the author.

#### Verification

`npm test` — **316 tests, 0 failed, 0 skipped**, i.e. the five live suites
actually ran, against a throwaway PG 18 cluster on 55432. `npm run typecheck`
clean. `db/verify-isolation.sh` **29/29** with no role surviving the run. Both
DoS fixes re-measured against the built output; the two new REVOKE statements
parsed against the real grammar with libpg-query before going anywhere near a
cluster.

**Not fixed, and still open from the same review** (roughly by value): no HTTP
security headers at all, so the app is framable and has no CSP; the reconciler
cannot see a `GRANT … TO PUBLIC` because `inventory` filters `a.grantee <> 0`
and `grantee = 0` *is* PUBLIC; large objects escape the quota, the reset and the
cold-store dump; the result cap counts rows rather than bytes; `/health` echoes
raw driver errors to unauthenticated callers; `PATCH /api/me` renames an account
with no audit row and `user_renamed` has no emitter; archive dumps are written
0644 where `backup.sh` is meticulous about 0600; no absolute session lifetime;
no container hardening directives; `esc()` does not escape `'` and `home.html`
keeps its own copy of it.

**Every item in that paragraph is now done — see §4yy, which is the rest of the
same review.**

---

### yy. The rest of the review, and two more fixes that did not work

§4xx is the first half. This is everything else it found, and the two places
where the obvious fix was wrong — which are the parts worth reading.

#### The CSP is strict, and the app was changed to afford it

`server.ts` now sends `Content-Security-Policy`, `X-Frame-Options`,
`X-Content-Type-Options`, `Referrer-Policy` and (over https only) HSTS from one
`onSend` hook. `default-src 'self'` with **no `'unsafe-inline'` anywhere**,
which is the whole value and which the app could not have taken before:

- `home.html`, `login.html` and `password.html` carried their logic in inline
  `<script type="module">` blocks. Those moved to `assets/home.js`,
  `assets/login.js`, `assets/password.js` — the shape the other three pages
  already had.
- `sql.html:28` had the app's last `onclick=`; it moved into `sql.js`.
- `lesson.html:56` had the app's last `style=`; it became `.dialog-actions` in
  `app.css`.

**Verified in a browser, not by reading**: all six pages load with zero console
errors, login and the password form work, and CodeMirror mounts. That last one
was the real risk — CodeMirror injects its own `<style>` element at runtime, and
it turns out `style-src` does not block a stylesheet built through CSSOM
`insertRule`, which is what StyleModule uses. If a future editor upgrade
switches to literal `<style>` markup, the SQL page loses its theme and the
console says so.

Moving `home.html`'s script out also fixed two things by hand on the way: it had
its **own private copy of `esc()`** (the duplication `util.js` exists to
prevent), and it called `formats()` without importing it, so the footer build
stamp had been silently blank. Escaping now happens *inside* `table()` rather
than at each call site — the old shape was one column away from stored XSS in
the admin's own page, since `memberCount` was already unescaped and safe only by
being an integer.

#### The reconciler could not see a grant to PUBLIC

`inventory` filtered `AND a.grantee <> 0`, and in `aclexplode` **`grantee = 0`
*is* `PUBLIC`**. So `GRANT USAGE ON SCHEMA u_me TO PUBLIC` — one statement, from
the editor — opened a schema to every account in the school, permanently, and
every repair pass reported the instance clean. The peer-to-peer case the
docblock describes was caught; the strictly wider one was not.

`PUBLIC` now comes back as a literal sentinel, `revokeTeacherSql` emits the bare
keyword for it (`REVOKE ... FROM "PUBLIC"` looks for a *role* of that name), and
a grantee that is none of teacher/student/PUBLIC goes to `anomalies` instead of
into `revokeTeacher`, where `assertRoleName` would have thrown on every pass
forever. Covered by a live test.

#### Large objects: the fix is to remove the capability, not to measure it

A large object belongs to **no schema**, and that one fact defeats three
controls at once — `schemaUsage` walks `pg_class` and cannot see it,
`DROP SCHEMA ... CASCADE` does not remove it, and `pg_dump --schema=` does not
carry it. `SELECT lo_from_bytea(0, repeat('a',100000000)::bytea)` needs nothing
beyond CONNECT.

Two attempts at the obvious fixes failed, both measured:

- **Counting them** needs `SELECT` on `pg_largeobject`, which is superuser-only.
  Joining it made `schemaUsage` throw `42501` for every caller — i.e. broke the
  admin usage report and the lesson view outright. Reverted.
- **Dumping them** with `pg_dump --schema=X -b` puts *every* large object in the
  database into that one student's archive, because they have no schema to
  filter by. Verified: a dump of one student's schema contained another
  student's object. That would have been a new isolation leak, in the file the
  app keeps longest.

So `db/init/00-bootstrap.sh` revokes EXECUTE on the constructors
(`lo_from_bytea`, `lo_creat`, `lo_create`, `lo_put`, `lo_import`) from PUBLIC.
Nothing in the app creates one, no lesson uses one, and `lo_unlink`/`lo_get`
stay so anyone holding one can still throw it away. `resetSchema` and `coldStore`
gained `DROP OWNED BY CURRENT_USER CASCADE` for any that predate the revoke —
which drops them undumped, the same thing `archiveAndDrop` has always done.

**An existing cluster needs this applied by hand**, because bootstrap only runs
on a fresh data directory:

```sql
-- PRODUCTION, as a superuser, against `datebaenkli`
REVOKE EXECUTE ON FUNCTION lo_from_bytea(oid, bytea) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION lo_creat(integer)          FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION lo_create(oid)             FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION lo_put(oid, bigint, bytea) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION lo_import(text)            FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION lo_import(text, oid)       FROM PUBLIC;
```

The live test asserts a student is refused, so **it fails against a cluster that
has not had this applied** — which is the intended signal, not a flake.

#### `log_min_duration_statement` cannot be suppressed from the app

`CREATE ROLE`/`ALTER ROLE` carry the student's database password in their
statement text and Postgres does not redact it, so a slow one would log the
password in the clear. `SET LOCAL log_min_duration_statement = -1` around them
was the fix, and it is **rejected**: the GUC is SUSET and `dbk_app` is
deliberately not a superuser. The only role-scoped alternative would disable
slow-query logging for every statement the app makes, which is worth more than
this is. Accepted and recorded at the site; reaching two seconds on a catalog
write takes a pathological stall, and the log is root-readable on the host.

#### Everything else, briefly

- **`/health`** returned the driver's own error text — internal address,
  `dbk_app`, database names — to anyone, unauthenticated, during exactly the
  incident when someone is looking. Now `ok`/`fail` in the body and the detail
  in the log. It also hardcoded `version: '0.1.0'` through six releases; it uses
  `config.build` now.
- **Result sets are capped by bytes as well as rows** (`DBK_MAX_RESULT_BYTES`,
  16 MB). 1000 rows of `repeat('x', 100000000)` is twenty cells and two
  gigabytes; the row cap says nothing about width. Budget is per *script*.
- **`PATCH /api/me` writes `user_renamed`**, which had been in the closed
  `AuditAction` union with no emitter since it was written. Display name is what
  the roster and lesson view render, so a student could take a classmate's name
  during a lesson and put it back with nothing recording it.
- **Sessions have an absolute lifetime** (`DBK_SESSION_ABSOLUTE_TTL_HOURS`, 168).
  Rolling extension had no ceiling, so a token lifted off a shared machine never
  aged out. `created_at` had been written since the table existed and never read.
- **`/api/me/password` is rate-limited** — it verifies the *current* password, so
  it was an unmetered guessing oracle — and **scrypt is bounded to four
  concurrent hashes**, matching the libuv threadpool, so a logged-in student
  cannot loop it to stall everyone else's login.
- **`query_log` is pruned** (`DBK_QUERY_LOG_RETENTION_DAYS`, 120). It held every
  statement every student ever ran, forever, in every backup.
- **Archive dumps are 0600 and the directory 0700**, matching `backup.sh`.
- **Containers**: `no-new-privileges` and `cap_drop: ALL` on both, and the app
  additionally `read_only` with a tmpfs `/tmp`. Verified by building the image
  and booting it with those exact flags — it serves, `/tmp` and the archive
  mount are writable, `/app` is not.

  **The db needs five capabilities back and this was found the hard way.**
  `cap_drop: ALL` alone makes `postgres:17-alpine` exit 1 immediately —
  `chown: /var/lib/postgresql/data: Operation not permitted` — because the
  entrypoint starts as root, chowns the data directory and `su-exec`s down.
  CHOWN, DAC_OVERRIDE, FOWNER, SETGID, SETUID are the minimum that starts;
  everything else Docker grants by default is still gone. A first version of
  this shipped without them and would have taken the database down on deploy.
  Both containers were then run with their exact final flags before this was
  written.
- **`esc()` escapes `'`**. No bug today, because every attribute in the app is
  double-quoted — but that invariant was unwritten and held by habit alone.
- **`DBK_SESSION_SECRET` must have ≥12 distinct characters**; length alone let
  `'a'.repeat(32)` through. A production boot without a Secure cookie now warns.
- **`import.ts` checks column identifiers once and uses the result twice**; the
  DDL line was safe only because a different line happened to run first.
- **`SERVICE_ERROR_STATUS` is prototype-less**, so a code like `constructor`
  cannot resolve to a function.
- **The reconciler restores the session rails.** A student may run `ALTER ROLE
  u_me RESET ALL` on themselves — all three GUCs are USERSET — and nothing put
  them back, because `roleSettings` was only issued when the role or schema was
  missing. `inventory` now reads `pg_db_role_setting` and the report has a
  `settingsFixed` list.
- **`docs/API.md`** was missing both `/api/lesson` routes — one of which returns
  a named student's last 50 statements — and `archive-sweep`; its public-route
  list named six of eleven; and it still said quota enforcement was unbuilt.

#### Two things the browser found afterwards

**The CSP broke the SQL editor, and the check that missed it was too shallow.**
`style-src 'self'` blocks a `<style>` element whose *textContent* is set, which
is how CodeMirror's StyleModule injects its base theme. The element was in the
head with 11 kB of correct CSS and `styleEl.sheet === null` — every rule inert.
Visibly: `.cm-announced` (the screen-reader live region, normally
`position: absolute; top: -10000px`) rendered in flow, pushing the content 42px
below its gutter, and the announcement text "Selection deleted" appeared on
screen. The verification that let it through checked that *a style tag
containing `.cm-` existed*, which was true and meaningless. **Check
`styleEl.sheet !== null`, or that a known rule computes.**

Fixed with `style-src 'self' 'unsafe-inline'` plus `style-src-attr 'none'`. The
second half is what keeps it honest: the dangerous form of inline CSS is the
`style=` attribute an injection writes, the app has none, and CodeMirror's
per-element layout writes are CSSOM which CSP does not police. Verified both
ways — `setAttribute('style', …)` is refused, `el.style.width = …` works.

**`hidden` never worked on a `<button>`, and that is older than this review.**
`[hidden] { display: none }` is a user-agent rule, so `.btn, button { display:
inline-flex }` in app.css beat it on specificity: every `<button hidden>` in the
app rendered anyway. A student saw the "Lektion" and "Klassen" buttons on the
overview — `home.js` set `.hidden = true` correctly and the CSS ignored it.
`app.css` now carries `[hidden] { display: none !important }`. Confirmed
identical at 2095044, so it predates the security work; only sections and divs
were unaffected, which is why nobody had noticed.

#### The gutter "drift" was a measuring artefact — do not go looking for it

An hour went into a bug that does not exist, and the way it looked real is worth
recording because the next person will have the same tooling.

The symptom: line numbers 14px apart against 20px lines, drifting further from
their code with every line. CodeMirror writes `style="height: 14px"` on each
gutter element, and 14 is `HeightOracle`'s hardcoded default — the value it holds
until it measures a rendered line. So the measurement had never happened.

The cause is not in this app. **CodeMirror schedules that measurement on
`requestAnimationFrame`, and a browser tab that is not compositing never fires
one.** The automated browser pane used to check the CSP work runs with
`document.visibilityState === 'hidden'`; rAF does not fire there, the measure
cycle never runs, and the oracle keeps 14/7 forever. Forcing it by hand settles
it:

    view.measure(false)
    // heightOracle.lineHeight: 14  ->  19.59375
    // gutter element:  height: 14px  ->  height: 19.5938px; margin-top: 4px
    // line tops and number tops then agree exactly

Everything else was already right at construction — the parent was 218px tall,
the first line measured 19.59px, and CodeMirror's stylesheet had applied. There
was nothing to fix.

Two things this cost, both avoidable:

- **A baseline comparison that proved nothing.** The same misalignment appeared
  in a worktree build of 2095044, which looked like proof it predated the
  security work. It was the same starved pane, so both sides of the comparison
  had the same artefact. A baseline only isolates a variable if the *environment*
  is held constant in a way that does not itself produce the symptom.
- **A fix that was written and reverted.** `view.requestMeasure()` appeared not
  to work — it schedules through rAF too, so of course it did nothing. It was
  nearly committed with a confident comment explaining a mechanism that was not
  the mechanism.

**So: anything about layout, geometry, fonts or animation is not measurable in
that pane.** Colours, DOM structure, computed styles, whether a stylesheet
applied, console errors and network behaviour all are — that is what caught the
real CSP bug two sections up. If a measurement depends on a frame being painted,
check `document.visibilityState` before believing the number.

#### Still open, deliberately

- The confused deputy's second half (§4xx): a routine created *after*
  provisioning is still executable by the teacher. Needs an event trigger
  (superuser) or a scheduled re-issue of the REVOKE.
- `restoreStudent` sets LOGIN before NOLOGIN, so a crash in between leaves an
  archived account able to authenticate. Contained: Postgres publishes no port
  and every service gates on `state`.
- Deployment hostnames and paths are in the public repo (`docs/`, `.env.example`,
  `app.json`). A judgement call, not a defect — the DNS names are public anyway.

#### Verification

`npm test` — **318 tests, 0 failed, 0 skipped**, so the five live suites ran
against a real PG 18 cluster. `npm run typecheck` clean. `db/verify-isolation.sh`
**29/29**. The CSP and the page rewrites were checked in a browser; the container
flags were checked by running the image.

---

### 4zz. `/handbuch` — the teacher handbook, and the three things it moved

The handbook (`docs/handbuch.html`, generated by `docs/handbook-src/build.mjs`)
is now served at `GET /handbuch` and linked from a `?` icon button. Small
feature, three consequences that are not obvious:

**The build context moved to the repository root.** `docker-compose.yml` said
`context: ./app`, and a context cannot see a sibling directory — so the handbook
could not reach the image without either a second checked-in copy (which would
drift) or a bind mount (which would make `docker run` on the image alone answer
404). It is now `context: .` with `dockerfile: app/Dockerfile`, the Dockerfile's
`WORKDIR` is `/build/app` so that `../docs/handbuch.html` means the same thing in
the image as on the dev machine, and a new **root `.dockerignore`** is what keeps
the context at 2.6 MB instead of the whole checkout — `pgdata/` is in that
checkout on the server. `app/.dockerignore` was deleted rather than left: Docker
does not read it for a context that is not `app/`, so it would have been a file
that looks like it governs the build and does not. Verified by building the image
and diffing the file inside it against `docs/handbuch.html` (md5 identical), and
by listing the context from a scratch image.

**One copy, made at build time.** `postbuild` does `cp ../docs/handbuch.html
dist/web/`, and `app/dist/` is gitignored, so there is exactly one checked-in
copy. `reply.sendFile('handbuch.html', <web dir>)` — the second argument
overrides the plugin's `root`, which points at `web/assets` — rather than
reading it into memory the way `routes/pages.ts` does: 1.1 MB of embedded
screenshots wants an ETag, and it gets `send`'s. Confirmed 200 then 304.

**The CSP has its first exemption, and it is by URL.** The handbook embeds its
webfonts as `data:` URIs, which `font-src 'self'` blocks outright — the document
renders in a fallback face and nothing says why. It also carries two `style=`
attributes, which `style-src-attr 'none'` blocks. Neither is fixable from this
repo: the generator is shared with the sister apps. So `HANDBOOK_CSP` in
`server.ts` relaxes exactly those two and *tightens* the one that matters —
`script-src 'none'`, stricter than the app's own `'self'`, because the handbook
contains no script and never will. The `onSend` hook chooses on
`req.routeOptions.url`, not `req.url`, so `/handbuch?anything` still gets it.
**Do not widen this to the app**: `script-src 'self'` there is what would catch
a missed `esc()`.

The button is `<a class="btn icon-btn">?</a>` — a link and not a button, because
`target="_blank"` has to survive middle-click and the CSP forbids the inline
handler the alternative would need. It is on `/login` (corner-fixed, `.help-fab`
— no top bar there, and a teacher who cannot log in is a reader it is *for*),
`/`, `/lesson` and `/roster`. It is **not** on `/sql`, and `home.js` hides it for
students the same way it hides the two staff nav buttons, because that shell is
also the student overview. sql.html carries the comment saying what a
student-facing help would have to be instead — a different, bilingual, much
shorter page — and that writing it is deliberately deferred.

`db/verify-auth.sh` gained one check (**95**, was 94): `/handbuch` answers 200
with no cookie. That is the assertion that fails if the route ever loses
`config: { public: true }`.

**Not verified:** `docker compose build` itself. The compose v2 plugin is not on
the dev machine — `docker build -f app/Dockerfile .` was used instead, which is
the same context and the same Dockerfile but not the same command. The `build:`
block was checked by parsing the YAML only.

---

## 5. What is verified, and what is not

### Phase 9, verified 2026-08-07

All four nets, against real PostgreSQL 18.4 on the throwaway cluster:

| | result |
|---|---|
| `npm test` | 396 registered, **311 pass, 0 fail** (live suites skipped) |
| `node --test test/*.live.test.mjs` | **79 pass, 0 fail, 0 skipped** |
| `db/verify-isolation.sh` | **41/41** (was 29 — phase 9 added 12) |
| `db/verify-auth.sh` | **95/95** |

And the end-to-end run that green tests cannot substitute for (the §4dd
standard), driven in a browser as three different accounts:

- an exercise with **one CSV table and one SQL script**, distributed to a class
  of two;
- the Swiss coercions survived materialisation — `1234,50` → `1234.50`,
  `03.04.2024` → 3 April — and dates still reach the grid as **text** (§4l);
- **Lena deleted two of three rows and zeroed the amounts; Tim's copy still read
  3.** Neither could read the other's schema, in either direction;
- unqualified `kunden` inside the exercise resolved to the *exercise's* table,
  not to the `kunden` she had made in her own playground — checked by the column
  names, which differ;
- reset restored the fixtures and **left her playground table alone**;
- a **full** `/api/workspace/reset` dropped the workspace, and re-opening
  rebuilt it;
- two hand-ins from her and one from Tim; single and bulk `.sql` downloads;
- cold storage took the workspace with it and the restore brought the account
  back; re-opening rebuilt the exercise;
- take-back removed both schemas and all three hand-ins and left both
  playgrounds; deleting the exercise took the teacher's own test copy too;
- the audit trail carries all five actions with the counts.

### On production, 2026-08-07

**Deployed and working.** The 311 non-live tests were run first in a throwaway
`node:22-alpine` container against the server's PostgreSQL 17 client — `fail 0`,
`skipped 0`, ~177 s — while the known-good image was still serving. Then pull,
`build`, `up -d`. `curl /api/version` moved on **both** fields (`0.8.1` →
`0.9.0`, new `builtAt`), the boot log carried `applied migration
003_exercises.sql`, and a later `docker compose restart` said **`meta 0 applied /
3 current`**, which is the checksum ledger holding.

**What the author actually drove on the live instance:** created an exercise,
solved it from a student account, and read the hand-in back.

**What was NOT repeated there**, and it is the isolation half — the part the
whole design rests on:

- **two students at once.** Locally, one wrecked her copy while the other's
  stayed intact, and neither could read the other's schema in either direction.
  On production only one student account was used, so the *claim* is carried by
  `exercise.live.test.mjs`, `verify-isolation.sh`'s twelve new checks and the
  local run — not by an observation on the server.
- **reset, take-back and delete.** None was exercised on production. Take-back is
  the destructive one and the one worth watching the first time it runs against
  a real class.

That is a reasonable place to stop for a first deploy and it is *not* the §4dd
standard, which is why it is written down rather than rounded up. The cheapest
way to close it is the next real lesson: two students in one class, one of them
deleting rows, the other pressing refresh.

### Still not verified, anywhere

- **No real lesson.** Same caveat the whole app carries: no class has used this,
  so the fixture caps (2 MB / 20 000 rows / 20 sources) are reasoned rather than
  measured, and nobody has yet found out what a teacher actually types into the
  task box.
- **The teacher's authoring page was driven through its API and its DOM, not
  through the CSV dialog's file picker.** The dialog itself is the same code the
  student's import has used since phase 3, and `test/pages.test.mjs` pins that
  both copies of its markup carry every id it reaches for — but a human has not
  picked a file on that page.

### The standing numbers

**`cd app && npm test`** — **314 tests** as of 7.2, ~165 s, of which the five
live suites skip without a server. *(Phase 9 took this to 396 registered / 311
passing; the paragraph below is the 7.2 measurement and is kept for its
method.)* Measured 2026-07-29: no server gives
`pass 256, skipped 63` (the 58 live cases plus the five per-suite placeholders
`liveSuite()` registers, which is why the registered total reads 319 rather than
314). With a cluster up: **314 pass, 0 skipped**, run this session. Covers scrypt, AES-GCM round-trip and
tamper detection, identifier folding and clamping, every migration parsed by the
real PostgreSQL grammar and executed in PGlite, the service layer driven against
a migrated PGlite, the provisioning seams via a recording fake, identifier
safety, the reconciler's diff, and the watchdog's bookkeeping.

With a cluster up (§6), **all 314 pass and nothing skips** — run twice in a row
to confirm the live-suite lock (§4h) actually removed the flake (done, for the
live-plumbing hoist: 252/252 twice, before phase 6a added 38 pure tests):

```bash
PGHOST=127.0.0.1 PGPORT=55432 DBK_APP_DB_PASSWORD=secret \
  DBK_ARCHIVE_DIR_CONTAINER=/tmp/dbk/archive node --test test/*.test.mjs
```

**Against real PostgreSQL 18.4** (see §6 for the throwaway cluster):

- `app/test/provision.live.test.mjs` — **12 checks** that the *engine* issues the
  right SQL: role/schema/ownership/rails, cross-student denial, teacher read
  including tables created after the grant, a late grant covering pre-existing
  tables, revoke covering future tables, `inventory()`, reset re-granting,
  idempotent re-provisioning, archive NOLOGIN, dump-then-drop, no-op re-drop.
- `app/test/query.live.test.mjs` — **13 checks** on the runner and the watchdog:
  columns/rows/command tags, one result per statement in a script, duplicate
  column names surviving, the row cap reporting a true total, a syntax error
  carrying its position, **a student who ran `SET statement_timeout = 0` being
  stopped anyway**, the role default stopping an ordinary runaway without the
  watchdog, Cancel reporting `user` rather than `timeout`, a cancelled statement
  not poisoning the next query, an unclosed transaction not leaking, and
  `query_log` recording both outcomes. Plus **2 quota checks**: a student over
  the limit refused a `CREATE TABLE` with *no* `query_log` row written, and the
  same student still able to `SELECT`, `DELETE` and `DROP` — including the
  assertion that the `DELETE` freed nothing (§4q).
- `app/test/import.live.test.mjs` — **3 quota checks** among the CSV ones: an
  import refused before it opens a connection or creates anything, the schema's
  measured size asserted `> 0` first so a zero reading cannot fake the pass
  (§4r), and a `replace` import crediting the space the old table is about to
  free.
- `app/test/catalog.live.test.mjs` — **5 checks** on the schema browser's data:
  own tables listed with real column types, **another student's schema not
  listed at all**, a teacher reading their student's schema (and a view labelled
  as one), an empty-but-readable schema still listed, and a never-analysed table
  reporting `null` rather than a row estimate of zero.
- `app/test/lifecycle.live.test.mjs` — **10 checks** on cold storage and the
  restore: a schema dumped and dropped with the role left NOLOGIN and CONNECT
  intact, reconcile *not* recreating it, **a restored student reading the rows
  she wrote before the drop and inserting a new one** (§4dd's standard — the
  INSERT is what proves ownership, not just readability), the teacher grant
  coming back from the roster rather than from the dump, a second restore
  refused without touching the live schema, a dump path outside the archive
  directory refused, **the reconciler restoring an ARCHIVED account and leaving
  it NOLOGIN** (the case §4ff's coverage hole hid), a failed restore leaving the
  account cold-shaped and then succeeding on retry, and the sweep taking a
  student's login away without touching their schema.
- `db/verify-isolation.sh` — **28 checks** on the SQL sequences themselves.
- `db/verify-auth.sh` — **88 checks** against a running app. This run created,
  provisioned, dumped and deprovisioned 6 real accounts with **0 provisioning
  failures and no leftover roles or schemas**.
- Manually, over HTTP: create → provision → student logs into Postgres with the
  stored credential → teacher reads their table → peer read denied → reset →
  `/api/admin/usage` → `/api/admin/reconcile`.
- **The quota end to end over HTTP**, against a running app booted with
  `DBK_STUDENT_QUOTA_MB=1` and a real provisioned student: a 40 000-row
  `CREATE TABLE AS` succeeded and took her to 4.01 MB; `/api/admin/usage` then
  listed her in `overQuota`; `CREATE TABLE` and `INSERT` answered **507
  `quota_exceeded`** naming both numbers; `SELECT` and `DELETE` still answered
  200; a CSV upload answered 507 naming its own estimate; `GET /api/workspace`
  kept working throughout; and after `DROP TABLE` both a `CREATE TABLE` and the
  same CSV upload succeeded — writes resume with no restart and no reset. This
  is the run that found §4q.
- Reconciler self-healing, live: dropped a role out of band, set another
  `NOLOGIN` behind the app's back, and granted a peer student USAGE. One
  reconcile call repaired all three and reported each correctly.
- The query API over HTTP, against a running app on **production config
  defaults** (not the short test timeouts): a student ran
  `SET statement_timeout = 0; SELECT pg_sleep(120);` and the watchdog stopped it
  at 20 s with `cancelled: {reason: "timeout"}`; `POST /api/query/cancel`
  stopped the same query in 2 s with `reason: "user"` and `{cancelled: 1}`; the
  connection was reusable immediately afterwards; `/health` reported
  `runningQueries` throughout. Also confirmed `415` without a JSON content type,
  `401` unauthenticated, and `403 wrong_role` for an admin.
- **The student page, driven in a browser** against a running app on a real
  cluster, logged in as a real provisioned student: the tree renders own schema
  + `demo` + `public`; ⌘/Strg+↵ runs; a script produces one grid per statement;
  duplicate column names both survive and `NULL` renders distinctly; the row cap
  reports "die ersten 1'000 von 4'812 Zeilen"; a syntax error underlines exactly
  the word Postgres named and reports "Zeile 2, Zeichen 5"; **Cancel stopped a
  student who had run `SET statement_timeout = 0`** and the connection was
  usable immediately afterwards; the watchdog stopped the same query at 20 s
  with a *different* message; clicking a table replaces the editor and runs
  `SELECT * … LIMIT 50`; "Datenbank zurücksetzen" emptied the schema, refreshed
  the tree, and left the teacher's USAGE grant intact.
  Screenshots could not be captured in that environment, so this was verified
  through the DOM rather than visually — layout is asserted only as "the panes
  fit the viewport and the result grid scrolls inside its own pane".

**On the server, on real PostgreSQL 17** (`/opt/apps/datebaenkli`):

- **The Docker build and the compose stack work.** This was the oldest unverified
  item in the document — it had been open since phase 0. The image interrogates
  clean: `node v22.23.1`, **`pg_dump 17.10`** (matching `postgres:17-alpine`, which
  is what makes archive dumps possible at all), `dist/web/assets/editor.js` at
  445 KB, no `editor.entry.js`, no `@codemirror` in the runtime image, and
  `dist/db/sql/{meta,teach}` present.
- **The two alpine/musl worries this section used to record were both ghosts.**
  esbuild 0.28 publishes no musl package and ships a *statically linked* Go
  binary; `libpg-query` 17.x is pure WASM with no install script. Neither needs
  build tools in the image. `apk add postgresql17-client` — the one that was
  genuinely unproven — resolves fine.
- **First boot is clean**: meta 1 migration, teach 2, bootstrap admin created,
  `reconcile: 0 accounts checked, nothing to repair`, `/health` `ok` on both
  pools. The bootstrap produced `dbk_app createrole=t super=f login=t`, both
  databases owned by `dbk_app`, and `CONNECT` denied to `PUBLIC` on both.
- **All 208 tests of the phase-4 tree pass on Postgres 17, nothing skipped** —
  the four live suites included, run from a throwaway `node:22-alpine` container
  joined to `datebaenkli_datebaenkli_internal`. The 20 tests added since (phase
  5a's name parser, §4dd's CONNECT repair) had passed only on **18.4 locally** —
  **that gap is now closed**: the 5b deploy re-ran §7's container command and got
  252/252 with 0 skipped, so every test in the tree has now run on 17.10.
  **The 17-vs-18 version gap is closed** for what that run covered:
  the role-membership semantics the watchdog (§4a) and the quota (§4r) depend on
  behave identically. Note `tzdata` in that container is load-bearing — Alpine
  without it resolves `TZ=Europe/Zurich` to UTC silently, and the two date
  assertions would then pass vacuously (§4l).
- That run is also what found §4u, the leaked `t_schaffner` role.

- **Proxying and TLS work.** Proxy host forwards to `datebaenkli-app:3000`
  over the proxy network (`DBK_PROXY_NETWORK`) (container name, no published
  port — neither service publishes one, so the stack cannot collide with
  anything else on the host). Let's Encrypt certificate issued, Force SSL on,
  HSTS deliberately left off. `DBK_COOKIE_SECURE` is back to blank, i.e.
  inferred from `DBK_PUBLIC_URL`'s https scheme.
- **`DBK_TRUST_PROXY_HOPS=1` is confirmed correct**: request logs show real
  client IPs, not the proxy's container address. Misconfigured, this would throttle
  the whole school as one address on the login limiter.
- **`verify-auth.sh`: 88 passed, 0 failed** against the deployed app, with the
  teardown reached and no leftover roles. The archive volume is proven by that
  run rather than assumed — a deletion refuses to drop a schema it could not
  dump, so five `.dump` files in `/mnt/bulk/datebaenkli/archive` owned by uid
  1000 *are* the proof that the mount and the `chown` are right.
- Within minutes of going public, opportunistic scanners probed `/.env` and
  `/.git/HEAD` — both **404**. `/`, `/login`, `/sql` and `/password` answer
  **200** to anonymous callers, which is correct and is §4k: they are program
  text whose script redirects to `/login`, and every action goes through an
  `/api` route that is closed by default.

**From deploying phase 5b (2026-07-28), on the server, PostgreSQL 17.10:**

- **252 tests, 252 pass, 0 skipped**, from a throwaway `node:22-alpine` joined to
  `datebaenkli_datebaenkli_internal`, run *before* the image swap. This is the
  first time the whole tree — including 5b's `lifecycle.live.test.mjs` and its
  `pg_restore --list` regex parsing — has run against `postgresql17-client`
  rather than the dev machine's 18.4. `skipped 52` would have meant the container
  never reached the database and every live suite opted out silently; it did not.
  Afterwards, no leftover `^[ut]_(lvt|qlt|lct|lit|llt)_` roles or schemas.
- **The migration applied**: `migrations: meta 1 applied / 1 current`, and on a
  second boot `meta 0 applied / 2 current`. `app_user.archive_path` exists and
  the seeded `archive_after_days` `setting` row is gone.
- **`reconcile: 4 accounts checked, nothing to repair`**, both before the drill
  and again after it. The second one is the assertion that matters: §4ff's
  coverage hole was an account left in a shape reconcile skips while reporting
  the instance clean.
- **`archive sweep armed for 03:40 local, threshold 365 days`.** The pre-deploy
  candidate count was `0`, as expected for a July 2026 instance. See §4gg for
  what "local" turned out to mean.
- **One real student through cold and back, ending with her own `SELECT`.**
  Cold: `pg_namespace` count `0`, `rolcanlogin` `f` (role kept, §3's decision
  confirmed on the server), her login refused `401`, a 3822-byte dump on the
  archive volume. Cold took 1241 ms. Restore: `provisioning.ok`, 129 ms, then
  she logged in and read back the rows she had written before the drop. Her
  schema held exactly one table, so this was a complete check rather than a spot
  check. Afterwards `archive_path` is empty and the dump remains on disk.
- What this run did **not** cover: a cold-store of a schema large enough for the
  dump or restore to approach `DBK_DUMP_TIMEOUT_MS`, and the sweep actually
  firing (it is armed, not observed). §8 keeps the second of those.

**From the collation and backup session (2026-07-28), on 18.4 locally:**

- **The whole suite again on an ICU cluster, with nothing skipped**: 47 live
  checks, 161 unit, `verify-isolation.sh` 28/28, `verify-auth.sh` 88/88. The
  collation change touches only `CREATE DATABASE`, so no test needed changing —
  which is the point of it living in the bootstrap and not in a migration
  (migrations also run under PGlite, which has no ICU).
- **The demo data sorts correctly**: `ORDER BY nachname` now returns
  `… Brunner, Bühler, Kaufmann, Keller, Küng, … Roth, Rüegg, Schmid …`. Under
  `C.UTF-8` all three of those sat after Zimmermann.
- **`db/backup.sh`, driven against the throwaway cluster**: a run produces
  `meta.dump`, `teach.dump`, `globals.sql` and a `MANIFEST` in a per-run
  directory; each dump is verified by reading its TOC back; retention prunes to
  `DBK_BACKUP_KEEP`; `--check` fails on a stale backup, on an empty directory
  and on a directory containing only a failed run; a dump that fails mid-run
  leaves `<stamp>.partial` and exits non-zero without publishing anything.
- **A full restore drill into a brand-new empty cluster** — bootstrap, globals,
  `pg_restore --clean --if-exists` — brought back the roles, both student
  schemas, the demo data and the ICU collation. §7 has the procedure, §4y has
  what it found. **Repeated on the server against its own nightly backup**
  (2026-07-28), where it found §4dd: everything above came back and no student
  could connect, because `pg_database.datacl` is in neither dump. That is why
  the procedure now ends with a student query rather than an admin login.

**From applying both runbooks on the server (2026-07-28), on PostgreSQL 17.10:**

- **`postgres:17-alpine` carries usable `de-CH` ICU data — executed, not read.**
  This used to be an inference from the official Dockerfile. It was settled
  *before* anything was destroyed, by running the bootstrap's own probe against
  the already-deployed container, which is the same image: `SELECT ('Zürcher'
  COLLATE "de-CH-x-icu") < ('Zwahlen' COLLATE "de-CH-x-icu")` → `t`. ICU
  collations are imported at initdb regardless of a database's own provider, so
  this is answerable on a `C` cluster, and it turns a destructive step into a
  decision instead of a gamble. Sorting the same six names both ways on that
  cluster gave `Bühler Küng Rüegg Zebra Zimmermann apfel` against
  `apfel Bühler Küng Rüegg Zebra Zimmermann`.
- **The recreate went as written.** `Datebänkli: bootstrap complete (…; ICU
  de-CH)`, then `dbk_app createrole=true super=false`, `CONNECT` `f`,
  `prov = i` / `datlocale = de-CH` on both databases, `upper('straße')` →
  `STRASSE`, a clean app boot (`reconcile … nothing to repair`,
  `Server listening`), and an admin login over https with a rotated password.
- **The deployed databases were `C`, not `C.UTF-8`** — this document said the
  latter in three places and was wrong. Alpine's musl cannot provide `C.UTF-8`
  collation, so the original initdb settled on `C` despite `LANG` in the compose
  file. It changed nothing about the outcome (both are byte order, and both are
  what the ICU change replaces), but it is the kind of small false fact that
  makes a reader distrust the rest of the page.
- **Backups are installed and running.** A by-hand run, then the exact cron line
  dry-run through its redirect; `--check` green; `crontab -l` confirming the
  03:17 entry; `docker` and `flock` both under `/usr/bin`, which is where cron's
  short PATH can find them. The MANIFEST is now the collation's audit trail
  either way: `c:C` at 08:43, `i:de-CH` at 09:03.
- Two traps found by installing it rather than writing it, both now in §7: the
  script must run as the uid owning `/mnt/bulk/datebaenkli`, and
  `/var/log/dbk-backup.log` must exist before cron first tries to redirect into
  it.

**From phase 4 (2026-07-28), locally on 18.4:**

- **216 tests pass with nothing skipped** — the 8 new lesson tests included —
  plus `verify-isolation.sh` 28/28 and `verify-auth.sh` 88/88 with its teardown
  reached and no accounts left behind.
- **The view driven over HTTP against a real cluster** booted with
  `DBK_STUDENT_QUOTA_MB=1`: a student ran three statements, one failing, then
  filled her schema to 2.0 MB and was refused a `CREATE TABLE`. The roster shows
  3 statements, 1 error, a last statement that is the `CREATE TABLE AS` and
  **not** the refused one, and `über Limit · 2.0 MB / 1.0 MB` beside it. This is
  §4z working end to end rather than in a fake.
- **Every boundary refused correctly**: a second teacher `403 not_your_class` on
  both routes, a student `403 wrong_role`, an anonymous caller `401`, an unknown
  student id `404`, `?minutes=abc` clamped to the default rather than erroring.
  An admin gets the statements and a `null` schema, having no Postgres role.
- **Driven in a browser**, which is what caught `1 Zeilen`: the table renders,
  clicking a row opens the drill-down with the statements newest-first, the
  error carrying its SQLSTATE, and the student's tables beside them.

**On the server, after deploying phase 4 (2026-07-28):**

- **The rebuild is clean and adds no migration** — `meta 0 applied / 1 current,
  teach 0 applied / 2 current`, `reconcile … nothing to repair`,
  `Server listening`, exactly as before it. Phase 4 only reads.
- **A teacher account was created over the API and provisioned** (`ok: true`),
  logged in, changed its password, and reached the lesson view. That is the
  first account on the recreated cluster.

**Phase 5a, driven in a browser against a real cluster (2026-07-28):**

- **The whole path with no `curl` at any point**: admin logs in, creates
  teacher `t_schaffner` (slip shown once), creates class `k3a` naming its owner,
  opens it, pastes four names, checks the preview, creates them. All four
  schemas exist in `pg_namespace` owned by their own roles.
- **The name splitter under real input**: `Von Gunten Anna` kept its two-word
  surname, `Rossi, Marco` overrode the order select. Usernames came out
  `u_k3a_vongunten_anna` and `u_k3a_rossi_marco`.
- **The re-issue filter, by execution** (§4bb): after logging Lena in, the
  button dropped from 4 to 3 and excluded her; after pressing it, her original
  slip still authenticated (200) and Tim's superseded one did not (401). After
  archiving Marco it dropped to 2.
- **The four `@media print` rules parsed and kept `break-inside: avoid`**,
  checked through `document.styleSheets` rather than by eye.
- **The teacher's view**: no Lehrpersonen section, own class only, auto-opened.
  `GET /api/teachers` answers 403 for them.
- **PATCH and DELETE carry the JSON content-type**, so the CSRF hook passes them
  — the archive toggle worked, and "Aus Klasse" reached the service and was
  refused by *its* guard (a student's only class), which is the correct answer.
- **A sheet of slips was printed on real paper** — by the author, not the
  agent — which is what found the address bug in §4bb. The corrected slip was
  confirmed the same way, against an instance reached over its LAN address
  while `DBK_PUBLIC_URL` named the public one: the slip printed the public one.

**Phase 7 was driven in a browser against the local cluster** (2026-07-29), as a
real student and as admin, in both locales and both themes. What that actually
established, beyond "the pages render":

- **The accent resolves at runtime** — `oklch(0.690 0.100 300)` on the day; it
  is `0.578` since §4ww darkened it for contrast — the warm
  neutrals apply, all three stylesheets load, and `document.fonts.status` is
  `loaded` with no network beyond this origin.
- **The subsetted icon font works as a ligature**, measured rather than eyeballed:
  `database` collapses to one 20 px glyph while `rocket_launch` — deliberately
  outside the subset — measures 260 px, i.e. renders as words. That is the loud
  failure mode the subset's safety argument depends on, confirmed.
- **`chalk-lang` really is only a cache.** Set to `en` by hand while the account
  was `de`, then reloaded: the page came back German *and the key had been
  corrected to `de`*. The account overrode the client, which is the whole claim.
- **The `.hint-de + .msg` contract survived the restyle** (§4ll): a 42P01 renders
  the German hint bold above the raw `relation "kundn" does not exist` in mono,
  weight 400, muted — demoted but never hidden.
- **`sql.html`'s three-pane geometry survived**: `min-height: 0` still resolves to
  `0px` on `main`, `#editor` and `#results`, and the body does not scroll.
- **Hiding `#main` on the roster takes the top bar with it**, which is what keeps
  the language control off the slips screen without any JavaScript saying so.

**Phase 7.2 was driven in a browser against a local cluster** (2026-07-29
evening), as a real student, both locales and both themes:

- **The quota line renders the figure the API measured.** `1.5 MB von 50.0 MB
  belegt` for a schema `pg_total_relation_size` put at 1 548 288 bytes, and
  `1.5 MB of 1.0 MB used — full. …` in English.
- **The over-quota branch was forced rather than described.** Restarting with
  `DBK_STUDENT_QUOTA_MB=1` against a schema already holding 20 000 rows made
  `overQuota: true` real; the line took `.bad` and computed to `--bad-ink`.
  That is a much cheaper way to see this state than filling 50 MB.
- **Both colours were rasterised, not eyeballed** — the numbers are in §4tt, and
  they are what moved the resting line off `--faint`.
- **A real `2BP01` went through the real import dialog.** A view was created on
  `kunden`, then `kunden.csv` was imported with "replace" ticked; the pane
  rendered the hint above Postgres's own message with `kunden_zh` named in it.
  Then the same error through the *query* pane in German, where the hint sits
  above the message and `DETAIL`/`HINWEIS`/`SQLSTATE` below — one handler, two
  panes, confirmed in both.
- **`db/verify-auth.sh` — 91 passed, 0 failed**, including the three new
  workspace checks, against the running app. **94 after phase 7.3** added the
  teacher/admin split on `cold` in both directions plus the round trip back.
- **`db/verify-isolation.sh` — 29 passed, 0 failed**, and `pg_roles` was queried
  independently afterwards: **0 roles and 0 schemas left**. Before the fix the
  same query answered 2. That is the check that made §4tt's leak visible.

**Phase 7.3 was driven in a browser** (2026-07-30), as admin and as teacher, both
locales, against a real cluster:

- **The cold round trip, checked in Postgres rather than in the UI.** Storing
  dropped `u_k4b_buehler_zoe`'s schema, kept the role `NOLOGIN`, and wrote
  `u_k4b_buehler_zoe-…dump` to the archive; "Aktivieren" brought both the schema
  and `rolcanlogin` back. That is the claim the confirmation text makes, so it
  is the one that had to be tested rather than assumed.
- **A real deletion**: two dialogs, then the role and schema gone from
  `pg_catalog`, the dump still on disk, and the `app_user` row reading
  `deleted`. The row disappears from the roster because `listStudents` filters
  it, which is why the copy says the account goes rather than that it is hidden.
- **Cancelling at the second dialog aborts**, verified by answering yes then no
  and confirming the account was still `active` on the server. That is the only
  reason the second dialog exists, so it is worth an explicit case.
- **The teacher sees four buttons and no "Auslagern"**; the admin sees five.
- **Both dialogs render in English**, and the state column reads `in storage` /
  `ausgelagert` rather than `cold`.
- **No horizontal body scroll at 375 px** any more: 375 = 375, with the roster
  table scrolling inside its own container. It was 714 before this phase and
  852 during it.

**Phase 7.4 was measured rather than argued** (2026-07-30):

- **`/health` answers before the boot reconcile finishes.** Three students' roles
  were dropped behind the app's back; on the next boot health answered 0.33 s
  after start and reconcile settled at 0.34 s having re-provisioned all three.
  The margin is small because re-provisioning is fast — the guarantee is the
  ordering, and reproducing the 15-minute `pg_restore` case was not needed to
  prove it. Reconcile still repaired correctly, which was the regression risk.
- **The archive sweep fired**, 74 ms after its armed minute, archiving exactly
  the two backdated students to `NOLOGIN` and leaving the control `active`.
- **The sweeper's log line was checked under three zones**: unset (dev machine →
  `Europe/Zurich`), `TZ=Europe/Zurich`, and `TZ=UTC` → `03:40 UTC`, which is
  what the container will print.
- **`verify-isolation.sh` still passes 29/29** after the rename, with `pg_roles`
  queried independently afterwards: no `vfy_*` role survived.
- **`db/verify-auth.sh` — 94 passed, 0 failed** after the boot-order change.

**Still NOT verified about 8.1:** the sweep's nightly *re-arm*, which cannot be
seen in under 24 h and is deliberately not instrumented; and the restore backlog
at a size where `pg_restore` actually takes minutes, which is the case the boot
reordering exists for.

**Still NOT verified:**

- ~~**a locale surviving overnight.**~~ **VERIFIED 2026-07-30, and it passed.**
  After ~39 h in which nobody authenticated against the deployed app, the
  student logged in and the page was still English. So the locale really does
  come from `app_user.locale` after the session cookie has expired, and §4mm's
  "the only source of truth" claim holds: `paintCached()`'s cache was not doing
  work the server was supposed to do. Open since 6b, across three deploys,
  closed. The rest of this bullet is kept because the *method* is the reusable
  part:

  **Still open, but the gap has finally opened.** It was not closeable when 7.2
  began: the 7/7.1 session ran until 01:27 and 7.2 opened at 09:38, ~8 h. By the
  end of 7.2 it was, and the reason is worth stating because it is the way out
  of a loop this check has been stuck in for three sessions:

  **7.2 never touched production in a browser at all.** Its only production
  request was `curl /api/version`, which is `public: true` and carries no
  cookie, so it slid no session. All of its driving was against `localhost:3111`
  on a throwaway cluster. As of 2026-07-30 that leaves ~39 h during which nobody
  authenticated against the deployed app.

  **So the pattern that kept resetting this is avoidable, not inherent**: it is
  only the *authenticated, in-browser* traffic that refreshes the session.
  Development against a local cluster does not, and a public curl does not.

  It needed the author rather than an agent, because it needed the browser that
  holds that student's session and a password an agent should not be asking for.

  **The reusable lesson, for the next check that has to wait on a clock:** what
  resets it is authenticated in-browser traffic against *production*. Local
  development does not, and a `public: true` curl does not. Three sessions in a
  row failed to close this by treating "we worked on the app" as "the clock
  restarted", when only one kind of work actually restarts it.

  **The condition, stated so it does not have to be re-derived.** Sessions slide
  on every request and `DBK_SESSION_TTL_HOURS` defaults to **12**
  (`config.ts`), so the check needs a **>12 h gap during which nobody touched the
  app in that browser** — not merely "the next day". After a normal night of not
  using it, that holds. After an evening of testing it does not.

  What to do: open `https://datebaenkli.schaffner.xyz` in the browser where a
  student was switched to English, log in as that student, and read the nav.

  - **English** → the locale came from `app_user.locale` after the cookie
    expired. Strike this bullet.
  - **German** → the locale had been riding on the session, and §4mm's "the only
    source of truth" claim is wrong. That would be a real finding, not a
    cosmetic one, because it would mean `paintCached()`'s cache was doing work
    the server was supposed to do.

  Note the browser matters: `localStorage["chalk-lang"]` now paints the first
  frame, so a *different* browser would show German briefly for an innocent
  reason. Use the one that was switched, and judge by what is on screen once the
  page settles.

- ~~**What `t_schaffner` is on the production cluster.**~~ **ANSWERED
  2026-07-30: it is the author's own teacher account, made by hand.** So
  `verify-isolation.sh` never leaked into production — but the reason that
  matters is the opposite of the one it was asked for. The script *drops* every
  name it uses, and its header told you to run it against the live server; doing
  so would have deleted that account and its schema. §4tt has the finding and
  the guard that now makes it impossible. Nothing on the server needs cleaning
  up.

- **Phase 7.2 against the deployed stack**, which is simply that it has not been
  deployed yet.

- ~~**phase 7 on a real phone, and on any browser that is not Chromium.**~~
  **Both done by the author, 2026-07-30**: a full pass in **Zen** (Gecko —
  Firefox-based) on the desktop, and a pass on a **phone** in Vanadium, with no
  problems found. That closes both halves of this bullet as it was written.

  One distinction worth keeping so nobody over-reads it later: Vanadium is
  Chromium-based, so the phone pass covers *mobile layout* rather than *mobile
  Gecko*. Zen covers Gecko at desktop widths. Nothing has driven Firefox on a
  phone, which is a much narrower gap than the one this bullet described.
- **phase 7 against the deployed stack at all.** Nothing about it is
  deployment-specific, but the same was said of the student page (below).
- ~~**the sweep has never actually fired on its timer.**~~ **Closed 2026-07-30
  by watching one fire** (§4vv): armed two minutes out on the throwaway cluster
  with the hour, minute and threshold set by environment variable, it archived
  the two backdated students at the armed minute and left the control alone.
  The `setTimeout`-to-real-clock wiring is no longer inferred.

  **What is still unobserved is the re-arm.** `arm()` is re-entered from a
  `.finally`, but the "armed" log line sits outside it, so nothing marks a
  nightly re-arm and the next one is 24 h away. Left uninstrumented on purpose —
  `lifecycle.ts` argues that a line per uneventful sweep trains a reader to skip
  the ones that matter.
- **cold storage at any size that matters.** The drill dumped one table.
  `DBK_DUMP_TIMEOUT_MS` is 300 s and nothing has come near it, in either
  direction. A term's work for a full class is the case that would.
- ~~the roster page in a browser that is not Chromium.~~ Covered by the Zen
  (Gecko) pass on 2026-07-30.
- the student page in a browser *against this stack* (phase 3's UI was driven
  against a local cluster; nothing about it is deployment-specific, but it has
  not been re-driven here)

---

## 6. Commands

```bash
cd app
npm test          # build + the full unit suite
npm run typecheck
npm run build     # tsc, then postbuild: copies db/sql + web, bundles the editor

# PHASE 7. Re-vendor the webfonts. NOT part of the build — it needs the network
# and its output is committed. Run it only when a weight, a family or the icon
# list changes; adding an icon to a page means adding it to ICONS (alphabetically,
# or Google answers 400 with an HTML page) and re-running this.
cd app && node tools/vendor-fonts.mjs
```

**Postgres is installed on the dev machine again** — 18.4, at `/usr/bin`. It was
*absent* at the start of the 7.2 session (no `initdb`, no `psql`, nothing on
disk) and `/tmp/dbk` was gone with it, which is worth knowing because it makes
every live suite skip silently and the skip looks like a pass. If
`which initdb` comes back empty, that is the whole diagnosis; installing it is
one `pacman -S postgresql` by the author.

**What is in `/tmp/dbk` right now**, so the next session does not have to guess
before deciding whether to wipe it: **a freshly built cluster with almost
nothing in it.** 7.2 rebuilt it from scratch (the old one had been wiped with
`/tmp`), ran `00-bootstrap.sh`, and let the app apply both migrations. It holds
admin `admin/admin-neu-12345` and no other account: the teacher, class and
student 7.2 created were deleted through the app's own lifecycle afterwards, and
`db/verify-isolation.sh` removes its own three roles now (§4tt). `pg_roles` was
checked directly and holds **no** `u_*` or `t_*` role at all.

So there is nothing here to preserve and nothing to collide with — wipe it
freely, and note that a run of `verify-isolation.sh` is now safe against it
rather than something that eats your fixtures.

**Pin `DBK_ENCRYPTION_KEY` for the session anyway.** §6's start command below
generates a fresh one with `openssl rand` on every restart, and 7.2 needed three
restarts (to change the quota and back). An account provisioned under a key you
then lose cannot even be *deleted* through the app, because the delete path
dumps the schema first (§4rr). Writing one `export` line to a file and sourcing
it before each start is the whole fix.

**And do not create one you then cannot remove**: an account provisioned under a
key you no longer have cannot be *deleted* through the app either, because the
deletion path dumps the schema first and `pg_dump --role` needs that password.
§4rr has the finding and the by-hand cleanup. The cheap way to avoid the whole
thing is to pin one key for the session rather than letting `openssl rand`
generate a new one on every restart.

**A throwaway cluster, no Docker and no sudo.** `rm -rf $SP` destroys whatever
is in `/tmp/dbk` — check nothing is still running against it first
(`pg_ctl -D /tmp/dbk/data status`), because deleting a live cluster's data
directory out from under it leaves an orphan postmaster holding port 55432:

```bash
SP=/tmp/dbk && pg_ctl -D $SP/data stop -m fast 2>/dev/null; rm -rf $SP && mkdir -p $SP
initdb -D $SP/data -U postgres --locale=C.UTF-8 --encoding=UTF8 -A trust
pg_ctl -D $SP/data -o "-p 55432 -k /tmp -c listen_addresses=127.0.0.1 \
  -c temp_file_limit=256MB" -l $SP/pg.log start
PGHOST=127.0.0.1 PGPORT=55432 POSTGRES_USER=postgres \
  DBK_APP_DB_PASSWORD=secret bash db/init/00-bootstrap.sh
```

Then, from `app/`:

```bash
# the live suites (provisioning, the runner + watchdog, the schema browser,
# CSV import, 5b's cold storage, and 9's exercise workspaces). TZ matters — two
# cases in query.live.test.mjs only fail under a non-UTC zone (§4l).
PGHOST=127.0.0.1 PGPORT=55432 DBK_APP_DB_PASSWORD=secret TZ=Europe/Zurich \
  node --test test/*.live.test.mjs

# `npm test` already passes --test-concurrency=1 (§4xx (4)); without it the
# suite peaks at 9.4 GB. Drop the flag only if you know why you want to.

# one suite on its own, which is what you want while working on it
PGHOST=127.0.0.1 PGPORT=55432 DBK_APP_DB_PASSWORD=secret TZ=Europe/Zurich \
  node --test test/lifecycle.live.test.mjs

# the app itself
PGHOST=127.0.0.1 PGPORT=55432 DBK_APP_DB_PASSWORD=secret \
  DBK_SESSION_SECRET=$(openssl rand -base64 36) \
  DBK_ENCRYPTION_KEY=$(openssl rand -base64 32) \
  DBK_BOOTSTRAP_ADMIN_PASSWORD=admin-start-1234 \
  DBK_ARCHIVE_DIR_CONTAINER=/tmp/dbk/archive \
  PORT=3111 node dist/server.js
```

Add these two **together** when working on the roster's credential slips — the
address printed on a slip is `DBK_PUBLIC_URL`, so the default
`http://localhost:3000` is what you will otherwise be looking at:

```bash
  DBK_PUBLIC_URL=https://datebaenkli.schaffner.xyz \
  DBK_COOKIE_SECURE=false \
```

Together, because the second is what keeps the first usable over plain http:
`cookieSecure` is derived from the URL's scheme, so `https://` alone issues a
`Secure` cookie the browser will not send back and every request after login is
`unauthenticated` (§4bb). The override is for local http **only**.

`DBK_ARCHIVE_DIR_CONTAINER` matters locally: it defaults to
`/var/lib/datebaenkli/archive`, which does not exist on the dev machine, and a
deletion correctly refuses to drop a schema it could not dump.

`db/backup.sh` normally reaches the database through `docker exec`. Set
`DBK_DB_EXEC=` (empty, not unset) to point it at a local client instead — that
is how it is exercised against the throwaway cluster:

```bash
DBK_DB_EXEC= PGHOST=127.0.0.1 PGPORT=55432 PGUSER=postgres \
  DBK_BACKUP_DIR=/tmp/dbk/backups DBK_BACKUP_ENV=0 bash db/backup.sh
DBK_BACKUP_DIR=/tmp/dbk/backups bash db/backup.sh --check
```

Then log in once and change the password, and:

```bash
DBK_PGPORT=55432 DBK_APP_DB_PASSWORD=secret bash db/verify-isolation.sh
curl -sX POST localhost:3111/api/login -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin-start-1234"}' -c /tmp/cj
curl -sX POST localhost:3111/api/me/password -H 'Content-Type: application/json' -b /tmp/cj \
  -d '{"currentPassword":"admin-start-1234","newPassword":"admin-neu-12345"}'
DBK_BASE_URL=http://127.0.0.1:3111 DBK_ADMIN_PASSWORD=admin-neu-12345 bash db/verify-auth.sh
```

**Docker on the dev machine is installed but not usable**, which is why the
compose stack is still unverified. Two things are missing, both needing sudo:

```bash
sudo pacman -S docker-compose     # the compose v2 plugin is not installed
sudo usermod -aG docker $USER     # then log out and back in
```

The second grants root-equivalent access to your user, so it is your call.

---

## 7. Deploying — the runbook, as it actually went

Three runs, all on 2026-07-28: the first bring-up, phase 5b's migration, and
phase 6a+6b. Kept because the next deploy is one of these three shapes, and
because several things below were not obvious any of the times.

**The 6a+6b subsection comes first, because it is the shape most deploys will
have**: application code only, no schema change. It is also the cheapest to get
right and the easiest to over-ceremonialise by reaching for the migration
runbook below, which is a heavier procedure than a code-only deploy needs.
**Phase 7.2 is that shape** — no migration, one route field, four front-end
files and two shell scripts that do not ship in the image at all.

### The phase 9 migration — run on 2026-08-07, and it was uneventful

**Done.** Kept because it is the *second* migration this project has done and it
confirms that the 5b runbook below generalises — which is worth knowing, since
one data point is not a procedure.

`meta/003_exercises.sql` is heavier than 002: it **drops** four columns from
`exercise`, two from `submission` and one type, and creates two tables and six
indexes. All of it instant, all of it under the migration advisory lock at boot.
The order, which is 5b's with one addition:

1. **`curl /api/version` first**, before anything else. It is how we found out
   that this file's front matter had been wrong for a week: it claimed `0.8.0`,
   production served `0.8.1`. Two minutes, and it changes what "one release
   behind" means.
2. **`db/backup.sh` and `--check`.** Unchanged from 5b, and more load-bearing
   here because this migration drops columns.
3. **The new one: prove the tables the drop touches are empty.** A dropped
   column does not come back with an image rollback.

   ```bash
   docker exec datebaenkli-db psql -U postgres -d datebaenkli_meta -tAc \
     "SELECT (SELECT count(*) FROM exercise) + (SELECT count(*) FROM submission)"
   ```

   It returned `0`, as it must for an instance where the v2 stub was never
   written to. **Fold it into the deploy rather than eyeballing it** — the
   command that was actually run guards the pull on it, so a non-zero count
   aborts before `git pull`:

   ```bash
   N=$(docker exec datebaenkli-db psql -U postgres -d datebaenkli_meta -tAc \
        "SELECT (SELECT count(*) FROM exercise) + (SELECT count(*) FROM submission)") \
     && [ "$N" = "0" ] && git pull && docker compose build datebaenkli-app \
     && docker compose up -d || echo "ABORTED"
   ```
4. **The suite in a throwaway container, before swapping the image** — but
   **without** `DBK_APP_DB_PASSWORD` and **without** the live suites, which is a
   deliberate departure from 5b's version below. That version points the live
   suites at the production teaching database, and its own warning says to run it
   "before any real class exists". A real class exists now. What was run instead
   still gets the PostgreSQL 17 coverage that is the point of the step, and
   writes to no database at all:

   ```bash
   docker run --rm --network datebaenkli_datebaenkli_internal -e TZ=Europe/Zurich \
     node:22-alpine sh -c '
       apk add --no-cache git postgresql17-client tzdata >/dev/null &&
       git clone -q https://github.com/SCP-KWI/Datebaenkli.git /s &&
       cd /s/app && npm ci --silent && npm run build &&
       node --test --test-concurrency=1 $(ls test/*.test.mjs | grep -v live)'
   ```

   `fail 0`, `skipped 0`, 311 tests, ~177 s. **`--test-concurrency=1` matters
   here too** (§4xx (4)) — the parallel form peaks at 9.4 GB, which is not a
   thing to discover on a small server.

**Version bumped on the dev machine before the pull**, as 5b established:
`npm version minor --no-git-tag-version`, `0.8.1` → `0.9.0`, committed and
pushed. One minor per phase.

**Nothing needed adding to `.env`.** Phase 9 introduced no configuration at all —
checked with `git diff` over `config.ts`, `.env.example` and
`docker-compose.yml` before the deploy rather than discovered at boot.

**The verification, in the order it actually settles things:**

```
curl -s https://datebaenkli.schaffner.xyz/api/version
  {"version":"0.9.0","builtAt":"2026-08-07T08:23:14Z"}   # BOTH fields moved
```

then the boot log for `applied migration 003_exercises.sql`, and then — the part
that is not tidiness — **`docker compose restart datebaenkli-app`**, whose second
boot said:

```
migrations: meta 0 applied / 3 current, teach 0 applied / 2 current
```

`meta 0 applied / 3 current` is the checksum ledger holding: the migration ran
once, its checksum matches, and a third boot would do nothing. `up -d` does
**not** give you this — it reports `Running` and changes nothing.

**What did not need saying this time, and did last time:** nothing went wrong.
No `up` without `build` (§4vv), no missing file in the image (§4ss), no surprise
in `.env`. The runbook below is what made that true, and the only edits it needed
were the two above — the empty-table guard, and not pointing the live suites at a
database with a real class in it.

### Deploying 7.2 + 8 + 8.1 — the attempt that did not take, and the re-run

**A deploy was run on 2026-07-30 and production did not change.** §4vv has the
evidence. The most likely cause is `docker compose up -d` without a preceding
`build`, or with one whose output was not checked: `up -d` reports `Running` and
changes nothing when the image is unchanged, which is the trap this file has
warned about since the first bring-up.

Code-only, no migration, no new environment variable. On the box:

```bash
# --- PRODUCTION, on the server -----------------------------------------
cd /opt/apps/datebaenkli
git pull                                     # expect 9ca70a4 or later
docker compose build datebaenkli-app         # NOT optional — this is the step
docker compose up -d --force-recreate datebaenkli-app
```

`--force-recreate` because that is precisely what was missing: without it, a
container already running from an older image is left alone.

**Then verify, and verify what the container serves rather than what the build
said.** Do not look for `build stamped …` in the build output — BuildKit hides
it on success (§4ss).

```bash
# --- PRODUCTION -------------------------------------------------------------
curl -s https://datebaenkli.schaffner.xyz/api/version
#   expect {"version":"0.8.0","builtAt":"<today>"} — BOTH fields must move.
#   0.7.0 means the old image is still running.

curl -s https://datebaenkli.schaffner.xyz/assets/app.css   | grep -c '#quota'
#   expect 4 — phase 7.2's quota line. 0 means the assets are stale.
curl -s https://datebaenkli.schaffner.xyz/assets/roster.js | grep -c 'data-delete'
#   expect 2 — phase 7.3's delete button.
```

Those two greps are the lesson of §4vv: `builtAt` alone was enough to catch it
this time only because it happened to be unchanged from the day before. **An
asset that contains a string the previous release did not is the check that
cannot be fooled**, and it costs one curl.

The boot log should read `meta 0 applied / 2 current, teach 0 applied / 2
current` — a non-zero applied count on a code-only deploy means something is on
the branch you have not read. And **`Server listening` now comes *before*
`reconcile:`**, which is 8.1's change (§4vv, item 4) and not a fault.

### ~~Is the server holding leaked roles?~~ — asked and answered, kept for the method

**Run on 2026-07-30. The answer was `t_schaffner` and nothing else, and it is
the author's own teacher account** — so there is nothing to clean up and no
reason to run this again. It is kept because the *shape* recurs: when a name on
the production cluster might be either a fixture or a person, `pg_roles` cannot
tell you and `datebaenkli_meta.app_user` can. Both queries are read-only.

It also produced the more important finding, which was not what it was looking
for: see §4tt. The lesson is that "did this script leave something behind" and
"would this script destroy something" are different questions, and only the
second one mattered.

```bash
# --- PRODUCTION, on the server -----------------------------------------
cd /opt/apps/datebaenkli
docker compose exec -T datebaenkli-db psql -U dbk_app -d datebaenkli -Atc "
  SELECT rolname FROM pg_roles
   WHERE rolname IN ('u_k3a_muster_lena','u_k3a_meier_tim','t_schaffner','u_test')
   ORDER BY 1"
```

Nothing printed is the good answer and closes §5's bullet. If a name *is*
printed, **do not drop it yet** — `u_k3a_muster_lena` and `t_schaffner` are
exactly the shape `/roster` produces, so the next question is whether the row is
a real account or the script's leftover:

```bash
# --- PRODUCTION, only if the query above printed something ------------------
docker compose exec -T datebaenkli-db psql -U dbk_app -d datebaenkli_meta -Atc "
  SELECT username, role, state FROM app_user
   WHERE username IN ('u_k3a_muster_lena','u_k3a_meier_tim','t_schaffner','u_test')"
```

A role in `pg_roles` with **no** matching `app_user` row is the leftover. One
with a row is a real person and must be left alone. Removing a confirmed
leftover is the `DO` block in `verify-isolation.sh`'s `teardown()` — but it is a
destructive change on the production cluster, so it is a decision to take
deliberately and with a backup in hand, not a step in this runbook.

### Phases 6a + 6b — run on 2026-07-28, the first deploy with no migration in it

**Done.** Two phases shipped as one deploy: 6b restructured what 6a built, so
they were never separable. Deployed commit `d4ac149`, which is 6a, 6b and the
`lesson.js` offline guard.

**What made this one cheap was what it did *not* contain.** No migration, so the
database was never at risk and rollback was `git checkout` of the previous
commit plus a rebuild — nothing to undo. No new environment variable either:
`DBK_DEFAULT_LOCALE` is optional and defaults to `'de'` (`config.ts`), which
§4mm says is the intended value for every account. `.env` was not touched.

**The boot log is the whole verification, and the line to read is the one that
did *not* change:**

```
migrations: meta 0 applied / 2 current, teach 0 applied / 2 current
```

`meta 0 applied` is the confirmation. The 5b subsection below reads `meta 1
applied` for the opposite reason — there, the applied count *was* the deploy.
**On a code-only deploy, a non-zero applied count means something is on the
branch you have not read**, and is a reason to stop rather than a curiosity.

**One check here cannot be done in a browser, and it is the one that matters.**

```bash
curl -s -o /dev/null -w "en=%{http_code}\n" \
  https://datebaenkli.schaffner.xyz/assets/i18n-en.js      # 200
```

`i18n-en.js` is the first asset in this app fetched by dynamic import, and
`load()` swallows its absence by design (§4nn) so English silently falls back to
German. **A missing English catalogue is therefore indistinguishable from a
student who never switched languages** — it looks correct in a screenshot, in
the log, and to the teacher. Both catalogues returned 200 on the day. Curl it on
every deploy that touches `src/web`; nothing else will tell you.

**Sign-off followed §4dd, not the page rendering.** A real student logged in,
switched to English, was shown an English 42P01 hint with the raw Postgres line
still beneath it (§4ll), then **closed the browser completely** and logged back
in still in English — which is the `__Host-` cookie and `app_user.locale` round
trip that a local run cannot exercise. The overnight half of that check is in §5
and was still open when this was written.

**What was verified on the dev machine first**, in this order, and it is the
order worth repeating: `npm run build`, `npm run typecheck`, then the full suite
against a live cluster under `TZ=Europe/Zurich` — 307/307 with **0 skipped**,
which is the number that proves the live suites actually ran rather than
silently skipping (§1 explains why the skip count reads 63 and the run count 58).

**One technique from that run is worth keeping.** The `lesson.js` fix has a
branch that only appears when `/api/me` succeeds and `/api/classes` fails at the
transport layer, which no amount of clicking will produce. It was reached by
injecting a `window.fetch` stub into the **built** `dist/web/lesson.html` and
restarting the app — `dist` is gitignored and the next `npm run build` wipes it,
so `src` is never touched and the module under test is unmodified. The restart
is not optional: `routes/pages.ts` reads every page once at boot (§4nn), so
editing a page file without restarting changes nothing.

### The phase 5b migration — run on 2026-07-28, and what it needed

**Done.** Kept because it is the only migration deploy this project has done,
and the next one should follow the same order.

`meta/002_lifecycle.sql` is one `ALTER TABLE … ADD COLUMN` and one `DELETE FROM
setting`, both instant on a table this size, both applied by the app at boot
under the migration advisory lock. The order that mattered:

1. **`db/backup.sh` and `db/backup.sh --check`, first.** A migration is the one
   deploy where rolling the image back does not roll the database back. Last
   night's 03:17 run is not good enough if anything has been created since — and
   after phase 5a, things are created by clicking.
2. **Count the sweep's candidates before the image goes on**, so 03:40 is not a
   surprise. It must use the *short* predicate, because `archive_path` does not
   exist until 002 has run:

   ```bash
   docker exec datebaenkli-db psql -U postgres -d datebaenkli_meta -tAc \
     "SELECT count(*) FROM app_user WHERE role = 'student' AND state = 'active'
        AND coalesce(last_active_at, created_at) < now() - interval '365 days'"
   ```

   It returned `0`, as expected for a July 2026 instance. Anything else wants
   investigating before the timer acts on it.
3. **Run §7's throwaway-container suite before swapping the image**, not after.
   It proves 5b against the server's Postgres 17 and its `postgresql17-client`
   — which is exactly what the restore's `pg_restore --list` parsing depends on
   — while the running image is still the known-good one. It passed 252/252.
4. Then `git pull`, `docker compose build datebaenkli-app`, `up -d`.

**Bump the version before the `git pull`, on the dev machine** (phase 7.1). The
footer shows `package.json`'s version beside the build time, and only the second
half updates itself:

```bash
cd app && npm version minor --no-git-tag-version   # 0.7.0 -> 0.8.0
```

The convention here is one minor per phase. Forgetting is not a disaster — the
build time beside it still identifies the deploy exactly, which is why the two
are shown together (§4qq) — but the version is what a person quotes back to you,
so it is worth the one command. Check it afterwards without logging in:

```bash
curl -s https://datebaenkli.schaffner.xyz/api/version    # {"version":"0.8.0","builtAt":"…Z"}
```

That is also the cheapest possible confirmation that the new build is the one
actually serving: `builtAt` moves on every deploy whether or not anything else
did.

**Do not look for `build stamped …` in the `docker compose build` output.**
`tools/stamp-build.mjs` prints it, but BuildKit's default progress display
collapses a *successful* `RUN` step to one timing line and only expands the log
when the step fails — so the line is there and invisible, and its absence means
nothing. `--progress=plain` shows it if you want to watch. The curl above is the
check, because it reads what the running container is actually serving rather
than what the build said.

**Nothing needed adding to `.env`.** Every 5b variable's default is what the
deployment wants (`DBK_ARCHIVE_AFTER_DAYS=365`, sweep at 03:40,
`DBK_ARCHIVE_SWEEP=true`). `.env.example` documents them for when that stops
being true. `pg_restore` was already in the image — `postgresql17-client`, the
same package that supplies `pg_dump`.

**The boot log, which is the whole verification:**

```
migrations: meta 1 applied / 1 current, teach 0 applied / 2 current
reconcile: 4 accounts checked, nothing to repair
archive sweep armed for 03:40 local, threshold 365 days
Server listening at http://127.0.0.1:3000
```

`meta 1 applied` is the deploy. **Read for the sweep line's presence, not for
the absence of an error** — it is silent when `DBK_ARCHIVE_SWEEP` is false,
which is a supported state. See §4gg for what "local" means there, which is not
what it looks like.

**Restarting afterwards is part of the check, not tidiness.** The second boot
must say `meta 0 applied / 2 current` (the checksum ledger holding) and
`reconcile: N accounts checked, nothing to repair` **after** the cold/restore
drill. A restored account that reconcile still wants to touch is precisely the
state §4ff says nothing repairs, and this is the cheapest place to catch it.
`docker compose up -d` does **not** do this — it reports `Running` and changes
nothing. Use `docker compose restart datebaenkli-app`.

#### Driving one real account through cold and back

§4dd's rule applies to a deployment as much as to a suite: nothing weaker than
the student herself reading her own rows proves a restore. `provisioning.ok:
true` is not the end of it. Admin-only and curl-only by design (§8).

```bash
BASE=https://datebaenkli.schaffner.xyz
curl -s -c /tmp/admin.cj -X POST $BASE/api/login -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"…"}'
curl -s -b /tmp/admin.cj $BASE/api/students                      # pick id + username

# a fresh slip password — the printed one is spent anyway
curl -s -b /tmp/admin.cj -X POST $BASE/api/students/$SID/password \
  -H 'Content-Type: application/json' | grep -o '"password":"[^"]*"'

# as her: write something. Then PATCH state to cold, then back to active.
curl -s -b /tmp/admin.cj -X PATCH $BASE/api/students/$SID/state \
  -H 'Content-Type: application/json' -d '{"state":"cold"}'
```

Between the two PATCHes, confirm the drop actually happened — otherwise the
restore is proving nothing:

```bash
docker exec datebaenkli-db psql -U postgres -d datebaenkli -tAc \
  "SELECT count(*) FROM pg_namespace WHERE nspname='$PGROLE'"     # 0
docker exec datebaenkli-db psql -U postgres -d datebaenkli -tAc \
  "SELECT rolcanlogin FROM pg_roles WHERE rolname='$PGROLE'"      # f — role KEPT
```

and that her login is refused (`401 invalid_credentials` — `authenticate`
filters on `state = 'active'`, so a cold student never reaches Postgres). Then
restore, log in **as her**, and `SELECT`. On the 2026-07-28 run: cold took
1241 ms, the restore 129 ms, and the rows came back. Afterwards `archive_path`
is empty and the dump file is still on disk — the row stops pointing at it, the
file stays as history.

Reading `pg_tables` for her schema afterwards must be done as `postgres`, not
`dbk_app`: `dbk_app` holds her role NOINHERIT and would report an empty schema
for a full one. That is §4a's second disguise (§4o) turning up in a check
written to verify §4a's fifth.

#### Two runbook traps, and they are the same trap

Both are a command that appears to succeed while silently discarding the only
copy of something.

- **`docker exec` needs `-i` for a heredoc** — without it psql reads EOF and
  does nothing. That one discards the *input*.
- **Never put a truncating filter between `curl` and your eyes on the one call
  that mints a one-time secret.** `POST /api/students/:id/password` piped
  through `head -c 300` cut the response off inside the key `"password` — and a
  slip password exists exactly once, in the body of the response that created it
  (§4bb, `roster.js`'s header). The reset had happened; the plaintext was gone.
  Use `grep -o '"password":"[^"]*"'`, not a byte count, which is a guess that
  goes stale the next time a column is added to the user shape.

Also: every state-changing `/api` call needs `Content-Type: application/json`
**even when it sends no body**. That header is the CSRF control (`server.ts`),
not a formality, and a bodiless `POST` without it is a 415 `json_required`. The
parser turns an empty body into `{}`, so the header alone is enough.

### The first bring-up — run on 2026-07-28, for a rebuild or a second instance

**Order matters.** Database alone first, *then* the app: `00-bootstrap.sh` runs
only on an empty data directory, and a half-failed run must be recovered with
`docker compose down && sudo rm -rf pgdata`, not by re-running `up`. That is
cheap only while there is no data.

```bash
sudo mkdir -p /opt/apps/datebaenkli
sudo chown "$USER":"$USER" /opt/apps/datebaenkli
cd /opt/apps/datebaenkli
git clone https://github.com/SCP-KWI/Datebaenkli.git .   # main; see the top of this file

# dumps live on the bulk disk; uid 1000 is the container's `node` user, and a
# deletion refuses to drop a schema it could not dump.
sudo mkdir -p /mnt/bulk/datebaenkli/{backups,archive}
sudo chown -R 1000:1000 /mnt/bulk/datebaenkli

cp .env.example .env
for k in POSTGRES_PASSWORD DBK_APP_DB_PASSWORD DBK_SESSION_SECRET DBK_ENCRYPTION_KEY; do
  sed -i "s|^$k=.*|$k=$(openssl rand -base64 32)|" .env
done
sed -i "s|^DBK_BOOTSTRAP_ADMIN_PASSWORD=.*|DBK_BOOTSTRAP_ADMIN_PASSWORD=$(openssl rand -base64 18)|" .env
sed -i 's|^DBK_COOKIE_SECURE=.*|DBK_COOKIE_SECURE=false|' .env   # see below

# check nothing is blank; `grep -c '=$'` does NOT work — base64 padding ends in '='
grep -cE '^[A-Z_]+=$' .env                                   # expect 0
sed -n 's/^DBK_ENCRYPTION_KEY=//p' .env | base64 -d | wc -c   # expect 32

docker compose build datebaenkli-app
docker compose up -d datebaenkli-db && sleep 20
docker inspect --format '{{.State.Health.Status}}' datebaenkli-db   # healthy
docker compose up -d datebaenkli-app
```

**Success looks like** the migration lines, the admin-created warning, then
`reconcile: 0 accounts checked, nothing to repair` and `Server listening`.

**Verify the bootstrap rather than trusting a clean exit.** These four lines are
the whole security model, and a wrong answer here invalidates everything after:

```bash
docker exec datebaenkli-db psql -U postgres -d datebaenkli -tAc \
  "SELECT rolname||' createrole='||rolcreaterole||' super='||rolsuper FROM pg_roles WHERE rolname='dbk_app'"
docker exec datebaenkli-db psql -U postgres -d datebaenkli -tAc \
  "SELECT has_database_privilege('public','datebaenkli_meta','CONNECT')"
```

`super=false` and `CONNECT=false` are the ones to stop for. A superuser
`dbk_app` would make every grant *appear* to work while removing the boundary.

**Four things that were not obvious:**

1. **`docker exec` needs `-i` for a heredoc.** Without it psql gets EOF and
   silently does nothing — the command appears to succeed and changes nothing.
   Prefer repeated `-c` flags, which need no stdin at all.
2. **There is no node on the server, and `verify-auth.sh` requires it** (§4w).
   Run it, and the test suites, from a throwaway container. `tzdata` is
   load-bearing in that container — Alpine without it silently resolves
   `TZ=Europe/Zurich` to UTC and two date assertions pass vacuously (§4l).
3. **Keep the TLS-less phase on loopback.** §7 used to say "reverse-proxy host
   without SSL first", which is right — it separates "does the app work" from
   "does TLS work" — but as written it sends the admin password across the
   public internet in cleartext. Add `127.0.0.1 <domain>` to `/etc/hosts` on the
   server for the duration: the proxy still routes by `Host` header, `verify-auth.sh`
   runs unmodified, DNS propagation stops mattering, and nothing leaves the box.
   Remove the line before requesting the certificate.
4. **`DBK_COOKIE_SECURE=false` only for that phase**, then back to blank. Blank
   means "infer from `DBK_PUBLIC_URL`", which is https. A `Secure` cookie over
   plain http is silently discarded, so every login appears to succeed and the
   next request is a 401 with nothing in the logs.

```bash
# --- with a cluster up, from a throwaway container: the whole tree ----------
# It was 252 at the 5b deploy and is 290 now; check `fail 0` and `skipped 0`
# rather than a number this comment will keep going stale on.
# Any non-zero `skipped` means it never reached the database and every live
# suite opted out silently — the one way this command looks like a pass and is
# not. It is `skipped 63` on the current tree; check the number, not the colour.
# §4ii: suspect DBK_APP_DB_PASSWORD before suspecting the server.
docker run --rm --network datebaenkli_datebaenkli_internal \
  -e PGHOST=datebaenkli-db -e PGPORT=5432 \
  -e DBK_APP_DB_PASSWORD="$(sed -n 's/^DBK_APP_DB_PASSWORD=//p' .env)" \
  -e DBK_ARCHIVE_DIR_CONTAINER=/tmp/archive -e TZ=Europe/Zurich \
  node:22-alpine sh -c '
    apk add --no-cache git postgresql17-client tzdata >/dev/null &&
    git clone -q https://github.com/SCP-KWI/Datebaenkli.git /s &&
    cd /s/app && npm ci --silent && npm test'

# --- the 88 HTTP checks, through the proxy ---------------------------------
docker run --rm --network host --add-host <domain>:127.0.0.1 \
  -v /opt/apps/datebaenkli:/repo -w /repo \
  -e DBK_BASE_URL=http://<domain> -e DBK_ADMIN_PASSWORD="$NEWPW" \
  node:22-alpine sh -c 'apk add --no-cache bash curl >/dev/null && bash db/verify-auth.sh'
```

**Both of those write into the real teaching database** — they provision and
drop actual roles. Run them before any real class exists, and check for leftover
`^[ut]_` roles afterwards; §4u is what happens when a teardown fails quietly.

**Then the reverse proxy**: proxy host → scheme `http`, forward hostname `datebaenkli-app`,
port `3000`. The container name resolves because the app joined
the proxy network; neither service publishes a port, so the stack
cannot collide with anything else on the host. Request the certificate, enable
Force SSL and HTTP/2, leave HSTS off. Then blank `DBK_COOKIE_SECURE`, blank
`DBK_BOOTSTRAP_ADMIN_PASSWORD`, and `docker compose up -d`.

### The ICU collation recreate — done, and deliberately not kept as a runbook

**Run once, on 2026-07-28, and there is nothing left here to run.** The deployed
databases were created before the collation change; a database's collation
cannot be altered, so adopting it meant `docker compose down`, `rm -rf pgdata`
and letting `00-bootstrap.sh` run again on an empty directory. That was free
because nothing was in it but the bootstrap admin. It went exactly as written,
and the four verifications below all answered correctly.

The step-by-step commands **have been deleted from this document on purpose.**
They are `rm -rf` against a live database, they are now useless — the deployed
cluster already has the collation, and a future rebuild gets it from the normal
§7 deploy path — and a spent destructive runbook sitting in a handoff file is a
loaded gun aimed at whoever reads it next in a hurry. If a cluster ever again
needs the collation it does not have, the answer is the restore procedure below,
not this.

What the recreate confirmed, and what to check after any rebuild:

```bash
docker exec datebaenkli-db psql -U postgres -c \
  "SELECT datname, datlocprovider::text AS prov, datlocale, datcollate, datctype
     FROM pg_database WHERE datname LIKE 'datebaenkli%'"
docker exec datebaenkli-db psql -U postgres -d datebaenkli -tAc "SELECT upper('straße')"
```

Expect `prov = i` and `datlocale = de-CH` on both databases, and `STRASSE`.

Three things that line teaches, none of them obvious:

- **`datlocprovider` is `"char"`, not `text`.** This document previously wrote
  `datname||' '||datlocprovider||' '||datlocale`, which fails with `operator is
  not unique: text || "char"`. It had never been executed. `db/backup.sh` had it
  right (`datlocprovider::text`) because that one *runs*, every night — a check
  written into a script gets tested by being used; a check written into prose
  does not.
- **`datcollate` and `datctype` stay behind, asymmetrically**, and that is
  correct. On the server they read `C` and `C.UTF-8` respectively: musl accepts
  `C.UTF-8` for one and settles on `C` for the other, and both are inherited
  from `template0` because `00-bootstrap.sh` deliberately does not state them
  (§4x). Under an ICU provider neither decides sort order. Do not "fix" them.
- **`upper('straße')` is the check worth adding**, because it proves ICU took
  over *ctype* and not merely collation. PostgreSQL 17 routes both through ICU;
  16 would not. `STRAßE` would mean half the change landed.

### Backups — install

**Installed on the server 2026-07-28**, in `pip`'s crontab. This is the
procedure as it actually ran, including the two things that were not in the
first draft of it.

`db/backup.sh` runs on the host and needs neither a password nor a postgres
client (§4y and the script's header explain why). Install:

```bash
cd /opt/apps/datebaenkli
id -u                                          # must own /mnt/bulk/datebaenkli — see below
db/backup.sh                                   # once, by hand, and read the output
cat /mnt/bulk/datebaenkli/backups/latest/MANIFEST

# the redirect target must exist and be writable BEFORE the first nightly run
sudo install -m 644 -o "$USER" -g "$USER" /dev/null /var/log/dbk-backup.log

crontab -e
# nightly at 03:17; flock so a slow run can never overlap the next one
17 3 * * * flock -n /tmp/dbk-backup.lock /opt/apps/datebaenkli/db/backup.sh >> /var/log/dbk-backup.log 2>&1
```

Then prove the cron line rather than the script — they fail differently:

```bash
crontab -l                                     # the line, verbatim
command -v docker flock                        # both /usr/bin; cron's PATH is short
flock -n /tmp/dbk-backup.lock /opt/apps/datebaenkli/db/backup.sh \
  >> /var/log/dbk-backup.log 2>&1; echo "exit=$?"
tail -2 /var/log/dbk-backup.log                # "backup ok:", in the file
```

**The crontab must belong to the user that owns `/mnt/bulk/datebaenkli` and can
run `docker` without `sudo`.** Both halves bite:

- The script does `chmod 700` on the backup directory, which `§7`'s deploy
  chowned to `1000:1000`. A different uid fails there, before a single dump.
- Nothing in the backup path can prompt for a password (that is the whole design,
  §4y), and cron gives it nowhere to prompt.

**`/var/log/dbk-backup.log` has to be created first.** `/var/log` is root-owned,
a user crontab cannot create a file there, and the shell evaluates the redirect
*before* running the command — so the nightly run dies before `backup.sh`
starts, writing nothing, anywhere. That is the same silent-timer failure mode
`--check` exists to catch, arriving a step earlier than expected.

Then point something at `db/backup.sh --check`, which exits non-zero when the
newest *published* backup is older than 26 h. The way scheduled backups fail is
not a crash, it is a timer that stopped months ago and a directory that still
looks full.

Note the run directory contains a copy of `.env`. That is deliberate (§4y) and
it makes `/mnt/bulk/datebaenkli/backups` as sensitive as the secrets themselves;
it is created `0700`. `DBK_BACKUP_ENV=0` turns it off.

### Backups — restoring, which is the only thing that proves them

Drilled locally end to end (§5). Into a **fresh, empty** cluster:

```bash
B=/mnt/bulk/datebaenkli/backups/latest

# 1. an empty data directory, so 00-bootstrap.sh runs and creates dbk_app plus
#    both databases with the right collation. Do NOT start the app yet.
docker compose down && sudo rm -rf pgdata
cp $B/env .env                                  # DBK_ENCRYPTION_KEY, above all
docker compose up -d datebaenkli-db && sleep 20

# 2. roles. `dbk_app` and `postgres` already exist — those two errors are the
#    expected output, and are why this does not use ON_ERROR_STOP.
docker exec -i -u postgres datebaenkli-db psql -d postgres < $B/globals.sql

# 3. the data
docker exec -i -u postgres datebaenkli-db \
  pg_restore --clean --if-exists -d datebaenkli_meta < $B/meta.dump
docker exec -i -u postgres datebaenkli-db \
  pg_restore --clean --if-exists -d datebaenkli      < $B/teach.dump

# 4. now the app. Watch for "reconcile: … nothing to repair" — reconcile is what
#    fixes any drift between the two dumps, which were not taken atomically.
docker compose up -d datebaenkli-app && docker logs -f datebaenkli-app
```

`docker exec -i` throughout, including the `pg_restore`s: without `-i` they read
EOF and succeed at nothing (§7's first trap, and this is where it would hurt).

If the app logs `reconcile failed … unable to authenticate data`, the `.env` you
restored is not the one the dump was taken with. Stop and find the right one —
§4y says what that costs.

**Expect `N database connect grants restored` in the reconcile line**, where N
is every `^[ut]_` account. That is not a fault; it is §4dd being repaired.
`pg_database.datacl` is in neither dump, so a restore always lands with no
student able to connect and the reconciler always fixes it on the first boot.
A restart after that should report `nothing to repair`; if it restores grants
again, something is revoking them and that is a new bug.

**Then the only check that proves the restore.** Do this before writing the
drill off as successful:

> log in as a **student**, with a printed slip, and run a `SELECT`.

Admin login proves nothing — account passwords are scrypt hashes and survive
both a wrong `DBK_ENCRYPTION_KEY` (§4y) and a missing CONNECT grant (§4dd)
perfectly. Only a student's query opens a connection *as* them, which is the
path that decrypts `pg_password_enc` and needs the database grant. Both of the
two ways a restore has actually failed here were invisible to every check above
this line.

Worth writing down separately, because the diagnosis cost more than the fix: the
student sees **"Your previous query is still running"** when this is wrong.
`pool.connect()` failing is reported as `too_many_queries`, which is a guess.
The driver's real message is in the app log — `grep 'could not get a connection'`
— and it said `permission denied for database`.

---

## 8. Next session should

**Nothing is outstanding in the code.** Phase 9 is built, tested, deployed and in
step with the server. What follows is a menu, and only the first item has a
deadline shape.

**1. Use it in a lesson, and close §5's production gap while you are there.**
The one thing neither the suites nor the deploy can establish is what happens
when a class touches it. The gap is narrow and named: on production only *one*
student account has opened an exercise, so the isolation claim is carried by the
tests and the local run rather than by an observation on the server. It costs
nothing to close — two students in one class, one deleting rows, the other
pressing refresh. Take-back has also never run against a real class, and it is
the destructive one.

**2. `db/prune-archive.sh` into cron.** Three deploys old now; §4vv has the line,
including the `/var/log` file that has to exist before the first run.

**3. The PGlite instances that are never closed** (§4xx (4)).
`--test-concurrency=1` caps the suite at 4.5 GB and is in `package.json`; the
cause is untouched. Closing it touches every test file — a session of its own,
and the kind of change that should not ride along inside a feature.

**The teacher handbook has an exercises chapter, and it has no picture.**
`docs/handbook-src/handbuch.src.html` gained chapter 10 ("Übungen verteilen und
einsammeln") and the four chapters after it renumbered; `node build.mjs` was run
and `check.mjs` passes. The chapter is **text-only**: the figures come from
`shots.mjs` driving the real app with Puppeteer, and there is no run for
`/uebungen` yet. A missing figure is more honest than an invented one, and
`handbook-src/README.md` now says which two shots would fill it.

**Recorded as a decision, not a gap: the schema browser shows an exercise
workspace by its title, and the real schema name only in a tooltip.** Asked and
answered on 2026-08-07 — the author looked at it after the deploy and chose to
leave it as it is.

The argument for leaving it: inside an exercise a student never needs the name,
because `search_path` is the workspace and unqualified names resolve there.
Clicking a table in the tree writes the fully-qualified
`SELECT * FROM x3_u_k3a_muster_lena.kantone LIMIT 50;` into the editor, so on the
path anyone actually takes the name arrives already typed.

The argument against, written down so it is not rediscovered from scratch: **a
tooltip needs a pointer.** There is no hover on a tablet, and below 820px the
schema browser is hidden outright — so a student wanting the qualified name in
order to join exercise data against their own playground has no route to it on a
phone. If it comes up in a lesson, the fix is a small monospace line under the
label in `renderTree()` plus one CSS rule: no new concepts, a slightly noisier
tree.

**Phase 9 leaves nothing else half-finished.** The one thing it found and did not
fix properly is `npm test`'s memory footprint: `--test-concurrency=1` is in
`package.json` and caps the peak at 4.5 GB, but the underlying cause — PGlite
instances that are never closed — is still there (§4xx (4)).

**Older, and still true:** the first attempt at 7.2+8 did not replace the
container (§4vv) — read that before any deploy, because `up -d` succeeding proves
nothing and one curl for a string the previous release did not contain is what
settles it.

**Nothing has to happen before starting: 7.2 through 7.5 are deployed** and the
repo and the server are in step. The first attempt did not replace the container
(§4vv) — read that before the next deploy, because `up -d` succeeding proves
nothing.

The two checks that used to sit here are both closed: the overnight locale check
**passed** (a student came back to an expired session still in English, which
confirms §4mm), and the production role question was answered — `t_schaffner` is
the author's own account, nothing leaked, nothing to clean up. What that second
one turned up instead is §4tt, fixed in this same tree.

**Work on `main` now.** That changed on 2026-07-29; the top of this file says
why, and `phase-0-foundation` is historical.

§5 and §7 record every run. What follows is a menu, not a queue.

0. **6a and 6b are deployed** (2026-07-28, commit `d4ac149`, together with the
   `lesson.js` offline guard). §7's first subsection is how it went and what to
   repeat; the short version is that a code-only deploy is proven by `meta 0
   applied`, by curling `/assets/i18n-en.js` for a 200, and by a real student
   switching language and coming back to it — not by a page rendering.

   **Its one loose end is still open, and has now survived two deploys**: §5's
   overnight locale check. That is not neglect — it needs twelve *untouched*
   hours, and both intervening evenings were spent testing the app, which
   refreshes the very session the check depends on expiring. §5 now states the
   condition precisely so it does not have to be re-derived a third time.

   **The three decisions §8.0 used to pose are now §4mm.** They were taken, two
   of them against ARCHITECTURE §8a's recommendation. §4nn has the four
   non-obvious things about the plumbing; §4oo now records the two `lesson.js`
   bugs as **fixed**, and the third thing the fix turned up — a `?? []` that made
   the guarded version state something false about the account — is the part of
   that note worth reading.

   Two things 6b did **not** do, both deliberate and both cheap when wanted:

   - **No `class.default_locale` and no locale select on the roster form.** An
     immersion class is switched by hand this term. The form-select version is
     zero backend work — the route and the service already take a per-student
     `locale`.
   - ~~**No hint layer on the CSV import's failure pane.**~~ **Done in 7.2**
     (§4tt). It was as cheap as advertised; what was not anticipated is that the
     pane's characteristic error, `2BP01`, had no handler, so the layer would
     barely have fired without one. Adding it is the part worth reading.

**Phase 7 — the Chalk pass — is BUILT** (2026-07-29). ARCHITECTURE §10 (13) has
the four decisions inside it and §4pp has what it turned up. What it deliberately
did **not** do, so that the next session has it as a choice rather than a
surprise:

- ~~**Items 2 and 5 below**~~ — **done in phase 7.3**, and taken as one problem
  exactly as this bullet asked. Phase 7 was right to leave them: the hard part
  was a confirmation flow proportionate to dropping a term's work, and it needed
  a decision about *weight* (one dialog for the reversible action, two for the
  irreversible one) that a styling pass would have got half-made. §4uu.
- ~~**Item 6, the quota shown to the student**~~ and ~~**item 0, the hint layer
  on the CSV pane**~~ — **both done in 7.2** (§4tt). The prediction that item 6
  was "not in that group at all" held: it was read-only display and took no
  design decisions beyond which token to colour it with.
- **`chalk-tokens.css` carries six accents and ARCHITECTURE §8 no longer claims
  to inventory every app's hue** — the entries that could be checked were wrong,
  so the table went rather than being restated. **Syncing this file back out is
  now overdue rather than merely available**: §4ww darkened all six accents for
  WCAG AA, so until it is copied, every repo still on the old values is shipping
  primary buttons at 2.5–2.9:1.
- ~~**No phone or non-Chromium pass**~~ — **both done 2026-07-30** by the
  author: Zen (Gecko) on the desktop and a phone pass in Vanadium, no problems
  found. See §5 for the one distinction worth keeping.

~~**White on the violet accent measures 2.9:1**~~ — **fixed 2026-07-30 (§4ww),
and it was never just the violet.** `--accent` is a per-app alias and all six
solids in `chalk-tokens.css` sat at L 0.68–0.705, so white failed on every one
of them. The author chose to darken rather than change the foreground, which
keeps Chalk §7's white-on-accent pattern; all six moved, hue and chroma
untouched, each to the lightest L at which white still clears 4.5. Datebänkli
is `oklch(0.578 0.100 300)` now and measures **4.50 in both modes**.

The same change fixed `--accent`-as-text on light paper (2.8 → 4.4) and broke it
on dark (5.9 → 3.7), which is why `a:hover` underlines instead of recolouring.
§4ww has every measurement and the per-hue table.

**Any repo consuming this file is now behind it**, and its buttons stay at
2.5–2.9 until `chalk-design-system/chalk-tokens.css` is synced out.

The numbered list below is the rest, and it is a menu rather than a queue.

1. ~~**Confirm the first sweep actually fired**~~ — **done in 8.1** (§4vv). It
   fired at the armed minute on a throwaway cluster with the hour, minute and
   threshold set by environment variable, archived exactly the two backdated
   students and left the control alone. The re-arm remains unobserved and
   cannot be seen in under 24 h; §4vv says why that was left rather than
   instrumented.

2. ~~**One piece of 5b deliberately left undone**~~ — **done in phase 7.3**
   (§4uu), together with item 5 below, because they were one problem.

   - ~~**No UI for cold storage.**~~ `state: 'cold'` now has an admin-only
     "Auslagern" button, confirmed once because it is reversible. The
     observation that the reverse direction already had a button turned out to
     be the useful one: it is what made a *single* confirm the right weight
     here, and it is what the confirmation text now promises.

   The second item here — the copy-pasted `asUser` and role-dropping teardown —
   **is done**, on 2026-07-28. `test/support/live-pg.mjs` now holds the
   coordinates, the server probe, `liveSuite()`, `asUser`/`tryAsUser` and
   `dropRoles`; the five suites lost 355 lines between them and the test count
   was unchanged by it (252 before and after; phase 6a then added 38). §4ii is
   what the hoist found, and the short version is that
   three of the five had no leak assertion at all. A new live suite should call
   `liveSuite()` and `dropRoles()` rather than writing either again.

3. ~~**Two small things the deploy turned up**~~ — **both settled** (§4vv). One
   `TZ` question remains open below, but nothing depends on the answer now.

   - ~~**Decide what `TZ` the container should run in, then set it or reword the
     log.**~~ The log is fixed: it prints the zone it actually resolved, so it
     reads `03:40 UTC` in the container and `03:40 Europe/Zurich` on the dev
     machine, and is true under any setting. **The `TZ` choice itself is still
     open and still yours** — nothing now depends on it being made, which is the
     difference. Setting `TZ: Europe/Zurich` in `docker-compose.yml` remains a
     one-line change; §4l is why it is safe (dates reach a student as text, so
     the process zone never touches a grid).
   - ~~**`/mnt/bulk/datebaenkli/archive` has no retention.**~~ **Decided and
     built**: six months, in `db/prune-archive.sh` (§4vv). The rule it actually
     implements is "older than six months **and not referenced by a live
     account**" — a cold student's dump is that student's data, not an old file,
     and age alone would have deleted live accounts. **Still to do: install it
     in cron on the server**; §4vv has the line.

4. ~~**A pre-existing risk that 5b makes worse, and did not fix.**~~ **Fixed in
   8.1** (§4vv). The boot reconcile runs after `app.listen` now, so a restore
   backlog can no longer keep the port shut long enough for the health check to
   kill the container. Phase 7.3 is what moved this up the list: cold storage has
   a button now, so reaching the state that needs a restore no longer takes
   `curl`.

5. ~~**Two small gaps found by driving the deployed page.**~~ **Both closed**
   (§4uu). The roster has a delete button now, teacher-initiated per §8b and
   behind two dialogs that say different things.

   The `too_many_queries` half was **already fixed and this bullet was stale** —
   both catalogues had been reworded, with a comment citing §4dd, so the student
   had not seen the guess-as-fact for some time. What remained was the
   developer-facing `ServiceError` text in three services, which still asserted
   it to the log and to `curl`; that is now hedged to match. Worth noting as a
   caution about this list: a menu item can be done without being struck.

6. ~~Surface usage in the student page *before* they hit the limit.~~ **Done in
   7.2** (§4tt). The consistency argument turned out to be the load-bearing one:
   it is why `mb()` is now shared rather than written once per page.

7. ~~**Optional belt-and-braces on §4tt: rename the shared fixture
   identifiers.**~~ **Done in 8.1, for `verify-isolation.sh` only** (§4vv). Its
   fixtures are `vfy_*` now, outside the `^[ut]_` namespace the app can
   generate, so the collision is impossible by construction. The six live suites
   deliberately keep the realistic names — they were never the exposed half.

8. Keep architecture §10 and this file current.
