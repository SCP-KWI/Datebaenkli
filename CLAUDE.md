# Working in this repo

A hosted PostgreSQL sandbox for teaching SQL. Node 22 + Fastify + TypeScript,
two Postgres databases, no framework beyond that.

**Read `docs/HANDOFF.md` §0 first.** It says what to read for the current phase
and — more usefully — what not to. `docs/ARCHITECTURE.md` is 578 lines and
mostly settled; look things up in it, don't read it through.

---

## The one invariant

**Postgres enforces isolation, not app code.** Every student has a real login
role and a schema of the same name; the app opens connections *as that student*.
A shared pool with `SET ROLE` is not a substitute — a student can type
`RESET ROLE;` into the editor and escape it.

`role name == schema name == app username`, one string, deliberately. It makes
`search_path` (`"$user", public`) resolve with no setup, and means the name a
student types to log in is the one they type in `SELECT * FROM u_k3a_muster_lena.kunden`.

`docs/HANDOFF.md` §3 lists the other decisions not to silently reverse. Check it
before changing anything about auth, grants, identifiers or cookies.

---

## Conventions

**Services take handles, they don't import them.** A service takes a `Db`
(`db/query.ts`), never `metaPool` directly — transactions need one pinned
connection, and it is what lets the test suite drive the real functions against
PGlite. Services that touch a Postgres identity also take a `Provisioner`
(`services/provision.ts`), injected the same way, so tests can pass a recording
fake. Routes receive both from `server.ts` and pass them down.

**Provisioning never runs inside the meta transaction.** Accounts live in
`datebaenkli_meta`, roles and schemas in `datebaenkli`; two databases cannot
share a transaction. Commit the account row first, provision after, and return a
`provisioning: { ok, error? }` field rather than failing a request whose row
already exists. `services/reconcile.ts` repairs whatever a failure left behind.

**Only `services/provision.ts` and `services/import.ts` may concatenate SQL** —
DDL takes no bind parameters. Every identifier goes through `db/ident.ts` first.
Everything else uses `$1` placeholders, always, *including* the row data a CSV
import inserts.

The two are not the same hazard, and `import.ts`'s header says so: `provision.ts`
runs as `dbk_app` and can create roles and drop schemas, so a bad identifier
there is arbitrary privileged SQL. `import.ts` builds one `CREATE TABLE` on a
connection opened *as the student*, where the worst case is something they could
already type into the editor. That is an argument about blast radius, not a
licence — names are still folded to `[a-z_][a-z0-9_]*` and then re-checked
against that pattern before being quoted. **A third such file needs the same
argument made explicitly, or it does not belong.**

Phase 9 is the shape to copy when that comes up. `services/exercise.ts` needed
both hazards and became neither file: the schema, its drop and the teacher's
grant went **into** `provision.ts` as new seams, and the CSV fixtures go through
`import.ts`'s exported `createAndFill` — which was lifted out of `makeImporter`
for exactly that. A second caller of an existing builder is not a third builder.
It is also why a CSV source is stored **as CSV** rather than as generated
`INSERT` text: storing the text would have been this app building *data* by
concatenation, which is the line `import.ts` draws.

**Routes are closed by default.** Authentication and the must-change-password
gate are global hooks; a route is open only if it says `config: { public: true }`.
A route added without thinking about it is closed, which is the right default.

The exceptions are the pages and `/assets`, which are `public` on purpose: they
are program text, not data, and every action they offer goes through an `/api`
route that enforces the real rules. A page's *script* especially — gate it and
the code that would redirect an expired session to `/login` never runs, so the
user gets a dead shell instead (`docs/HANDOFF.md` §4k).

**One error shape:** `{ error: { code, message } }`. Throw a `ServiceError` from
a service and map its code in `http/errors.ts` — anything unmapped is a 500 with
a stack, which is the correct outcome for a bug and the wrong one for a caller
mistake. Bodies are validated by hand in `http/validate.ts`; there is no schema
library and we are not adding one.

**Every destructive or administrative action writes an `audit_log` row.**
`AuditAction` in `services/audit.ts` is a closed union — extend it rather than
passing a string.

**Config is validated at import** (`config.ts`) and throws on boot. A bad secret
should crash the container loudly, not surface as a confusing 500 mid-lesson.

