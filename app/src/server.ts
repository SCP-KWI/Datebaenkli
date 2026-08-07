/**
 * Datebänkli — entry point.
 *
 * Boot order matters: migrate before serving, so a half-migrated database can
 * never answer requests. If anything in startup fails we exit non-zero and let
 * Docker's restart policy retry.
 */

import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { join } from 'node:path';
import Fastify from 'fastify';
import { startLimiterSweeper, stopLimiterSweeper } from './auth/ratelimit.js';
import { startSessionSweeper, stopSessionSweeper } from './auth/session.js';
import { ensureBootstrapAdmin } from './bootstrap.js';
import { config } from './config.js';
import { migrate, sqlDir } from './db/migrate.js';
import {
  closeAllPools,
  getUserPool,
  metaPool,
  startPoolSweeper,
  teachAdminPool,
  userPoolCount,
} from './db/pools.js';
import { makeDb } from './db/query.js';
import { registerAuthHooks } from './http/auth.js';
import { HttpError, registerErrorHandler } from './http/errors.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerClassRoutes } from './routes/classes.js';
import { registerExerciseRoutes } from './routes/exercises.js';
import { registerLessonRoutes } from './routes/lesson.js';
import { registerPageRoutes } from './routes/pages.js';
import { registerQueryRoutes } from './routes/query.js';
import { registerSessionRoutes } from './routes/session.js';
import { registerStudentRoutes } from './routes/students.js';
import { registerTeacherRoutes } from './routes/teachers.js';
import { registerWorkspaceRoutes } from './routes/workspace.js';
import { makeCatalogReader } from './services/catalog.js';
import { makeExerciseService } from './services/exercise.js';
import { makeImporter } from './services/import.js';
import { makeLessonReader } from './services/lesson.js';
import { startArchiveSweeper, stopArchiveSweeper } from './services/lifecycle.js';
import { makeProvisioner } from './services/provision.js';
import { makeQueryRunner, startQueryLogPruner, stopQueryLogPruner } from './services/query.js';
import { makeQuotaGuard } from './services/quota.js';
import { reconcile, reportIsClean, summarise } from './services/reconcile.js';
import { makeWatchdog } from './services/watchdog.js';

const app = Fastify({
  logger: {
    level: config.isProduction ? 'info' : 'debug',
    /**
     * Nothing in this app logs a credential today — that was checked, call site
     * by call site. `redact` is here so it stays true structurally rather than
     * by everyone remembering.
     *
     * Fastify's default request serialiser emits method, url, hostname and
     * remoteAddress and *not* headers, so the session cookie does not reach a
     * log line as things stand. These paths are what a future `serializers`
     * override, a `req.log.info({ req })`, or a debug session would otherwise
     * open up — the cookie is a live session token, and one of them in a log
     * that gets pasted into an issue is an account handed over.
     */
    redact: {
      paths: [
        'req.headers.cookie',
        'req.headers.authorization',
        'res.headers["set-cookie"]',
        'password',
        'newPassword',
        'currentPassword',
        'pgPassword',
      ],
      censor: '[redacted]',
    },
    ...(config.isProduction
      ? {}
      : { transport: { target: 'pino-pretty', options: { colorize: true } } }),
  },
  // The reverse proxy terminates TLS and sets X-Forwarded-*; without this every client IP
  // logs as the proxy's — and the per-IP login limiter would throttle the whole
  // school as one address. A hop *count*, not `true`: see config.trustProxyHops.
  trustProxy: config.trustProxyHops,
  bodyLimit: 12 * 1024 * 1024, // headroom over the 10 MB CSV upload cap
});

/**
 * Fastify parses `text/plain` by default. That matters for CSRF: `text/plain`,
 * `application/x-www-form-urlencoded` and `multipart/form-data` are the
 * CORS-safelisted content types, so a plain cross-origin `<form>` can POST them
 * with no preflight. Our only other defence is SameSite=Lax, and SameSite is
 * scoped to the registrable domain — every other app on the same domain counts
 * as same-site and its cookies would ride along.
 *
 * Dropping the parser makes any request carrying a body-ish safelisted type a
 * 415, and `requireJsonBody` below closes the body-less variant.
 */
app.removeContentTypeParser('text/plain');

