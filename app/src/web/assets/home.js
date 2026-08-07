/**
 * The overview page.
 *
 * Split out of `home.html` when the Content-Security-Policy went in (phase 8.2):
 * an inline `<script type="module">` needs `script-src 'unsafe-inline'`, which
 * would have made the whole policy decorative. Three of the six pages already
 * kept their logic in a file, so this is the established shape rather than a new
 * one — `sql.js`, `roster.js` and `lesson.js` are the precedent.
 */

import { apply, formats, load, paintCached, t, wireLanguageSelect } from '/assets/i18n.js';
import { esc, mountVersion, wireThemeToggle } from '/assets/util.js';

const get = async (url) => {
  const response = await fetch(url);
  return response.ok ? response.json() : null;
};

const byId = (id) => document.getElementById(id);

// Started before the paint rather than awaited: `paintCached()` exists to
// hide this round trip behind the first frame, and awaiting it here would
// put the round trip back in front of it.
const mePromise = get('/api/me');
await paintCached();
const paintTheme = wireThemeToggle(byId('theme'), (dark) =>
  t(dark ? 'nav.theme_light' : 'nav.theme_dark'),
);

const me = await mePromise;
if (!me) location.href = '/login';
else if (me.user.mustChangePassword) location.href = '/password';
else {
  const user = me.user;

  // Before anything renders: the page ships with German in its markup and
  // this swaps it, so doing it after the tables were built would leave
  // half the screen in the wrong language. `sql.js` has the long version.
  // This is also the pass that makes the cached frame above safe — the
  // account, not `localStorage`, decides.
  await load(user.locale);
  apply();
  // After apply(), not before: the toggle's label depends on which way it
  // currently points, which no `data-i18n` key can express.
  paintTheme();
  wireLanguageSelect(byId('lang'));
  mountVersion(byId('version'), (d) => formats().dateTime(d));

  byId('name').textContent = user.displayName;
  // Spelt out rather than `t('common.role_' + user.role)`: a key built by
  // concatenation is a key that grep cannot find when it is renamed.
  const roleKey = {
    admin: 'common.role_admin',
    teacher: 'common.role_teacher',
    student: 'common.role_student',
  }[user.role];
  byId('role').textContent = `${user.username} · ${t(roleKey)}`;

  /**
   * Escaping happens *here*, not at the call sites.
   *
   * It used to be the caller's job, and every caller did remember — except
   * `memberCount`, which was safe only because it is an integer. That is one
   * column away from a class name rendering as markup in the admin's page, and
   * the person who adds that column has no reason to suspect the difference.
   * A cell function returning a string can now no longer be a mistake.
   *
   * The one thing a cell may still need is markup of its own (`<code>`), so
   * cells return either a string, which is escaped, or `{ html }`, which is
   * not — and every `{ html }` in this file is built from `esc()` output.
   */
  const table = (caption, columns, rows) => {
    if (!rows?.length) return '';
    const cell = (value) => (typeof value === 'object' && value?.html ? value.html : esc(value));
    const head = columns.map(([label]) => `<th>${esc(label)}</th>`).join('');
    const body = rows
      .map((row) => `<tr>${columns.map(([, get]) => `<td>${cell(get(row))}</td>`).join('')}</tr>`)
      .join('');
    return `<h2>${esc(caption)}</h2>
            <div class="table-wrap">
              <table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
            </div>`;
  };

  const code = (value) => ({ html: `<code>${esc(value)}</code>` });

  let html = '';
  if (user.role === 'admin') {
    const { teachers } = (await get('/api/teachers')) ?? {};
    // The cell parameter is `row`, not the `t` it used to be: `t` is the
    // translator now, and a cell function that shadows it is one edit away
    // from calling a teacher object.
    html += table(
      t('home.teachers'),
      [
        [t('common.name'), (row) => row.displayName],
        [t('common.username'), (row) => code(row.username)],
        [t('common.state'), (row) => row.state],
      ],
      teachers,
    );
  }
  if (user.role === 'admin' || user.role === 'teacher') {
    const { classes } = (await get('/api/classes')) ?? {};
    html += table(
      t('home.classes'),
      [
        [t('home.col_code'), (c) => code(c.code)],
        [t('common.name'), (c) => c.name],
        [t('common.teacher'), (c) => c.teacherName],
        [t('common.students'), (c) => c.memberCount],
      ],
      classes,
    );
  }
  byId('content').innerHTML = html || `<p class="muted">${esc(t('home.nothing'))}</p>`;

  // An admin has no Postgres identity, so /sql has nothing to show them.
  byId('sql').hidden = user.role === 'admin';
  // The lesson view is the other way round: staff only, and an admin does
  // get it — they can reach any class, they just see no schema pane.
  byId('lesson').hidden = user.role === 'student';
  // Same audience as the lesson view, and the page an admin needs most:
  // it is the only way to create a teacher without curl.
  byId('roster').hidden = user.role === 'student';
  // Same audience again: the handbook describes exactly the two pages above.
  // This shell is the overview for students too, which is why the button is
  // gated here and simply absent from `/sql` — sql.html says what a
  // student-facing help would have to be instead, and it is not this document.
  byId('help').hidden = user.role === 'student';
  // Everyone but an admin: a student has exercises handed to them, a teacher
  // authors them, and an admin has no Postgres identity to hold either.
  byId('exercises').hidden = user.role === 'admin';
}

byId('sql').onclick = () => (location.href = '/sql');
byId('lesson').onclick = () => (location.href = '/lesson');
byId('roster').onclick = () => (location.href = '/roster');
byId('exercises').onclick = () => (location.href = '/uebungen');
byId('change').onclick = () => (location.href = '/password');
byId('logout').onclick = async () => {
  // The content-type is not optional: it is the CSRF control, so a POST
  // without it is a 415 and the session would survive the "logout".
  await fetch('/api/logout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  location.href = '/login';
};
