/**
 * The student page.
 *
 * Plain ES modules, served as-is — only `editor.js` is bundled, and only
 * because CodeMirror cannot be served any other way. Everything here is the
 * client half of the contract in docs/API.md "Running SQL": a failed query is a
 * `200` carrying `{ ok: false, error }`, a successful one carries one entry per
 * statement, and `rowCount` is the *true* total even when `rows` was clipped.
 *
 * The one thing worth knowing before editing this file: a script is sent to
 * Postgres as a single simple-protocol message, which means the server wraps it
 * in one implicit transaction. A failure in the third statement therefore takes
 * the first two with it. `MULTI_STATEMENT_ROLLBACK` below says so out loud,
 * because the opposite assumption — "the first two committed" — is the natural
 * one and would have students hunting for rows that were never there.
 */

import { openImportDialog } from '/assets/csv-import.js';
import { createEditor } from '/assets/editor.js';
import { hintFor, renderHint } from '/assets/hints.js';
import { apply, errorText, formats, load, paintCached, t, wireLanguageSelect } from '/assets/i18n.js';
import { renderMarkdown } from '/assets/markdown.js';
import { esc, json, mb, mountVersion, ticked, wireThemeToggle } from '/assets/util.js';

const $ = (id) => document.getElementById(id);

/**
 * A wrapper, not an `Intl.NumberFormat`, because the locale is not known at
 * module-eval time — `/api/me` has not answered yet. Building the formatter here
 * would pin German for the life of the page.
 *
 * `formats()` in `i18n.js` has the argument for `de-CH`/`en-CH` and for why the
 * region stays Swiss in both. The wrapper keeps every `number.format(…)` call
 * site below unchanged.
 */
const number = { format: (value) => formats().number.format(value) };

/**
 * Quote an identifier the way the student would have to.
 *
 * `CREATE TABLE "Meine Kunden"` is a thing a beginner does by accident, and a
 * generated `SELECT * FROM Meine Kunden` would then be a syntax error blamed on
 * the app. Folding the rule into the click is also the cheaper lesson: the
 * quotes appear in the editor where they can be read.
 */
const quote = (name) =>
  /^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;

/**
 * Read through `t()` at the point of use, not hoisted into a constant here: the
 * locale is not known until `/api/me` answers, and a module-level constant would
 * freeze German before that happens.
 */
const MULTI_STATEMENT_ROLLBACK = () => t('sql.rollback');

// --- session -----------------------------------------------------------------

const mePromise = fetch('/api/me')
  .then((r) => (r.ok ? r.json() : null))
  // A rejected fetch here would abort module evaluation and leave the shell on
  // screen with nothing behind it — the same dead page as being unauthorised.
  .catch(() => null);

// Between starting that request and awaiting it: paint the first frame in the
// language this browser last used, and light the theme toggle. Both are safe
// before we know who is looking — the theme is device-local and the language is
// overwritten by `load(user.locale)` below (`paintCached()` has the argument).
await paintCached();
const paintTheme = wireThemeToggle($('theme'), (dark) =>
  t(dark ? 'nav.theme_light' : 'nav.theme_dark'),
);

const me = await mePromise;

// `location.href = …` does not stop the script, so each of these has to return.
// Falling through would run `me.user` on null and turn a redirect into a
// TypeError, which is a blank page instead of the login form.
if (!me) {
  location.href = '/login';
} else if (me.user.mustChangePassword) {
  location.href = '/password';
} else if (me.user.role === 'admin') {
  // An admin has no Postgres identity at all, so every route this page uses
  // would answer 403. Sending them back is kinder than three failed panes.
  location.href = '/';
}
// Nothing below is worth running while the browser is on its way elsewhere.
if (!me || me.user.mustChangePassword || me.user.role === 'admin') {
  throw new Error('redirecting');
}

const user = me.user;
$('who').textContent = `${user.displayName} · ${user.username}`;

// --- language ----------------------------------------------------------------