/**
 * Several routes legitimately take no body — a password reset, an archive, a
 * logout. Fastify's stock JSON parser rejects an empty body outright
 * (FST_ERR_CTP_EMPTY_JSON_BODY), which combined with the header requirement
 * below would leave them callable only with a literal `{}`. Treat empty as `{}`.
 */
app.addContentTypeParser(
  'application/json',
  { parseAs: 'string' },
  (_req, body: string, done) => {
    if (body.trim() === '') return done(null, {});
    try {
      done(null, JSON.parse(body) as unknown);
    } catch {
      done(new HttpError(400, 'invalid_json', 'The request body is not valid JSON.'), undefined);
    }
  },
);

/**
 * Every state-changing API call must declare `application/json`, which is not
 * CORS-safelisted and therefore forces a preflight that we answer for nobody.
 * This is the actual CSRF control; without it a route that reads no body (a
 * password reset, an archive) fires from a cross-origin `fetch` or `<form>`,
 * carrying the session cookie, because SameSite=Lax treats every sibling app on
 * the same registrable domain as same-site.
 */
app.addHook('onRequest', async (req) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
  if (!req.url.startsWith('/api/')) return;

  const contentType = req.headers['content-type'] ?? '';
  if (!contentType.split(';')[0]?.trim().toLowerCase().endsWith('/json')) {
    throw new HttpError(
      415,
      'json_required',
      'State-changing requests must send Content-Type: application/json.',
    );
  }
});

/**
 * Security headers, and `Cache-Control` for the API.
 *
 * `onSend` rather than `onRequest` so error replies and 404s carry them too —
 * those are exactly the responses a bug produces, and the ones most likely to
 * be reached by something other than the app's own pages.
 *
 * No `@fastify/helmet`: it would be the fifth runtime dependency for a hook
 * that is fifteen lines and that we want to read literally, since every
 * directive below is a claim about the app that has to stay true.
 *
 * **The CSP is strict because the app was made able to afford it**, not the
 * other way round: `script-src 'self'` needs zero inline scripts, so `home`,
 * `login` and `password` moved their `<script type="module">` bodies into
 * `assets/*.js` alongside the three pages that already worked that way, and
 * `sql.html`'s one `onclick=` moved into `sql.js`. `style-src 'self'` needs
 * zero `style=` attributes, so `lesson.html`'s became `.dialog-actions`. If a
 * future page reintroduces either, the fix is that page — adding
 * `'unsafe-inline'` here gives up the only control that would have caught a
 * missed `esc()`.
 *
 * `theme.js` is a classic script but an external file, so it needs nothing
 * special; it must keep running before first paint (see its header).
 *
 * `frame-ancestors 'none'` is the clickjacking control, and it matters more
 * than it looks: SameSite=Lax treats every sibling app on the registrable
 * domain as same-site, so a framed page keeps its session cookie.
 * `X-Frame-Options` repeats it for anything that predates CSP level 2.
 *
 * HSTS is emitted only when the public URL is https, so a plain-http
 * development instance cannot pin itself into being unreachable.
 */
const HSTS = 'max-age=31536000; includeSubDomains';
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  /**
   * **`'unsafe-inline'` here is required by CodeMirror and is not a shrug.**
   *
   * `style-src 'self'` shipped first and broke the SQL editor in a way that
   * looked like a layout bug rather than a policy one: CodeMirror injects its
   * base theme as a `<style>` element whose *textContent* it sets, which CSP
   * refuses to apply — the element is in the head, 11 kB of correct CSS, and
   * `styleElement.sheet` is `null`. The visible result was line numbers sitting
   * 42px above their lines, because `.cm-announced` (the screen-reader live
   * region, normally `position: absolute; top: -10000px`) rendered in flow and
   * pushed the content down while the gutter stayed put.
   *
   * The lesson for the next person tempted to tighten this: **check that the
   * stylesheet applied, not that the element exists.** `document.styleSheets`
   * or `styleEl.sheet !== null` is the test; "a `<style>` tag containing `.cm-`
   * is present" passes even when every rule in it is inert.
   *
   * `style-src-attr 'none'` is what keeps this from being a plain surrender.
   * The dangerous half of inline CSS is the `style=` *attribute* — the thing an
   * injection writes — and the app has none: `lesson.html`'s only one became
   * `.dialog-actions`, and no page script assigns one. So attributes stay
   * forbidden and only `<style>` elements, which nothing but our own bundle
   * creates, are allowed. Browsers too old for `style-src-attr` fall back to
   * `style-src` and are no worse off than before the CSP existed.
   *
   * CodeMirror's per-element layout writes (`el.style.height = …`) are CSSOM,
   * which CSP does not police, so they keep working either way.
   */
  "style-src 'self' 'unsafe-inline'",
  "style-src-attr 'none'",
  "font-src 'self'",
  // `data:` for images: the icon font is a font, but a favicon or an inline SVG
  // data URI in CSS is the kind of thing that gets added without thinking.
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