**The front end is plain ES modules, with exactly one bundled file.** Pages live
in `src/web` and their logic in `src/web/assets/*.js`, served as written.
`src/web/assets/editor.entry.js` is the sole exception — CodeMirror 6 is two
dozen packages with bare specifiers and cannot be served unbundled — so all of
it hides behind `createEditor()` and esbuild emits one file in `postbuild`.
CodeMirror and esbuild are devDependencies and are pruned from the runtime
image. Do not add a second bundled entry point, and do not reach for a
framework: the student page is the largest there will be, and it is `sql.js` +
`csv-import.js` + `hints.js` + `util.js`, plain modules importing each other.
`roster.js` + `names.js` + `util.js` is the same shape.

`names.js` and `hints.js` are split out for the reason that justifies splitting
one at all — they are pure, and they are the only part of their page a test can
reach. That is the bar for a fourth: not "this file is long", but "this part can
be wrong without anyone seeing it, and a test can reach it".

**`markdown.js` is that fourth** (phase 9) and it clears the bar on both counts:
it renders a teacher's task text into `innerHTML` on a page 25 students read, so
the way it is wrong is an injection that looks identical to correct output. Its
header carries the one rule that keeps it safe — **escape everything first, then
insert tags** — which is `util.js`'s `ticked()` argument at greater length. Do
not relax it, and do not "improve" it by reaching for a library: that would be
the fifth runtime dependency.

**There is exactly one stylesheet, and one classic script** (phase 7).
`assets/app.css` holds the shell above its banner comment and page-scoped rules
below it; `assets/chalk-tokens.css` is a copy of the design system's tokens and
is not edited here directly. `assets/theme.js` is the only non-module script in
the app — it must run before first paint, which a `type="module"` script by
definition cannot. Two rules that cost real bugs to learn, both recorded at the
sites: **grep the page scripts before adding a utility class** (`.row` is on a
`<tr>` in two of them and `.cols` means three different things), and **an
attribute that depends on state cannot also carry a `data-i18n-attr`** — pick one
owner, or the two disagree in whichever mode you are not testing in.

**CodeMirror's floating UI is themed in `app.css`, not in the editor bundle.**
`editor.entry.js` sets the editor to `color: inherit`, which is right for
everything *inside* it and wrong for anything that floats: CodeMirror gives
tooltips and panels their own white background, so inheriting a dark-mode `--ink`
produced white-on-white. Any new floating surface needs an explicit background
there — and check the computed value, because CodeMirror's own selectors carry a
generated scope class and quietly out-specify a one-class rule.

**Fonts are self-hosted and the icon font is subsetted.** `app/tools/vendor-fonts.mjs`
fetches from Google at *build* time, writes `assets/fonts/` and generates
`assets/fonts.css`; the output is committed and the script is not part of
`npm run build`. Adding an icon to a page means adding it to that script's
`ICONS` list — alphabetically, or Google answers `400` — and re-running it.

**Four runtime dependencies, and it is meant to stay that way.** No schema
library (`http/validate.ts` is hand-rolled), no CSV parser and no COPY streaming
helper — architecture §4 specified `csv-parse` and `pg-copy-streams` and §4 now
records why neither was taken. Adding a fifth needs an argument better than
"it's standard".

**Comments explain *why*, and the bar is high.** This codebase is handed between
sessions with no shared memory, so a comment that restates the code is noise but
one that records a rejected alternative or a trap is the most valuable line in
the file. Match the surrounding density — it is deliberate.

---

## Tests

Three layers, and the split matters:

