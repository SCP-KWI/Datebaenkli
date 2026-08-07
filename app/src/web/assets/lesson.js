/**
 * The live lesson view — phase 4.
 *
 * Plain module, served as written, like every page script except the editor
 * bundle. It talks only to `/api/lesson/*`, which does the access checks.
 *
 * Polling, not a stream: server-sent events would be one more thing to keep
 * alive through the reverse proxy, and the useful resolution here is "did
 * something change since I last looked up", not milliseconds. A chained
 * `setTimeout` rather than `setInterval` — a slow response must not let a
 * second request stack behind the first — and it stops entirely while the tab
 * is hidden, because a lesson view left open overnight should not poll 17 000
 * times before morning.
 */

import { apply, formats, load, paintCached, t, wireLanguageSelect } from './i18n.js';
import { esc, mb, mountVersion, wireThemeToggle } from './util.js';

const REFRESH_MS = 5000;

const $ = (id) => document.getElementById(id);
const classSelect = $('class');
const windowSelect = $('window');
const content = $('content');
const dialog = $('detail');

let timer = null;
/** Set while a student dialog is open: the poll keeps running, this does not. */
let openStudent = null;

/**
 * Never rejects. A transport failure returns null, exactly as a non-ok response
 * already does — the caller cannot do anything different about the two, and the
 * one thing it must not do is throw: the bootstrap at the bottom of this file
 * consumes `get()` from a top-level `await`, so a rejection there aborts module
 * evaluation and leaves the teacher on the bare HTML shell with no error. That
 * is §4k's failure one level down, and it is why `sql.js` and `roster.js` both
 * guard their fetches the same way.
 */
const get = async (url) => {
  const response = await fetch(url).catch(() => null);
  if (!response) return null;
  if (response.status === 401) {
    location.href = '/login';
    return null;
  }
  return response.ok ? response.json() : null;
};

/** "vor 4 Min." — relative is what a teacher actually reads mid-lesson. */
function ago(iso) {
  if (!iso) return '—';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 10) return t('lesson.just_now');
  if (seconds < 90) return t('lesson.ago_seconds', { n: seconds });
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return t('lesson.ago_minutes', { n: minutes });
  return t('lesson.ago_hours', { n: Math.round(minutes / 60) });
}

/**
 * Row counts, in the two places the drill-down shows one. `sql.row`/`sql.rows`
 * rather than a pair of its own — it is the same word about the same thing, and
 * a student and their teacher should not read two translations of it.
 */
const rowsLabel = (n) => `${n} ${n === 1 ? t('sql.row') : t('sql.rows')}`;

/** The quota cell, which is the whole answer to "why is this student silent". */
function quotaCell(quota) {
  if (!quota) return '<td class="quiet">—</td>';
  const text = `${esc(mb(quota.bytes))} / ${esc(mb(quota.quotaBytes))}`;
  return quota.overQuota
    ? `<td class="num bad"><span class="tag bad">${esc(t('lesson.over_quota'))}</span> ${text}</td>`
    : `<td class="num quiet">${text}</td>`;
}

function statementCell(statement) {
  if (!statement) return `<td class="sql quiet">${esc(t('lesson.nothing_run'))}</td>`;
  const failed = statement.errorCode !== null;
  const first = statement.sql.trim().split('\n')[0] ?? '';
  return `<td class="sql">
      <pre${failed ? ' class="bad"' : ''}>${esc(first)}</pre>
      <span class="quiet">${esc(ago(statement.at))}${
        failed ? ` · <span class="bad">${esc(statement.errorCode)}</span>` : ''
      }</span>
    </td>`;
}