/**
 * `/handbuch` only — the one response that is a *document* rather than part of
 * the app shell, and the only place the policy above is relaxed.
 *
 * The handbook is generated outside this repo's front end
 * (`docs/handbook-src/build.mjs`) and is deliberately one self-contained file:
 * its twelve screenshots and its two webfonts are `data:` URIs. `font-src
 * 'self'` therefore blocks every face in it, and it carries two `style=`
 * attributes that `style-src-attr 'none'` blocks. Neither is a security
 * property worth the document rendering in a fallback face, and neither is
 * fixable from here — the generator is shared with the sister apps.
 *
 * What is *not* relaxed is the half that matters: `script-src 'none'`, which is
 * stricter than the app's own `'self'`. The handbook contains no script and
 * never will, so anything trying to run in it is an injection. Everything else
 * — `default-src 'self'`, `frame-ancestors`, `base-uri`, `object-src` — is
 * carried over unchanged.
 *
 * This is the exemption the main policy's header warns about, made once, by
 * URL, for a page that is not ours to fix. **Do not widen it to the app**: the
 * app has zero inline scripts and zero `style=` attributes, and the whole point
 * of `script-src 'self'` there is that it would catch a missed `esc()`.
 */
const HANDBOOK_CSP = [
  "default-src 'self'",
  "script-src 'none'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data:",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

app.addHook('onSend', async (req, reply) => {
  // `routeOptions.url` and not `req.url`, so a `/handbuch?print` still gets the
  // policy the document needs rather than the one that breaks its fonts.
  void reply.header(
    'content-security-policy',
    req.routeOptions.url === '/handbuch' ? HANDBOOK_CSP : CSP,
  );
  void reply.header('x-content-type-options', 'nosniff');
  void reply.header('x-frame-options', 'DENY');
  void reply.header('referrer-policy', 'same-origin');
  if (config.session.secure) void reply.header('strict-transport-security', HSTS);

  // API responses carry names, usernames and per-student activity. Nothing
  // sets `Last-Modified` or `ETag`, so heuristic freshness is already zero —
  // this is about shared-cache *storage* and about back/forward restore on a
  // classroom laptop the next student sits down at.
  //
  // Not applied to the pages: they are byte-for-byte constant, carry no user
  // data, and being cached is the reason the first paint is fast.
  if (req.url.startsWith('/api/')) void reply.header('cache-control', 'no-store');
});

const db = makeDb(metaPool);

/**
 * The provisioning engine, pointed at the *teaching* database.
 *
 * A second handle, not a second use of `db`: roles and schemas live in
 * `datebaenkli`, accounts live in `datebaenkli_meta`, and keeping them as
 * distinct objects is what stops a service from accidentally trying to run
 * both halves of an operation in one transaction — which would silently not be
 * one. It is passed into the routes rather than imported by the services, so
 * the test suite can drive the same service functions with a recording fake.
 */
const teachDb = makeDb(teachAdminPool);
const prov = makeProvisioner(teachDb);

/**
 * The query runner and the watchdog that bounds it.
 *
 * The watchdog signals from the *admin* handle, not from the student's own
 * connection — that connection is the one wedged, and a student who has run
 * `SET statement_timeout = 0` must not also be the one deciding when their
 * query stops. See services/watchdog.ts.
 */
const watchdog = makeWatchdog(
  teachDb,
  { warn: (msg) => app.log.warn(msg), error: (msg) => app.log.error(msg) },
  config.limits.cancelGraceMs,
);
/**
 * The disk quota, measured against the teaching database and shared by both
 * write paths. One object rather than one per service, so `/api/query` and
 * `/api/workspace/import` can never disagree about what the limit is.
 */
const quota = makeQuotaGuard(teachDb, config.limits.studentQuotaMb * 1024 * 1024);

const queryRunner = makeQueryRunner({ db, watchdog, quota, getPool: getUserPool });

// Deliberately the *same* per-student pool the runner uses, not a second one:
// `CONNECTION LIMIT 4` is per role, and a schema browser holding connections
// the editor cannot have would turn a refresh into the runner's
// `too_many_queries`. Sharing means the two compete for the same two slots,
// which is visible and explainable rather than mysterious.
const catalog = makeCatalogReader({ db, getPool: getUserPool });

// And again for CSV upload, for the third time and the same reason: an import
// is the student running SQL in their own schema, so it belongs in the two
// connections they already have rather than in a pool of its own.
const importer = makeImporter({ db, quota, getPool: getUserPool });

// The lesson view reads the meta database and asks the provisioner for disk
// usage; it opens no student connection of its own. The quota figure is the
// same one `makeQuotaGuard` enforces with, passed rather than re-read, so the
// number a teacher sees and the number a student is refused on cannot drift.
// Phase 9. The same shared pool a fourth time — materialising an exercise is the
// student running the teacher's SQL in a schema of their own, so it belongs in
// the two connections they already have. Takes the provisioner for the schema
// and its grants, and the quota because a fixture is copied into every student
// in the class and counts against each of them.
//
// Before the lesson reader, because that reader needs one function off it: a
// student's disk is their playground plus their exercise workspaces, and the
// teacher's roster shows one number per student.
const exercises = makeExerciseService({ db, prov, quota, getPool: getUserPool });

const lesson = makeLessonReader({
  db,
  prov,
  quotaBytes: config.limits.studentQuotaMb * 1024 * 1024,
  workspacesByUser: exercises.workspacesByUser,
});

await app.register(fastifyCookie, { secret: config.secrets.session });

registerErrorHandler(app);
registerAuthHooks(app, db);

/**
 * The liveness probe, and the one route that is `public` *and* touches the
 * database — so what it says has to be chosen rather than assumed.
 *
 * It used to return the driver's own error text, which is
 * `connect ECONNREFUSED 172.19.0.2:5432`, `password authentication failed for
 * user "dbk_app"` or `database "datebaenkli_meta" does not exist`: the internal
 * address, the privileged role name and the database names, to anyone on the
 * internet, during exactly the incident when someone is most likely looking.
 * `http/errors.ts` refuses to do that everywhere else and says why; this was
 * the hole in that rule.
 *
 * The detail is not lost, it moves to the log, which is where an operator can
 * see it and a stranger cannot. `ok`/`fail` per check is all a probe needs to
 * decide whether to restart the container.
 *
 * `userPools` and `runningQueries` stay: they are counters, they name nobody,
 * and they are the two numbers worth having on a dashboard.
 */
app.get('/health', { config: { public: true } }, async (req, reply) => {
  const checks: Record<string, string> = {};
  let ok = true;

  for (const [name, pool] of [
    ['meta', metaPool],
    ['teach', teachAdminPool],
  ] as const) {
    try {
      await pool.query('SELECT 1');
      checks[name] = 'ok';
    } catch (err) {
      ok = false;
      checks[name] = 'fail';
      req.log.error({ err, check: name }, 'health check failed');
    }
  }

  return reply.code(ok ? 200 : 503).send({
    status: ok ? 'ok' : 'degraded',
    // `config.build`, not a literal. This said '0.1.0' through six releases,
    // which is worse than saying nothing: a deploy check that reads it would
    // have reported the old image as current.
    version: config.build.version,
    checks,
    userPools: userPoolCount(),
    runningQueries: watchdog.active().length,
  });
});

registerSessionRoutes(app, db);
registerTeacherRoutes(app, db, prov);
registerClassRoutes(app, db, prov);
registerStudentRoutes(app, db, prov);
registerQueryRoutes(app, queryRunner, exercises);
// The same `quota` the runner and the importer enforce with, for the third
// time: the figure the schema browser shows a student has to be the one they
// will actually be refused on, and a second guard here would be a second limit.
registerWorkspaceRoutes(app, db, prov, catalog, importer, quota, exercises);
registerExerciseRoutes(app, db, exercises);
registerLessonRoutes(app, db, lesson, catalog);
registerAdminRoutes(app, db, prov);

async function start(): Promise<void> {
  const log = {
    info: (msg: string) => app.log.info(msg),
    warn: (msg: string) => app.log.warn(msg),
  };

  const meta = await migrate(metaPool, sqlDir('meta'), log);
  const teach = await migrate(teachAdminPool, sqlDir('teach'), log);
  app.log.info(
    `migrations: meta ${meta.applied.length} applied / ${meta.skipped} current, ` +
      `teach ${teach.applied.length} applied / ${teach.skipped} current`,
  );

  await ensureBootstrapAdmin(log);

  // Reads dist/web from disk, so it belongs inside start(): a build that shipped
  // JS without the HTML then fails through this function's structured error
  // path instead of as a bare stack during module evaluation.
  registerPageRoutes(app);

  /**
   * The asset tree — the editor bundle and the student page's script.
   *
   * Registered with `serve: false` and fronted by one route of our own, rather
   * than letting the plugin install its own wildcard. The reason is the route
   * `config`: a plugin-installed static route carries none, so it inherits the
   * closed-by-default hook — and the first version of this did exactly that,
   * which made `/sql` a **permanently dead page** for anyone without a live
   * session. The HTML shell is public and rendered fine, but `sql.js` answered
   * 401, so the script that would have redirected to `/login` never ran. The
   * same trap in a worse form for a student mid-password-change: `/api/me` is
   * `passwordChangeExempt`, the asset was not, so it answered 403 and the
   * redirect to `/password` never fired either.
   *
   * Public is also simply correct, and for the reason routes/pages.ts already
   * gives for the pages: these files are program text, not data. Every action
   * they offer goes through an `/api` route that enforces the real rules, so
   * serving them to a logged-out browser leaks nothing.
   *
   * `:file` is a single path segment and `sendFile` resolves inside `root`, so
   * there is no traversal surface. No `maxAge`: the filenames are not
   * content-hashed, so a long cache would serve yesterday's editor after a
   * deploy — `send`'s mtime/size ETag still makes the repeat visit a 304, which
   * is the part that matters during a lesson.
   */
  await app.register(fastifyStatic, {
    root: join(import.meta.dirname, 'web', 'assets'),
    serve: false,
  });

  app.get<{ Params: { file: string } }>(
    '/assets/:file',
    { config: { public: true } },
    async (req, reply) => reply.sendFile(req.params.file),
  );

  /**
   * The self-hosted webfonts (phase 7), which need a route of their own for a
   * dull reason: `/assets/:file` above matches exactly one path segment, so it
   * cannot reach a subdirectory, and the alternative was seventeen `.woff2`
   * files lying flat among the page scripts.
   *
   * Same `root`, so this inherits the same guarantee — `:file` is one segment
   * and cannot contain a slash, and `sendFile` resolves inside `root` — and it
   * is `public` for the same reason everything else under `/assets` is: a font
   * is not data about anyone. Serving it to a logged-out browser leaks nothing,
   * and gating it would put the login page in a fallback face.
   *
   * These *are* effectively immutable — the filename encodes family, weight and
   * subset — but they still carry no `maxAge`, because `tools/vendor-fonts.mjs`
   * rewrites them under the same names when the icon list changes. The ETag
   * makes the repeat visit a 304, which is the part that matters.
   */
  app.get<{ Params: { file: string } }>(
    '/assets/fonts/:file',
    { config: { public: true } },
    async (req, reply) => reply.sendFile(join('fonts', req.params.file)),
  );

  /**
   * The teacher handbook — `docs/handbuch.html`, one self-contained document.
   *
   * Here rather than in `routes/pages.ts` because it is not one of the app's
   * pages: those are read into memory at boot and sent as constants, which is
   * right for 4 kB shells and wrong for 1.1 MB of embedded screenshots and
   * fonts. `sendFile` streams it and gives it `send`'s mtime/size ETag, so the
   * second visit is a 304 rather than another megabyte.
   *
   * The second argument overrides the plugin's `root` for this one call — the
   * registration above points at `web/assets`, and the handbook is a document,
   * not an asset. No path comes from the request, so there is nothing to
   * traverse with; this is a fixed filename under a fixed root.
   *
   * `public`, deliberately and not by omission: a teacher who has forgotten how
   * to hand out access needs the handbook *before* she can log in, which is
   * exactly when she has no session. It is the same argument the pages make —
   * program text, not data about anyone.
   *
   * The single source is `docs/handbuch.html`, generated by
   * `docs/handbook-src/build.mjs`. `postbuild` copies it into `dist/web/`,
   * which is gitignored, so there is no second checked-in copy to drift.
   */
  app.get('/handbuch', { config: { public: true } }, async (_req, reply) =>
    reply.sendFile('handbuch.html', join(import.meta.dirname, 'web')),
  );

  startPoolSweeper();
  startSessionSweeper(db, log);
  startLimiterSweeper();
  startQueryLogPruner(db, config.limits.queryLogRetentionDays, {
    info: (msg) => log.info(msg),
    warn: (msg) => log.warn(msg),
  });
  // The nightly `active -> archived` pass (architecture §8b). Unlike the three
  // above it does not run immediately — see `startArchiveSweeper`, which
  // explains why a sweep on boot is the one thing this must not do.
  startArchiveSweeper(db, prov, log);

  await app.listen({ host: '0.0.0.0', port: config.port });

  /**
   * Repair whatever the last run left behind — **after the port is bound, and
   * that ordering is the whole point.**
   *
   * It fixes accounts created while the teaching database was unreachable, a
   * deletion whose archive dump failed, a grant that never landed. Non-fatal on
   * purpose: a provisioning problem must not stop the app serving, because
   * `/health`, the login page and every teacher's roster work without it, and
   * refusing to boot would turn a partial outage into a total one.
   *
   * It used to run *before* `listen`, which quietly made that promise
   * conditional. Since 5b the pass can shell out to `pg_restore`, up to
   * `DBK_DUMP_TIMEOUT_MS` (300 s) per account and sequentially, so three
   * accounts needing a restore is fifteen minutes before the port opens — long
   * enough for the container's health check to fail, be killed, and start over
   * from the top, restoring the same three accounts again. A crash loop whose
   * cause reads as a broken image.
   *
   * Phase 7.3 is what made this worth fixing rather than noting: cold storage now
   * has a button, so reaching the state that needs a restore no longer takes
   * `curl`.
   *
   * **The fix is the order, not a shorter timeout.** A dump that gets cut off
   * half way is worse than one that takes five minutes; the repair is simply
   * not more urgent than serving. Still `await`ed, so failures land in the log
   * in order and "serving anyway" is now literally true rather than aspirational
   * — nothing is waiting on this promise, `listen` has already resolved.
   *
   * **What this does newly allow is a request landing mid-reconcile**, which was
   * impossible when the pass finished before the port opened, so it is worth
   * saying why it is acceptable rather than leaving it to be rediscovered. Both
   * sides do their DDL as `dbk_app`, and Postgres serialises DDL on the same
   * objects with locks, so the failure mode is one of them erroring rather than
   * two half-applied changes. Provisioning is idempotent — `provision.live.test.mjs`
   * pins re-provisioning an existing account as a no-op — and this pass is
   * non-fatal and runs again on the next boot. So the worst case is a logged
   * error and a repair deferred by one restart, against a crash loop as the
   * alternative.
   */
  if (config.provisioning.onBoot) {
    try {
      const report = await reconcile(db, prov);
      if (reportIsClean(report)) {
        app.log.info(`reconcile: ${report.checked} accounts checked, nothing to repair`);
      } else {
        app.log.warn(summarise(report));
        for (const f of report.failed) {
          app.log.error(`reconcile: ${f.pgRole} ${f.step}: ${f.error}`);
        }
      }
    } catch (err) {
      app.log.error({ err }, 'reconcile failed; serving anyway');
    }
  }
}

let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`${signal} received, shutting down`);
    stopSessionSweeper();
    stopQueryLogPruner();
    stopLimiterSweeper();
    stopArchiveSweeper();
    // Close the listener first so in-flight queries finish before pools go.
    app
      .close()
      .then(closeAllPools)
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        app.log.error({ err }, 'error during shutdown');
        process.exit(1);
      });
  });
}

start().catch((err: unknown) => {
  app.log.error({ err }, 'startup failed');
  process.exit(1);
});
