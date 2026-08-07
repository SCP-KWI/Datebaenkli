# Datebänkli

A hosted PostgreSQL sandbox for teaching SQL. Students get a real database role
and schema of their own, reachable from any browser — no local install on
laptops, iPads or anything else.

Built with the Chalk design system, whose portable tokens and spec live in
[`chalk-design-system/`](chalk-design-system/).

## Docs

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — the design. Start at §1;
  the isolation model explains everything else.
- **[docs/API.md](docs/API.md)** — the HTTP surface and the rules behind it.
- **[docs/HANDOFF.md](docs/HANDOFF.md)** — current state, what is verified,
  open risks, next steps. **Start at §0.**
- **[CLAUDE.md](CLAUDE.md)** — conventions and invariants for anyone (or
  anything) writing code here.

## Status

Phases 0–2 are complete and verified against a real PostgreSQL: the stack and
migrations, then authentication, sessions and admin → teacher → student
administration, then the provisioning engine — real login roles, schemas,
teacher grants, reset, archival dumps and deprovisioning, with a reconciler that
repairs the teaching database against the account table.

Phase 3 is next: the student page — SQL editor, execution, result grid, schema
browser, cancellation. That is the first phase that makes the app usable in a
lesson.

## Quick start (development)

```bash
cd app
npm install
npm test          # 117 tests: crypto, identifiers, SQL parsing, the services
                  # driven against migrations executed in PGlite, and the
                  # provisioning seams via a recording fake
```

Checks that need a real server, not PGlite — PGlite is single-user and cannot
execute a single `GRANT`. HANDOFF §6 has the throwaway-cluster commands, which
need neither Docker nor sudo.

```bash
# the provisioning engine itself: roles, grants, reset, archive, deprovision
cd app && PGHOST=127.0.0.1 PGPORT=55432 DBK_APP_DB_PASSWORD=... \
  node --test test/provision.live.test.mjs

# the SQL sequences, independently of the app
DBK_APP_DB_PASSWORD=... ./db/verify-isolation.sh

# sessions, role guards, the password gate, cross-teacher isolation
# (against a running app)
DBK_ADMIN_PASSWORD=... ./db/verify-auth.sh
```

Deployment lives in `docker-compose.yml`; see HANDOFF §7 for the server steps.

## Layout

```
docker-compose.yml   app + database, DB on a private network with no host port
db/init/             one-time cluster bootstrap (roles, databases, revokes)
db/verify-*.sh       checks that need a real Postgres / a running app
app/src/auth/        passwords, sessions, identifier derivation, rate limiting
app/src/services/    accounts, classes, provisioning, reconciliation, audit
app/src/db/          pools, the Db interface, migrations, SQL identifier quoting
app/src/routes/      the HTTP surface
app/src/db/sql/      migrations, applied on boot by the app
app/test/            test suite
docs/                architecture, API, handoff
```