function render(view) {
  if (view.students.length === 0) {
    content.innerHTML = `<p class="quiet">${esc(t('common.class_empty'))}</p>`;
    return;
  }

  const rows = view.students
    .map(
      (s) => `<tr class="row" data-id="${s.userId}">
        <td>${esc(s.displayName)}<br /><code class="quiet">${esc(s.username)}</code></td>
        <td>${s.signedIn ? `<span class="tag">${esc(t('lesson.signed_in'))}</span>` : '<span class="quiet">—</span>'}</td>
        ${statementCell(s.lastStatement)}
        <td class="num">${s.statements}</td>
        <td class="num${s.errors > 0 ? ' warn' : ' quiet'}">${s.errors}</td>
        ${quotaCell(s.quota)}
      </tr>`,
    )
    .join('');

  content.innerHTML = `<table>
      <thead><tr>
        <th>${esc(t('lesson.col_student'))}</th><th>${esc(t('lesson.col_session'))}</th>
        <th>${esc(t('lesson.col_last'))}</th>
        <th class="num">${esc(t('lesson.statements'))}</th>
        <th class="num">${esc(t('lesson.col_errors'))}</th>
        <th class="num">${esc(t('lesson.col_storage'))}</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  for (const row of content.querySelectorAll('tr.row')) {
    row.addEventListener('click', () => showStudent(Number(row.dataset.id)));
  }
}

function renderDetail(detail) {
  const { student, statements, schema } = detail;
  const tables = schema?.tables ?? [];

  const log = statements.length
    ? statements
        .map(
          (s) => `<li>
            <pre${s.errorCode ? ' class="bad"' : ''}>${esc(s.sql)}</pre>
            <span class="quiet">${esc(ago(s.at))}${
              s.errorCode
                // The Postgres message stays raw: it is what a student will
                // paste into a search engine, and translating it would be
                // inventing a sentence Postgres never said (`hints.js`).
                ? ` · <span class="bad">${esc(s.errorCode)} ${esc(s.errorMessage ?? '')}</span>`
                : ` · ${esc(rowsLabel(s.rowCount ?? 0))} · ${s.durationMs ?? '?'} ms`
            }</span>
          </li>`,
        )
        .join('')
    : `<li class="quiet">${esc(t('lesson.no_statements'))}</li>`;

  // Absent and empty are different things, and the schema browser makes the
  // same distinction for the same reason (services/catalog.ts).
  // The table parameter is `table`, not the `t` it was: `t` is the translator
  // now, and the two cannot share a name in the same template literal.
  const tree =
    schema === null
      ? `<p class="quiet">${esc(t('lesson.no_schema'))}</p>`
      : tables.length === 0
        ? `<p class="quiet">${esc(t('lesson.schema_empty'))}</p>`
        : `<ul>${tables
            .map(
              (table) =>
                `<li><code>${esc(table.name)}</code> <span class="quiet">${
                  table.estimatedRows === null
                    ? esc(t('lesson.not_counted'))
                    : `≈ ${esc(rowsLabel(table.estimatedRows))}`
                }</span></li>`,
            )
            .join('')}</ul>`;

  $('detail-body').innerHTML = `
    <h2>${esc(student.displayName)}</h2>
    <p class="sub"><code>${esc(student.username)}</code>${
      student.quota?.overQuota
        ? ` · <span class="tag bad">${esc(t('lesson.over_quota_detail'))}</span>`
        : ''
    }</p>
    <div class="cols">
      <div><h3>${esc(t('lesson.statements'))}</h3><ul>${log}</ul></div>
      <div><h3>${esc(t('sql.tables'))}</h3>${tree}</div>
    </div>`;
}

async function showStudent(userId) {
  openStudent = userId;
  const detail = await get(`/api/lesson/classes/${classSelect.value}/students/${userId}`);
  if (!detail || openStudent !== userId) return;
  renderDetail(detail);
  if (!dialog.open) dialog.showModal();
}

async function poll() {
  if (classSelect.value) {
    const view = await get(
      `/api/lesson/classes/${classSelect.value}?minutes=${windowSelect.value}`,
    );
    // A failed refresh leaves the last good table standing rather than clearing
    // it: mid-lesson this is usually a five-second blip, and a teacher reading
    // the room is better served by slightly stale rows than by an empty screen.
    // The timestamp in `sub` stops advancing, which is the tell.
    if (view) {
      render(view);
      $('sub').textContent = t('lesson.sub', {
        count: view.students.length,
        // `de-CH` or `en-CH` — the language follows the interface, the region
        // does not. Both render 24-hour time, so the clock reads the same for
        // everyone in the room either way. `formats()` in `i18n.js` has why.
        time: formats().time(new Date(view.since)),
      });
    }
  }
  schedule();
}

function schedule() {
  clearTimeout(timer);
  if (!document.hidden) timer = setTimeout(poll, REFRESH_MS);
}

document.addEventListener('visibilitychange', () => {
  // Coming back should show the truth immediately, not in five seconds.
  if (document.hidden) clearTimeout(timer);
  else void poll();
});

$('refresh').addEventListener('click', () => void poll());
// "In dieser Klasse ist noch niemand eingetragen" is the message most likely to
// need the roster page, so the way there is on this screen rather than via home.
$('roster').addEventListener('click', () => (location.href = '/roster'));
$('exercises').addEventListener('click', () => (location.href = '/uebungen'));
$('home').addEventListener('click', () => (location.href = '/'));
$('close').addEventListener('click', () => {
  openStudent = null;
  dialog.close();
});
dialog.addEventListener('close', () => (openStudent = null));
classSelect.addEventListener('change', () => void poll());
windowSelect.addEventListener('change', () => void poll());

// `location.href = …` does not stop the script, so the redirects below have to
// be followed by one that does. Without it every request beneath this point is
// fired into a page that is already navigating away — harmless but pointless —
// and `me.user` would have to be read defensively for a `me` that is only null
// when we are leaving anyway. `sql.js` throws after its redirects for the same
// reason.
// Started before the cached paint rather than awaited, so the round trip hides
// behind the first frame instead of sitting in front of it (`paintCached()`).
const mePromise = get('/api/me');
await paintCached();
const paintTheme = wireThemeToggle($('theme'), (dark) =>
  t(dark ? 'nav.theme_light' : 'nav.theme_dark'),
);

const me = await mePromise;
if (!me) location.href = '/login';
else if (me.user.role === 'student') location.href = '/sql';
if (!me || me.user.role === 'student') throw new Error('redirecting');

/**
 * Before anything renders. The page ships with German in its markup and this
 * swaps it, so doing it after the first `poll()` would leave the table — which
 * is built by script — in the wrong language entirely.
 *
 * It also overrides whatever the cached paint above chose, which is the whole
 * reason that cache is safe to have: the account decides, `localStorage` only
 * guesses ahead of it.
 */
await load(me.user.locale);
apply();
// After apply(), not before: the toggle's label depends on which way it
// currently points, which no `data-i18n` key can express.
paintTheme();
wireLanguageSelect($('lang'));
mountVersion($('version'), (d) => formats().dateTime(d));

/**
 * Null and `{ classes: [] }` are different answers and must not render the same
 * sentence. `?? []` used to flatten them, so a teacher whose connection dropped
 * on this one request was told "Noch keine Klasse" — a confident, wrong
 * statement about their account, which is worse than the blank page this used to
 * be. Only a 200 can say that; anything else says the server did not answer.
 */
const payload = await get('/api/classes');
if (!payload) {
  content.innerHTML = `<p class="quiet">${esc(t('error.offline'))}</p>`;
  $('sub').textContent = '';
} else if (payload.classes.length === 0) {
  content.innerHTML = `<p class="quiet">${esc(t('common.no_classes'))}</p>`;
  $('sub').textContent = '';
} else {
  classSelect.innerHTML = payload.classes
    .map((c) => `<option value="${c.id}">${esc(c.code)} — ${esc(c.name)}</option>`)
    .join('');
  await poll();
}