| File | Runs against | Covers |
|---|---|---|
| `test/sql.test.mjs` | libpg-query + PGlite | migrations parse and execute |
| `test/services.test.mjs` | migrated PGlite + a recording provisioner | the real service functions; *which* provisioning calls a seam decides to make |
| `test/provision.test.mjs` | PGlite | identifier safety, the reconciler's diff |
| `test/watchdog.test.mjs` | a recording fake | the watchdog's bookkeeping and its escalation race |
| `test/csv.test.mjs` | nothing — pure functions | parsing, the Swiss coercions, inference, name folding |
| `test/names.test.mjs` | nothing — pure functions | splitting a pasted class list; the only part of the roster page testable without a browser |
| `test/hints.test.mjs` | nothing — pure functions | the German SQLSTATE explanations and the did-you-mean. Every `message` in it was copied off a real server — **get a new one the same way**, because four of the shapes are not what they look like. The `2BP01` block is the one exception and says so at the site: PGlite 18.3, because no cluster existed that day |
| `test/chalk.test.mjs` | nothing — two files on disk | that the portable and served copies of `chalk-tokens.css` have not drifted, and that the accent is declared *and* aliased. The drift is the whole point: the portable copy is the one pasted into the other Chalk apps, and it is not the one anyone edits |
| `test/markdown.test.mjs` | nothing — pure functions | the task-text renderer. The safety block comes **first** in that file on purpose: every case in it is a way the escape-first rule could be broken by a well-meaning edit, and each would render identically to correct output in a browser |
| `test/pages.test.mjs` | nothing — the HTML on disk | that the CSV dialog's markup is byte-identical in `sql.html` and `uebungen.html`, that both carry every id `csv-import.js` reaches for, and that no page has grown an inline script, handler or `style=` — which is the only thing that keeps `script-src 'self'` worth having |
| `test/exercise.test.mjs` | migrated PGlite + a recording provisioner | the exercise bookkeeping: which schema name gets reserved, that a *second* open does not replay the fixtures over a student's work, what a take-back decides to drop, that attempts are assigned rather than derived, and what the download says |
| `test/provision.live.test.mjs` | a **real** server | that the engine issues the right SQL. Skips silently without one. |
| `test/query.live.test.mjs` | a **real** server | that a query actually runs, and actually stops. Ditto. |
| `test/catalog.live.test.mjs` | a **real** server | that the schema browser shows your tables and *not* another student's. Ditto. |
| `test/import.live.test.mjs` | a **real** server | that a CSV lands in your own schema, holds the values you meant, and leaves nothing behind when it fails. Ditto. |
| `test/lifecycle.live.test.mjs` | a **real** server | that cold storage dumps and drops, that reconcile does *not* undo it, and that a restored student can read her own rows. Ditto. |
| `test/exercise.live.test.mjs` | a **real** server | that an exercise workspace is genuinely the student's — both directions — that resetting one leaves the playground and every other exercise alone, and that a teacher can read one but not write to it. Ditto. |

**The live suites cannot provision concurrently** — `node --test` runs files in
parallel, and `GRANT CONNECT ON DATABASE` updates one shared `pg_database` row,
so two at once get `XX000 tuple concurrently updated`. Every live suite takes
the advisory lock in `test/support/live-lock.mjs`; a new one must too.