/**
 * Before anything renders. The page ships with German in its markup and this
 * swaps it, so doing it after the first paint would show an English student a
 * frame of German — and doing it after `renderTree()` would leave the parts
 * built by script in the wrong language entirely.
 *
 * `app_user.locale` is the source of truth. Phase 7 added a
 * `localStorage["chalk-lang"]` mirror, but only as a paint-ahead cache — this
 * call is what overrides whatever `paintCached()` guessed above, and removing it
 * on the grounds that the two usually agree would promote the cache to an
 * authority. `i18n.js`'s header has the argument.
 */
await load(user.locale);
apply();
// After apply(), not before: the toggle's label depends on which way it
// currently points, which no `data-i18n` key can express.
paintTheme();
wireLanguageSelect($('lang'));
mountVersion($('version'), (d) => formats().dateTime(d));

// --- the editor --------------------------------------------------------------

// The modifier is the platform's, not the locale's — but its *name* is a word,
// and "Strg" is not one in English.
const runKey = navigator.platform.startsWith('Mac') ? '⌘↵' : t('sql.ctrl');
$('run').textContent = t('sql.run_key', { key: runKey });

const editor = createEditor({
  parent: $('editor'),
  doc: 'SELECT * FROM demo.kantone;\n',
  onRun: () => void run(),
});
editor.focus();

// --- exercise context --------------------------------------------------------

/**
 * `/sql?uebung=<id>` puts this page into an exercise: the tables on screen are
 * the exercise's copy, not the playground's, and the query runner is told so.
 *
 * **Why the id is in the URL rather than in a picker on this page.** It makes an
 * exercise a link — from `/uebungen`, from the teacher's page, from a message —
 * and it makes the browser's back button do the obvious thing. It also means
 * this page has exactly one mode switch, decided once at load, rather than a
 * piece of state that every handler below would have to consult.
 *
 * The id is *not* trusted for anything: `POST /api/my/exercises/:id/open`
 * decides whether this account may have it, and every later call sends the id
 * again for the server to re-resolve. The schema name never comes from here.
 *
 * `null` when there is no exercise, which is the ordinary case and the one every
 * line below is written to leave untouched.
 */
const exerciseId = (() => {
  const raw = new URLSearchParams(location.search).get('uebung');
  const n = Number(raw);
  return raw !== null && Number.isSafeInteger(n) && n > 0 ? n : null;
})();

/** The open exercise: `{ id, title, taskMd, schema }`, or null. */
let exercise = null;

const exStatus = (message, kind = 'muted') => {
  $('exStatus').className = `small ${kind}`;
  $('exStatus').textContent = message ?? '';
};

/**
 * Build (or find) this account's copy and paint the bar.
 *
 * Called on load and again after a reset, because both need exactly this: the
 * open route is idempotent — an existing workspace answers `materialised: false`
 * and is not touched — which is what makes it safe as a page-load call.
 */
async function openExercise() {
  const [payload, error] = await (async () => {
    const response = await fetch(`/api/my/exercises/${exerciseId}/open`, json()).catch(() => null);
    if (!response) return [null, t('error.offline')];
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      return [null, body?.error ? errorText(body.error) : t('ex.open_failed')];
    }
    return [body, null];
  })();

  if (error) {
    exStatus(error, 'bad');
    return false;
  }
  if (!payload.ok) {
    // A broken fixture. The student can do nothing about it, so the message
    // names the table and says whose problem it is — an unexplained empty
    // schema is the version of this that produces a raised hand.
    exStatus(
      t('ex.broken_fixture', {
        label: payload.failedSource?.label ?? '',
        message: payload.error?.message ?? '',
      }),
      'bad',
    );
    exercise = { ...exercise, schema: payload.schema };
    return false;
  }

  exercise = { ...exercise, schema: payload.schema };
  exStatus('');
  return true;
}

/**
 * Wire the bar, once, if this page is in an exercise.
 *
 * Hides "CSV importieren" and "Datenbank zurücksetzen" while it is: the first
 * imports into the playground schema rather than the one on screen, and the
 * second drops the exercise along with everything else. Both have narrow
 * equivalents on the bar, which is the point.
 */
async function mountExercise() {
  if (exerciseId === null) return;

  const listing = await fetch('/api/my/exercises')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  exercise = listing?.exercises?.find((e) => e.id === exerciseId) ?? null;

  // A teacher testing their own exercise is not in its class, so it is not in
  // that list. Their title comes from the authoring route instead; a student who
  // genuinely has no such exercise is refused by `open` a moment later anyway.
  if (!exercise) {
    const authored = await fetch(`/api/exercises/${exerciseId}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    if (authored) {
      exercise = { id: exerciseId, title: authored.exercise.title, taskMd: authored.exercise.taskMd };
    }
  }
  if (!exercise) {
    exercise = { id: exerciseId, title: t('ex.heading'), taskMd: '' };
  }

  $('exercise').hidden = false;
  $('import').hidden = true;
  $('reset').hidden = true;
  $('exTitle').textContent = exercise.title;
  $('exTaskBody').innerHTML = renderMarkdown(exercise.taskMd);
  // Collapsed by default: the task is why they are here, but the editor is
  // where they work, and a long task would push it off the screen every reload.
  $('exTaskBody').hidden = false;

  $('exTask').onclick = () => {
    $('exTaskBody').hidden = !$('exTaskBody').hidden;
  };
  $('exLeave').onclick = () => (location.href = '/sql');
  $('exReset').onclick = () => void resetExercise();
  $('exSubmit').onclick = () => handIn();

  exStatus(t('ex.opening'));
  await openExercise();
  await loadCatalog();
}

async function resetExercise() {
  if (!confirm(t('ex.reset_confirm', { title: exercise.title }))) return;
  $('exReset').disabled = true;
  exStatus(t('ex.resetting'));
  try {
    const response = await fetch(`/api/my/exercises/${exerciseId}/reset`, json());
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      exStatus(payload?.error ? errorText(payload.error) : t('ex.reset_failed'), 'bad');
      return;
    }
    if (!payload.ok) {
      exStatus(
        t('ex.broken_fixture', {
          label: payload.failedSource?.label ?? '',
          message: payload.error?.message ?? '',
        }),
        'bad',
      );
      return;
    }
    $('results').innerHTML = '';
    exStatus(t('ex.reset_done'), 'ok');
    await loadCatalog();
  } catch {
    // Same hedge as the playground reset one screen away, and for the same
    // reason: a DROP SCHEMA plus a rebuild is the request here most likely to
    // outlive a proxy's patience, and its reply is then HTML that `json()`
    // rejects on — with the reset having quite possibly succeeded.
    exStatus(t('ex.reset_unknown'), 'bad');
  } finally {
    $('exReset').disabled = false;
  }
}

function handIn() {
  $('handInNote').value = '';
  $('handInStatus').textContent = '';
  $('handInStatus').className = 'msg';
  $('handInDialog').showModal();

  $('handInCancel').onclick = () => $('handInDialog').close();
  $('handInGo').onclick = async () => {
    const sql = editor.getValue();
    if (!sql.trim()) {
      $('handInStatus').className = 'msg bad';
      $('handInStatus').textContent = t('ex.hand_in_empty');
      return;
    }
    $('handInGo').disabled = true;
    try {
      const response = await fetch(
        `/api/my/exercises/${exerciseId}/submissions`,
        json({ sql, note: $('handInNote').value }),
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        $('handInStatus').className = 'msg bad';
        $('handInStatus').textContent = payload?.error
          ? errorText(payload.error)
          : t('ex.hand_in_failed');
        return;
      }
      $('handInDialog').close();
      exStatus(t('ex.handed_in', { n: payload.submission.attempt }), 'ok');
    } catch {
      $('handInStatus').className = 'msg bad';
      $('handInStatus').textContent = t('error.offline');
    } finally {
      $('handInGo').disabled = false;
    }
  };
}

// --- the schema browser ------------------------------------------------------

let catalog = null;

/** Never rejects: it is fired and forgotten after every execution. */
async function loadCatalog() {
  let response;
  try {
    response = await fetch('/api/workspace');
  } catch {
    $('tree').innerHTML = `<p class="empty">${esc(t('error.offline'))}</p>`;
    // The tree it belongs to is now an error message, and the figure beside it
    // would be from the last successful load — a number about a database we
    // have just failed to reach. Hide it rather than let it go quietly stale.
    renderQuota(null);
    return;
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    $('tree').innerHTML = `<p class="empty">${esc(payload?.error ? errorText(payload.error) : t('sql.tables_failed'))}</p>`;
    renderQuota(null);
    return;
  }

  catalog = await response.json().catch(() => null);
  if (!catalog) return;
  renderTree();
  renderQuota(catalog.quota);

  // Autocomplete comes from the student's *own* catalog, so it can only ever
  // suggest objects Postgres would let them read. `defaultSchema` is what makes
  // `SELECT * FROM kunden` complete unprefixed, matching search_path — so in an
  // exercise it has to be the exercise's schema, which is what the runner sets
  // `search_path` to. Getting this wrong would complete names that resolve to a
  // different schema than the one the query runs in.
  editor.setCatalog(
    Object.fromEntries(
      catalog.schemas.map((schema) => [
        schema.name,
        Object.fromEntries(schema.tables.map((t) => [t.name, t.columns.map((c) => c.name)])),
      ]),
    ),
    exercise?.schema ?? catalog.self,
  );
}

/**
 * Every schema this account owns: their playground, plus each exercise they have
 * opened.
 *
 * Used by the auto-run guard below, which is why it is a *set of names* and not
 * a pattern. `catalog.exercises` comes from `/api/workspace`, which reads
 * `exercise_workspace` for the caller — so it can only ever list schemas that
 * are theirs.
 */
const ownSchemas = () =>
  new Set([catalog?.self, ...(catalog?.exercises ?? []).map((e) => e.schema)].filter(Boolean));

/** `x7_u_k3a_muster_lena` → "Übung: Bestellungen", when we know the title. */
const schemaLabel = (name) => {
  const found = (catalog?.exercises ?? []).find((e) => e.schema === name);
  return found ? t('ex.schema_label', { title: found.title }) : name;
};

function renderTree() {
  $('tree').className = '';
  $('tree').innerHTML = catalog.schemas
    .map((schema) => {
      const tables = schema.tables
        .map((table) => {
          const columns = table.columns
            .map((c) => `${esc(c.name)} <span class="est">${esc(c.type)}</span>`)
            .join('<br />');
          const rows =
            table.estimatedRows === null
              ? ''
              : ` <span class="est">≈ ${number.format(table.estimatedRows)}</span>`;
          const suffix = table.kind === 'table' ? '' : ` <span class="est">${esc(table.kind)}</span>`;
          return `<button class="table" data-schema="${esc(schema.name)}" data-table="${esc(table.name)}"
                          title="${esc(t('sql.table_title'))}">${esc(table.name)}${suffix}${rows}</button>
                  <div class="cols">${columns || `<em>${esc(t('sql.no_columns'))}</em>`}</div>`;
        })
        .join('');

      /**
       * An empty schema says different things depending on whose it is, and
       * getting this wrong was a real complaint from a real lesson.
       *
       * `sql.no_tables` invites the reader to run `CREATE TABLE`, which is only
       * true of the schema they **own**. It was being shown for every empty
       * schema — including `public`, where `db/init/00-bootstrap.sh` does
       * `REVOKE CREATE ON SCHEMA public FROM PUBLIC` and hands ownership to
       * `dbk_app`. So the app was telling a student to run a statement that
       * Postgres would refuse.
       *
       * Note the rule is ownership, not role: a *teacher* cannot create in
       * `public` either, and neither can anyone in `demo` or in another
       * student's schema. `schema.own` is the only thing that answers it.
       */
      const empty = schema.own ? 'sql.no_tables' : 'sql.no_tables_readonly';

      // The caller's own schema is the one they came here for; a teacher's
      // list of student schemas stays collapsed.
      // The label is the exercise's title where there is one; the real schema
      // name goes in the tooltip, because it is what a student has to type to
      // qualify a table and `x7_u_k3a_muster_lena` is not a guessable string.
      return `<details${schema.own ? ' open' : ''}>
                <summary title="${esc(schema.name)}">${esc(schemaLabel(schema.name))}</summary>${
                  tables || `<p class="empty">${esc(t(empty))}</p>`
                }
              </details>`;
    })
    .join('');
}

/**
 * "12.4 MB von 50.0 MB" under the tree — HANDOFF §8.6.
 *
 * The point is the *before*, not the number. Until now a student met the quota
 * by being refused mid-lesson, which is the one moment they are least able to
 * act on it calmly; this is the same figure their teacher already reads in the
 * lesson view, shown to them while there is still room to do something about it.
 *
 * `null` hides the line rather than rendering a placeholder. It means the server
 * declined to measure — see routes/workspace.ts, where a failed measurement is
 * deliberately not allowed to cost the tree — and a dash where a number belongs
 * invites the reader to work out what went wrong. Nothing at all reads as
 * "this pane has no quota line", which is closer to true.
 *
 * `textContent`, so no escaping: `mb()` produces digits and a unit.
 */
function renderQuota(quota) {
  const node = $('quota');
  if (!quota) {
    node.hidden = true;
    return;
  }
  node.hidden = false;
  node.classList.toggle('bad', quota.overQuota);
  node.textContent = quota.overQuota
    ? t('sql.quota_full', { used: mb(quota.bytes), total: mb(quota.quotaBytes) })
    : t('sql.quota', { used: mb(quota.bytes), total: mb(quota.quotaBytes) });
}

// One delegated listener rather than a handler per table: a teacher's tree can
// hold several hundred buttons and it is rebuilt on every DDL statement.
$('tree').addEventListener('click', (event) => {
  const button = event.target.closest('.table');
  if (!button) return;
  // `run()` refuses while a query is in flight, so acting on the click anyway
  // would replace the student's SQL and then not run anything — their text
  // gone, no result, and no explanation.
  if (running) {
    $('status').textContent = t('sql.busy');
    return;
  }
  const { schema, table } = button.dataset;
  editor.setValue(`SELECT * FROM ${quote(schema)}.${quote(table)} LIMIT 50;`);
  // Auto-run everything except **another user's** schema.
  //
  // Selecting from someone else's relation executes *their* definition with
  // *our* privileges: a view is a stored query, and a function called inside it
  // is SECURITY INVOKER by default. `grantTeacherSql` revokes EXECUTE from
  // PUBLIC, but only for routines that exist when it runs — so this is the
  // layer that does not depend on that having covered everything. A teacher's
  // tree holds every student they teach, so one stray click is the exposure.
  //
  // The test is "a person's schema that is not mine", not `!== catalog.self`,
  // and the difference is the whole point: `demo` is not mine either, and it is
  // the schema every lesson starts from. It is owned by `dbk_app` and read-only
  // to PUBLIC, so no student can put a view or a function in it and there is
  // nothing to defend against. Blocking it cost a click on the most-used path in
  // the app and bought nothing — which is how this read the first time it was
  // written.
  //
  // Phase 9 widened both halves. The pattern gained `x<n>_`, because an exercise
  // workspace is a schema a *student* owns and can put a view in, and a teacher's
  // tree now holds one per student per exercise. And the "mine" test became a set
  // rather than one name, because this account owns several schemas now — without
  // that, clicking a table in your *own* exercise would refuse to auto-run.
  //
  // The statement is still loaded either way, so the cost is one keypress and
  // the teacher gets to see what they are about to run.
  if (!ownSchemas().has(schema) && /^([ut]_|x[0-9]+_)/.test(schema)) {
    $('status').textContent = t('sql.foreign_loaded');
    return;
  }
  void run();
});

// --- running -----------------------------------------------------------------

let running = false;

function setRunning(value) {
  running = value;
  $('run').disabled = value;
  $('cancel').disabled = !value;
}

async function run() {
  if (running) return;
  const sql = editor.getValue();
  if (!sql.trim()) return;

  setRunning(true);
  editor.markError(null);
  $('status').textContent = t('sql.running');

  let payload;
  try {
    // The *id*, never the schema name. Which schema this account means by
    // exercise 7 is the server's answer to give (`services/exercise.ts`), and
    // sending the name instead would make "run my SQL in schema X" something the
    // browser gets to ask for.
    const response = await fetch(
      '/api/query',
      json(exerciseId === null ? { sql } : { sql, exerciseId }),
    );
    payload = await response.json();
    if (!response.ok) {
      // A 4xx is something wrong with the *request* — not provisioned, previous
      // query still running, body too large. It carries the app's error shape,
      // not a Postgres error, and there is nothing to underline.
      const message = payload?.error ? errorText(payload.error) : t('sql.refused');
      // Also clear the status: it still says "läuft …", and leaving it there
      // while the pane below explains that the request was refused is the one
      // combination that makes a student wait for nothing.
      $('status').textContent = message;
      renderFailure(message, null);
      return;
    }
  } catch {
    $('status').textContent = t('error.offline');
    renderFailure(t('error.offline'), null);
    return;
  } finally {
    setRunning(false);
  }

  render(payload);
}

async function cancel() {
  // Disabled only for the round trip. It must come back if the request failed,
  // because the query it was meant to stop is still running — a Cancel button
  // that greys itself out on a network blip strands the student until the
  // watchdog fires, which is the whole problem it exists to solve.
  $('cancel').disabled = true;
  try {
    const response = await fetch('/api/query/cancel', json());
    const payload = await response.json();
    if (!response.ok) {
      $('status').textContent = payload?.error ? errorText(payload.error) : t('sql.cancel_failed');
      return;
    }
    // Zero is a normal answer, not a failure: the query finished in the gap
    // between the click and the request.
    if (payload.cancelled === 0) $('status').textContent = t('sql.already_done');
  } catch {
    $('status').textContent = t('sql.cancel_failed');
  } finally {
    // `running` is still true unless the run resolved while we were away, in
    // which case setRunning(false) has already had the last word.
    $('cancel').disabled = !running;
  }
}

async function reset() {
  const confirmed = confirm(t('sql.reset_confirm'));
  if (!confirmed) return;

  $('reset').disabled = true;
  $('status').textContent = t('sql.resetting');
  try {
    const response = await fetch('/api/workspace/reset', json());
    const payload = await response.json();
    if (!response.ok || !payload.provisioning?.ok) {
      $('status').textContent = payload?.error
        ? errorText(payload.error)
        : (payload?.provisioning?.error ?? t('sql.reset_failed'));
      return;
    }
    $('results').innerHTML = '';
    $('status').textContent = t('sql.reset_done');
    await loadCatalog();
  } catch {
    // A DROP SCHEMA CASCADE plus re-provision is the request in this whole page
    // most likely to outlive a proxy's patience, and the reply to a timed-out
    // one is an HTML error page that `response.json()` rejects on. Without this
    // the student is told nothing at all about the button they just pressed —
    // and the reset may well have succeeded.
    $('status').textContent = t('sql.reset_unknown');
  } finally {
    $('reset').disabled = false;
  }
}

/**
 * CSV upload. The dialog owns the whole conversation and hands back only the
 * table it made.
 *
 * Ending by running `SELECT * FROM …` is the point rather than a flourish: the
 * student's own data on screen is the confirmation that the import worked, and
 * it is the same thing clicking the table in the browser would have done.
 */
async function importCsv() {
  if (running) {
    $('status').textContent = t('sql.busy');
    return;
  }

  const result = await openImportDialog();
  if (!result) return;

  const [schema, table] = result.table.split('.');
  editor.setValue(`SELECT * FROM ${quote(schema)}.${quote(table)} LIMIT 50;`);
  // The status is set *after* the run, not before: `run()` writes its own
  // ("1 Anweisung · 3 ms"), and how many rows arrived is the more useful of
  // the two to be left looking at.
  await run();
  $('status').textContent = t('sql.imported', {
    table: result.table,
    rows: zeilen(result.rowCount),
  });
}

// Wired here rather than as an `onclick=` in the markup: an inline handler
// needs `script-src 'unsafe-inline'`, and this was the last one in the app.
$('overview').onclick = () => (location.href = '/');
$('exercises').onclick = () => (location.href = '/uebungen');
$('run').onclick = () => void run();
$('cancel').onclick = () => void cancel();
$('reset').onclick = () => void reset();
$('import').onclick = () => void importCsv();

// --- rendering the outcome ---------------------------------------------------

/**
 * Reload the tree after every execution, rather than only after a command tag
 * that looks like DDL.
 *
 * The obvious filter is wrong in both directions and was caught being wrong in
 * both. `CREATE TABLE zahlen AS SELECT …` reports its tag as **SELECT** — so a
 * "skip the refresh for SELECT" rule leaves the student staring at "no tables"
 * immediately after making one, which is the single most discouraging moment
 * the page could produce. And a *failed* script can still have changed things,
 * because an explicit `COMMIT;` breaks out of the implicit transaction and
 * commits everything before it.
 *
 * So: one extra catalog query per click. It is a single indexed read of
 * pg_class on a connection the run has already released.
 */
function render(outcome) {
  void loadCatalog();
  if (!outcome.ok) return renderQueryError(outcome);

  const statements = outcome.statements;
  $('status').textContent =
    `${statements.length === 1 ? t('sql.statement') : t('sql.statements', { n: statements.length })} · ` +
    `${number.format(outcome.durationMs)} ms`;

  $('results').innerHTML =
    statements.map(renderStatement).join('') ||
    `<p class="note">${esc(t('sql.nothing'))}</p>`;
}

const zeilen = (n) => `${number.format(n)} ${n === 1 ? t('sql.row') : t('sql.rows')}`;

function renderStatement(statement, index) {
  const { command, columns, rows, rowCount, truncated } = statement;

  // No columns means no result set — an INSERT, a CREATE TABLE. `rowCount` is
  // rows *affected* there, so it is worth saying for an INSERT and meaningless
  // for a CREATE, which always reports zero; "CREATE · 0 Zeilen" would invite a
  // student to wonder what went wrong with a statement that worked.
  const count = columns.length
    ? ` <span>· ${zeilen(rowCount)}</span>`
    : rowCount > 0
      ? ` <span>· ${esc(t('sql.changed', { rows: zeilen(rowCount) }))}</span>`
      : '';
  const heading = `<h3>${index + 1}. ${esc(command)}${count}</h3>`;

  if (!columns.length) return `<div class="stmt">${heading}</div>`;

  const head = columns.map((c) => `<th>${esc(c.name)}</th>`).join('');
  const body = rows
    .map(
      (row) =>
        `<tr>${row
          .map((cell) =>
            cell === null
              ? '<td class="null">NULL</td>'
              : `<td title="${esc(display(cell))}">${esc(display(cell))}</td>`,
          )
          .join('')}</tr>`,
    )
    .join('');

  // `rowCount` is Postgres's own count, so this says how much is missing rather
  // than just that something is.
  const note = truncated
    ? `<p class="note">${esc(t('sql.truncated', { shown: number.format(rows.length), total: zeilen(rowCount) }))}</p>`
    : '';

  return `<div class="stmt">${heading}
            <table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${note}
          </div>`;
}

/** json/jsonb and arrays arrive as objects; everything else is already scalar. */
const display = (cell) => (typeof cell === 'object' ? JSON.stringify(cell) : String(cell));

function renderQueryError(outcome) {
  const { error, cancelled } = outcome;

  if (cancelled) {
    const why =
      cancelled.reason === 'user' ? t('sql.cancelled_user') : t('sql.cancelled_timeout');
    $('status').textContent = why;
    renderFailure(why, null);
    return;
  }

  // textContent, so no escaping — esc() here would render a literal `&amp;`.
  $('status').textContent = t('sql.error_status', {
    code: error.code,
    ms: number.format(outcome.durationMs),
  });
  renderFailure(error.message, error, outcome.statements.length === 0);
}

/**
 * `error` is the Postgres detail when there is one, and null for a transport or
 * request-level failure — the difference decides whether there is a character
 * to underline in the editor.
 *
 * The explanation goes *above* the raw message, not below it (ARCHITECTURE
 * §8a). The raw text stays, in full and unaltered: it is what a student will
 * find if they paste the error into a search engine, and it is the only part
 * that is certainly true. The hint is the app's reading of it, and `hintFor`
 * returns null rather than guess.
 *
 * The raw message stays English in both locales, and that is not an oversight —
 * it is Postgres's own words, and the searchability is the whole reason it is
 * there. The hint above it is the part that speaks the student's language. An
 * English-locale student still gets one, because `42803` is restated by its
 * error message rather than explained by it.
 *
 * The `.hint-de` class name is now a misnomer — it is the hint in whatever
 * locale is active. Left alone deliberately: `sql.html`'s stylesheet keys the
 * adjacent-sibling rule `.hint-de + .msg` off it (§4ll), and renaming a class
 * to fix a comment is how a CSS rule silently stops applying.
 */
function renderFailure(message, error, scriptRolledBack = false) {
  const detail = error?.detail
    ? `<dt>${esc(t('sql.detail'))}</dt><dd>${esc(error.detail)}</dd>`
    : '';
  const hint = error?.hint ? `<dt>${esc(t('sql.hint'))}</dt><dd>${esc(error.hint)}</dd>` : '';
  const where = error?.position
    ? `<dt>${esc(t('sql.place'))}</dt><dd>${esc(place(error.position))}</dd>`
    : '';
  const code = error?.code ? `<dt>SQLSTATE</dt><dd><code>${esc(error.code)}</code></dd>` : '';

  const explained = renderHint(hintFor(error, catalog), t);
  const hinted = explained ? `<p class="hint-de">${ticked(explained)}</p>` : '';

  const rolledBack =
    scriptRolledBack && countStatements() > 1
      ? `<p class="note">${esc(MULTI_STATEMENT_ROLLBACK())}</p>`
      : '';

  $('results').innerHTML = `<div class="error">
      ${hinted}<p class="msg">${esc(message)}</p>
      <dl>${where}${detail}${hint}${code}</dl>${rolledBack}
    </div>`;

  editor.markError(error?.position ?? null);
}

/** Postgres's 1-based character offset, as a place a student can find. */
function place(position) {
  const before = editor.getValue().slice(0, position - 1).split('\n');
  return t('sql.position', { line: before.length, column: before.at(-1).length + 1 });
}

/** A cheap "is this a script?" — good enough to decide whether to mention rollback. */
const countStatements = () =>
  editor
    .getValue()
    .split(';')
    .filter((part) => part.trim().length > 0).length;

// `mountExercise` loads the catalog itself once the workspace exists, because a
// tree fetched before the schema is created would not show the exercise's
// tables — the pane a student is looking straight at, empty, on the one load
// where it matters most.
if (exerciseId === null) await loadCatalog();
else await mountExercise();