**A live suite gets its plumbing from `test/support/live-pg.mjs`, not from the
suite next door.** `liveSuite()` does the probe, the skip and the lock in the
one order that works; `asUser`/`tryAsUser` connect *as* a student — the throwing
form for fixture setup, the other for suites whose claim *is* a refusal;
`dropRoles` drops in the order it is given (students first, teacher last, and
that is the caller's to get right) and then asserts against `pg_roles` that
nothing survived. That assertion is not optional. `docs/HANDOFF.md` §4u is the
run where a swallowed teardown failure leaked a role into the production cluster
and permanently burned an identifier; §4ii is why three of the five suites went
months without such a check and nobody could tell.

**PGlite is single-user and cannot execute a single `GRANT`.** Anything about
roles or privileges belongs in the live suite. Cancellation especially: a
watchdog that issues `pg_cancel_backend` the obvious way passes every mock and
cancels nothing, because `dbk_app` holds student roles NOINHERIT
(`docs/HANDOFF.md` §4a). `test/support/meta-db.mjs` has the
shared PGlite setup; it is not a `*.test.mjs` so the glob skips it.

**Two cases in `query.live.test.mjs` only fail under a non-UTC `TZ`** — the ones
pinning that dates reach the grid as text rather than JS `Date`s
(`docs/HANDOFF.md` §4l). Run the live suite with `TZ=Europe/Zurich`; under
`TZ=UTC` the bug they exist for is invisible. This is *stricter* than the
deployment, which runs UTC — the container sets no `TZ` at all (§4gg). That is
the safe direction and it is deliberate; do not read the flag as "matching
production", which is what this line used to claim.

```bash
cd app
npm test          # build + all of the above; ~230 s, ~4.5 GB peak
npm run typecheck
```

**`npm test` runs its files one at a time (`--test-concurrency=1`), and that is
a memory decision rather than a stylistic one.** `support/meta-db.mjs`'s
`freshMeta()` does `new PGlite()` per test and never closes it — PGlite is
Postgres compiled to WASM, so the instances accumulate for the life of a file.
Measured 2026-08-07: `services.test.mjs` 4.6 GB, `exercise.test.mjs` 4.6 GB,
`sql.test.mjs` 4.3 GB, **each on its own**. Run in parallel they peaked at
**9.4 GB** and OOM-killed a developer machine that was also running a browser.
Serialised: **4.5 GB**, and the whole suite takes about 230 s.

**Do not remove the flag to make the suite faster.** The wall-clock it buys back
is real and so is the OOM. The actual fix is closing the PGlite instances, which
touches every test file and has not been done; until it is, this flag is what
stands between the suite and the machine it runs on. Adding a fourth
PGlite-backed test file no longer makes the peak worse — only the runtime.

`npm run dev` serves `src/web`, where the editor bundle does not exist — only
`postbuild` produces it, into `dist`. The SQL page's `/assets/editor.js` will
404 under `dev`. Use `npm run build && npm start` when working on that page.
`/handbuch` is the same shape for the same reason: `postbuild` copies
`docs/handbuch.html` into `dist/web`, so it is the one checked-in copy and there
is nothing under `dev` to serve.

`/uebungen` is the exercises page (phase 9) — German in the path where the other
five are not, because it is the one URL a teacher types in front of a class and
neither `exercises` nor `uebungen` is a word both locales recognise. A student
*works* on an exercise at `/sql?uebung=<id>`, not there: the editor bundle exists
on one page only, which is the constraint that shaped the whole feature.

The live suite needs a throwaway cluster — the exact commands are in
`docs/HANDOFF.md` §6, no Docker and no sudo required. Note
`DBK_ARCHIVE_DIR_CONTAINER`: it defaults to a path that does not exist on the
dev machine, and a deletion correctly refuses to drop a schema it could not dump.

`db/verify-isolation.sh` (41 checks, SQL sequences) and `db/verify-auth.sh`
(95 checks, HTTP against a running app) are the end-to-end nets. Run both after
touching auth or provisioning.

The isolation script covers **exercise workspaces** since phase 9, and it needed
no new fixture roles to do it: a workspace belongs to a student already in
`FIXTURES`, so the guard and the teardown both reach it for free —
`DROP OWNED BY CURRENT_USER` drops every schema a role owns, not just the one
named after it. Keep it that way; a fixture that is not in that array is a
fixture nothing cleans up.

**`verify-isolation.sh` creates and DROPS real login roles, and its fixture
names are the same shape `/roster` produces.** `t_schaffner` is a real teacher
account on the deployed cluster; the script's header used to say "run it once
against the live server", which would have dropped that account and its schema
(HANDOFF §4tt). Two things now stop that, and neither is optional:

- **A guard before anything is created** asks `app_user` in the meta database
  whether a fixture name is a real account and refuses if so. It fails closed:
  an unreachable meta database aborts. `deleted` is the only state it ignores,
  because deletion drops the role — `archived` and `cold` both keep it.
- **A teardown at both ends, with an assertion after the second.** Entry makes
  a re-run possible; exit is what stops a leak. The assertion is the half that
  fails loudly, and CLAUDE.md's rule for `dropRoles` applies here for the same
  reason.

Add a fixture and it goes in the `FIXTURES` array at the top — the guard, the
teardown and the assertion all read that one list.

---

## Housekeeping

- Update `docs/HANDOFF.md` at the end of every session — it is the only thing
  the next one starts from.
- The repo is **public**. `.env` and `setupReference/` are gitignored and must
  stay that way.
- **Work happens on `main`** (changed 2026-07-29). Phases 0–7.1 were built on
  `phase-0-foundation` and merged in three PRs; that branch is now historical and
  `main` is both what production pulls and what you commit to. Do not start a new
  long-lived branch without being asked — the deploy is `git pull` on the server,
  and a second branch is how the box ends up on a commit nobody can name.
