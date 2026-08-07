/**
 * The exercises page — phase 9.
 *
 * One page and two audiences, branching on role the way `home.js` does. The
 * student's half is a list; the teacher's half is where an exercise is actually
 * built.
 *
 * ## Why the student *works* somewhere else
 *
 * This page hands a student a link to `/sql?uebung=<id>` rather than giving them
 * an editor here. That is not a layout preference: the CodeMirror bundle is the
 * app's only bundled entry point and CLAUDE.md says there will not be a second,
 * so there is exactly one page in this application with a SQL editor on it. The
 * shape of this feature follows from that constraint rather than fighting it,
 * and it turns out to be the right shape anyway — the exercise's tables belong
 * beside the schema browser, which is also only there.
 *
 * ## Why the teacher's SQL box is a `<textarea>`
 *
 * Same constraint, opposite conclusion. A teacher pasting a schema dump wants a
 * big box; highlighting would be nice and is not worth a second bundle.
 *
 * ## Two things that would be bugs if written the obvious way
 *
 * **Take-back and delete are behind two dialogs, and they say different things.**
 * `roster.js` set that precedent for deleting a student and its header has the
 * argument: two identical confirms are one confirm with an extra click. The
 * first asks the question, the second states what does not survive — here, that
 * the hand-ins go too.
 *
 * **The task preview goes through `markdown.js`, never through a template
 * string.** The task is text one person writes and twenty-five read, and it is
 * the only untrusted-ish thing in this app that reaches `innerHTML`. That module
 * escapes first and inserts tags second; anything else here uses `esc()`.
 */

import { openImportDialog, post } from '/assets/csv-import.js';
import { apply, errorText, formats, load, paintCached, t, wireLanguageSelect } from '/assets/i18n.js';
import { renderMarkdown } from '/assets/markdown.js';
import { esc, json, mountVersion, wireThemeToggle } from '/assets/util.js';

const $ = (id) => document.getElementById(id);

let me = null;
let list = [];
let classes = [];
/** The exercise open in the detail pane, in full. Null when none is. */
let open = null;

// --- transport ---------------------------------------------------------------

const get = async (url) => {
  const response = await fetch(url).catch(() => null);
  if (!response) return null;
  if (response.status === 401) {
    location.href = '/login';
    return null;
  }
  return response.ok ? response.json() : null;
};

/**
 * A mutating call, returning `[payload, errorMessage]`. Never throws — every
 * caller is a click handler, and an unhandled rejection in one is a button that
 * does nothing with no explanation. Same shape as `roster.js`'s.
 */
async function send(url, options) {
  const response = await fetch(url, options).catch(() => null);
  if (!response) return [null, t('error.offline')];
  if (response.status === 401) {
    location.href = '/login';
    return [null, t('error.unauthenticated')];
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    return [
      null,
      payload?.error ? errorText(payload.error) : t('common.failed', { status: response.status }),
    ];
  }
  return [payload, null];
}

const when = (value) => (value ? formats().dateTime(new Date(value)) : '—');

// --- the student's list ------------------------------------------------------

function renderMine() {
  if (list.length === 0) {
    $('mineList').innerHTML = `<p class="note">${esc(t('ex.none_yet'))}</p>`;
    return;
  }

  $('mineList').innerHTML = list
    .map(
      (exercise) => `
        <article class="card ex-card">
          <div class="hstack">
            <h2>${esc(exercise.title)}</h2>
            ${
              exercise.schema
                ? `<span class="tag">${esc(t('ex.opened'))}</span>`
                : `<span class="tag warn">${esc(t('ex.not_opened'))}</span>`
            }
          </div>
          <p class="sub">${esc(t('ex.by', { name: exercise.teacherName }))}</p>
          <div class="ex-task">${renderMarkdown(exercise.taskMd)}</div>
          <div class="hstack ex-actions">
            <a class="btn btn-primary" href="/sql?uebung=${encodeURIComponent(exercise.id)}"
               >${esc(t('ex.work_on'))}</a>
            <span class="small muted">${esc(
              exercise.submissions === 0
                ? t('ex.no_handins')
                : t('ex.handin_count', {
                    count: exercise.submissions,
                    when: when(exercise.lastSubmittedAt),
                  }),
            )}</span>
            ${
              exercise.submissions > 0
                ? `<button class="small" data-mine="${exercise.id}">${esc(t('ex.my_handins'))}</button>`
                : ''
            }
          </div>
        </article>`,
    )
    .join('');

  for (const button of $('mineList').querySelectorAll('[data-mine]')) {
    button.onclick = () => void showMyHandins(Number(button.dataset.mine));
  }
}

async function showMyHandins(exerciseId) {
  const exercise = list.find((e) => e.id === exerciseId);
  const payload = await get(`/api/my/exercises/${exerciseId}/submissions`);
  const submissions = payload?.submissions ?? [];
  $('handinTitle').textContent = exercise?.title ?? t('ex.heading');
  $('handinBody').innerHTML = submissions
    .map(
      (s) => `
        <section class="handin">
          <div class="hstack">
            <strong>${esc(t('ex.attempt', { n: s.attempt }))}</strong>
            <span class="small muted">${esc(when(s.createdAt))}</span>
            <a class="btn small"
               href="/api/my/exercises/${exerciseId}/submissions/${s.id}/download"
               >${esc(t('ex.download'))}</a>
          </div>
          ${s.note ? `<p class="small">${esc(s.note)}</p>` : ''}
          <pre><code>${esc(s.sqlText)}</code></pre>
        </section>`,
    )
    .join('');
  $('handinDialog').showModal();
}

// --- the teacher's list ------------------------------------------------------

function renderList() {
  if (list.length === 0) {
    $('list').innerHTML = `<p class="small muted">${esc(t('ex.none_authored'))}</p>`;
    return;
  }
  $('list').innerHTML = list
    .map(
      (exercise) => `
        <button class="ex-item${open?.id === exercise.id ? ' sel' : ''}" data-open="${exercise.id}">
          <span class="ex-item-title">${esc(exercise.title)}</span>
          <span class="small muted">${esc(when(exercise.updatedAt))}</span>
        </button>`,
    )
    .join('');
  for (const button of $('list').querySelectorAll('[data-open]')) {
    button.onclick = () => void openExercise(Number(button.dataset.open));
  }
}

async function reloadList() {
  const payload = await get('/api/exercises');
  list = payload?.exercises ?? [];
  renderList();
}

async function openExercise(id) {
  const payload = await get(`/api/exercises/${id}`);
  if (!payload) return;
  open = payload.exercise;
  renderList();
  renderDetail();
}

// --- the teacher's detail pane -----------------------------------------------

/** Which classes this exercise has *not* been handed to yet. */
const undistributed = () =>
  classes.filter((klass) => !open.assignments.some((a) => a.classId === klass.id));

function renderDetail() {
  if (!open) {
    $('detail').innerHTML = `<p class="note">${esc(t('ex.pick'))}</p>`;
    return;
  }

  $('detail').innerHTML = `
    <div class="card stack">
      <div class="hstack ex-detail-head">
        <input type="text" id="title" class="ex-title" maxlength="200"
               value="${esc(open.title)}" />
        <button id="save" class="primary small">${esc(t('common.save'))}</button>
        <button id="del" class="btn-danger small">${esc(t('common.delete'))}</button>
      </div>
      <p class="msg quiet" id="saveStatus"></p>

      <div class="ex-task-edit">
        <label class="block"><span>${esc(t('ex.task'))}</span>
          <textarea id="task" rows="10" spellcheck="true">${esc(open.taskMd)}</textarea>
        </label>
        <div>
          <span class="eyebrow">${esc(t('ex.preview'))}</span>
          <div class="ex-task" id="taskPreview"></div>
        </div>
      </div>
    </div>

    <div class="card stack">
      <div class="hstack ex-list-head">
        <h2>${esc(t('ex.tables'))}</h2>
        <button id="addCsv" class="small">${esc(t('ex.add_csv'))}</button>
        <button id="addSql" class="small">${esc(t('ex.add_sql'))}</button>
      </div>
      ${
        open.sources.length === 0
          ? `<p class="small muted">${esc(t('ex.no_tables'))}</p>`
          : `<div class="table-wrap"><table>
               <tbody>${open.sources
                 .map(
                   (source, i) => `
                     <tr>
                       <td><span class="tag">${esc(source.kind)}</span></td>
                       <td><code>${esc(source.label)}</code></td>
                       <td class="small muted">${esc(
                         source.kind === 'csv'
                           ? t('ex.csv_summary', {
                               rows: source.rowCount ?? 0,
                               columns: source.columns?.length ?? 0,
                             })
                           : t('ex.sql_summary'),
                       )}</td>
                       <td class="act">
                         ${
                           source.kind === 'sql'
                             ? `<button class="small" data-edit="${source.id}">${esc(t('common.edit'))}</button>`
                             : ''
                         }
                         <button class="small" data-up="${source.id}" ${i === 0 ? 'disabled' : ''}
                                 aria-label="${esc(t('ex.move_up'))}">↑</button>
                         <button class="small btn-danger" data-drop="${source.id}"
                                 >${esc(t('common.delete'))}</button>
                       </td>
                     </tr>`,
                 )
                 .join('')}</tbody>
             </table></div>`
      }
      <p class="msg quiet" id="sourceStatus"></p>
    </div>

    <div class="card stack">
      <h2>${esc(t('ex.distribution'))}</h2>
      ${
        open.assignments.length === 0
          ? `<p class="small muted">${esc(t('ex.not_distributed'))}</p>`
          : `<div class="table-wrap"><table>
               <thead><tr>
                 <th>${esc(t('ex.class'))}</th>
                 <th class="num">${esc(t('ex.opened_by'))}</th>
                 <th class="num">${esc(t('ex.handins'))}</th>
                 <th class="act"></th>
               </tr></thead>
               <tbody>${open.assignments
                 .map(
                   (a) => `
                     <tr>
                       <td><strong>${esc(a.code)}</strong> ${esc(a.name)}</td>
                       <td class="num">${a.openedBy}</td>
                       <td class="num">${a.submissions}</td>
                       <td class="act">
                         <button class="small" data-handins="${a.classId}"
                                 >${esc(t('ex.view_handins'))}</button>
                         <a class="btn small"
                            href="/api/exercises/${open.id}/classes/${a.classId}/download"
                            >${esc(t('ex.download_all'))}</a>
                         <button class="small btn-danger" data-take="${a.classId}"
                                 >${esc(t('ex.take_back'))}</button>
                       </td>
                     </tr>`,
                 )
                 .join('')}</tbody>
             </table></div>`
      }
      ${
        undistributed().length === 0
          ? ''
          : `<div class="hstack">
               <select id="klass">${undistributed()
                 .map((k) => `<option value="${k.id}">${esc(k.code)} — ${esc(k.name)}</option>`)
                 .join('')}</select>
               <button id="give" class="primary small">${esc(t('ex.distribute'))}</button>
             </div>`
      }
      <p class="msg quiet" id="giveStatus"></p>
    </div>

    <div class="card stack">
      <h2>${esc(t('ex.try_it'))}</h2>
      <p class="small muted">${esc(t('ex.try_it_why'))}</p>
      <div class="hstack">
        <button id="tryIt" class="small">${esc(t('ex.build_mine'))}</button>
        <a class="btn small" href="/sql?uebung=${open.id}">${esc(t('ex.open_editor'))}</a>
        <span class="small" id="tryStatus"></span>
      </div>
    </div>`;

  $('taskPreview').innerHTML = renderMarkdown(open.taskMd);
  $('task').oninput = () => {
    $('taskPreview').innerHTML = renderMarkdown($('task').value);
  };

  $('save').onclick = () => void saveExercise();
  $('del').onclick = () => void deleteExercise();
  $('addCsv').onclick = () => void addCsv();
  $('addSql').onclick = () => void editSql(null);
  if ($('give')) $('give').onclick = () => void distribute();
  $('tryIt').onclick = () => void buildMine();

  for (const button of $('detail').querySelectorAll('[data-edit]')) {
    button.onclick = () => void editSql(Number(button.dataset.edit));
  }
  for (const button of $('detail').querySelectorAll('[data-drop]')) {
    button.onclick = () => void dropSource(Number(button.dataset.drop));
  }
  for (const button of $('detail').querySelectorAll('[data-up]')) {
    button.onclick = () => void moveUp(Number(button.dataset.up));
  }
  for (const button of $('detail').querySelectorAll('[data-take]')) {
    button.onclick = () => void takeBack(Number(button.dataset.take));
  }
  for (const button of $('detail').querySelectorAll('[data-handins]')) {
    button.onclick = () => void showClassHandins(Number(button.dataset.handins));
  }
}

// --- the teacher's actions ---------------------------------------------------

async function saveExercise() {
  const [payload, error] = await send(
    `/api/exercises/${open.id}`,
    json({ title: $('title').value, taskMd: $('task').value }, 'PATCH'),
  );
  const status = $('saveStatus');
  if (error) {
    status.className = 'msg bad';
    status.textContent = error;
    return;
  }
  // The list's titles and its ordering both come from what was just saved.
  open = { ...open, ...payload.exercise };
  status.className = 'msg quiet';
  status.textContent = t('ex.saved');
  await reloadList();
}

async function deleteExercise() {
  if (!confirm(t('ex.delete_confirm', { title: open.title }))) return;
  // The second dialog states what does not survive rather than repeating the
  // first. See this file's header, and `roster.js`'s.
  if (!confirm(t('ex.delete_confirm_final', { title: open.title }))) return;
  const [, error] = await send(`/api/exercises/${open.id}`, json(undefined, 'DELETE'));
  if (error) {
    $('saveStatus').className = 'msg bad';
    $('saveStatus').textContent = error;
    return;
  }
  open = null;
  await reloadList();
  renderDetail();
}

async function addCsv() {
  const result = await openImportDialog({
    previewUrl: '/api/exercises/preview',
    // No "replace": the target schema is built from these sources, so there is
    // never an existing table for a fixture to replace.
    showReplace: false,
    submit: async (payload) => {
      const { source } = await post(`/api/exercises/${open.id}/sources/csv`, {
        label: payload.table,
        csv: payload.csv,
        columns: payload.columns,
        delimiter: payload.delimiter,
        hasHeader: payload.hasHeader,
      });
      // Normalised to the shape the dialog expects to report on success.
      return { ok: true, table: source.label, rowCount: source.rowCount ?? 0 };
    },
  });
  if (result) await openExercise(open.id);
}

/** `sourceId` null adds a new script; a number edits by replacing it. */
async function editSql(sourceId) {
  let existing = null;
  if (sourceId !== null) {
    const payload = await get(`/api/exercises/${open.id}/sources/${sourceId}`);
    existing = payload?.source ?? null;
  }
  $('sqlLabel').value = existing?.label ?? '';
  $('sqlBody').value = existing?.sqlText ?? '';
  $('sqlStatus').textContent = '';
  $('sqlDialog').showModal();

  $('sqlCancel').onclick = () => $('sqlDialog').close();
  $('sqlSave').onclick = async () => {
    const body = json({ label: $('sqlLabel').value, sql: $('sqlBody').value });
    // Editing is delete-then-add rather than a PATCH route. A script has no
    // identity worth preserving — nothing references it — and one write path is
    // one thing to get right. It does move the script to the end of the order,
    // which the arrows fix and which is why they exist.
    const [, error] = await send(`/api/exercises/${open.id}/sources/sql`, body);
    if (error) {
      $('sqlStatus').className = 'msg bad';
      $('sqlStatus').textContent = error;
      return;
    }
    if (sourceId !== null) {
      await send(`/api/exercises/${open.id}/sources/${sourceId}`, json(undefined, 'DELETE'));
    }
    $('sqlDialog').close();
    await openExercise(open.id);
  };
}

async function dropSource(sourceId) {
  const source = open.sources.find((s) => s.id === sourceId);
  if (!confirm(t('ex.drop_source_confirm', { label: source?.label ?? '' }))) return;
  const [, error] = await send(
    `/api/exercises/${open.id}/sources/${sourceId}`,
    json(undefined, 'DELETE'),
  );
  if (error) {
    $('sourceStatus').className = 'msg bad';
    $('sourceStatus').textContent = error;
    return;
  }
  await openExercise(open.id);
}

async function moveUp(sourceId) {
  const ids = open.sources.map((s) => s.id);
  const at = ids.indexOf(sourceId);
  if (at <= 0) return;
  [ids[at - 1], ids[at]] = [ids[at], ids[at - 1]];
  const [, error] = await send(`/api/exercises/${open.id}/sources/order`, json({ ids }));
  if (error) {
    $('sourceStatus').className = 'msg bad';
    $('sourceStatus').textContent = error;
    return;
  }
  await openExercise(open.id);
}

async function distribute() {
  const [, error] = await send(
    `/api/exercises/${open.id}/classes`,
    json({ classId: Number($('klass').value) }),
  );
  if (error) {
    $('giveStatus').className = 'msg bad';
    $('giveStatus').textContent = error;
    return;
  }
  await openExercise(open.id);
}

async function takeBack(classId) {
  const assignment = open.assignments.find((a) => a.classId === classId);
  if (!confirm(t('ex.take_back_confirm', { klass: assignment?.code ?? '' }))) return;
  // The second dialog names the numbers rather than repeating the question:
  // this is the one action on the page that destroys other people's work, and
  // the count is what makes that concrete.
  if (
    !confirm(
      t('ex.take_back_confirm_final', {
        klass: assignment?.code ?? '',
        workspaces: assignment?.openedBy ?? 0,
        handins: assignment?.submissions ?? 0,
      }),
    )
  ) {
    return;
  }

  const [payload, error] = await send(
    `/api/exercises/${open.id}/classes/${classId}`,
    json(undefined, 'DELETE'),
  );
  if (error) {
    $('giveStatus').className = 'msg bad';
    $('giveStatus').textContent = error;
    return;
  }
  open = payload.exercise;
  renderDetail();
  // Reported rather than swallowed: one schema that would not drop leaves the
  // rest correct, and the teacher has to be able to see that it happened.
  if (payload.failures?.length) {
    $('giveStatus').className = 'msg bad';
    $('giveStatus').textContent = t('ex.take_back_partial', { count: payload.failures.length });
  }
}

async function showClassHandins(classId) {
  const assignment = open.assignments.find((a) => a.classId === classId);
  const payload = await get(`/api/exercises/${open.id}/submissions?classId=${classId}`);
  const submissions = payload?.submissions ?? [];
  $('handinTitle').textContent = `${open.title} — ${assignment?.code ?? ''}`;
  $('handinBody').innerHTML = submissions.length
    ? submissions
        .map(
          (s) => `
            <section class="handin">
              <div class="hstack">
                <strong>${esc(s.displayName)}</strong>
                <span class="tag">${esc(t('ex.attempt', { n: s.attempt }))}</span>
                <span class="small muted">${esc(when(s.createdAt))}</span>
                <a class="btn small"
                   href="/api/exercises/${open.id}/submissions/${s.id}/download"
                   >${esc(t('ex.download'))}</a>
              </div>
              ${s.note ? `<p class="small">${esc(s.note)}</p>` : ''}
              <pre><code>${esc(s.sqlText)}</code></pre>
            </section>`,
        )
        .join('')
    : `<p class="note">${esc(t('ex.no_handins_yet'))}</p>`;
  $('handinDialog').showModal();
}

/**
 * Build the teacher their own copy, so they can run the fixtures before a class
 * does. `openWorkspace` answers `ok: false` with the source that broke, which is
 * the only thing that makes a bad script fixable by the person who wrote it.
 */
async function buildMine() {
  $('tryStatus').className = 'small muted';
  $('tryStatus').textContent = t('ex.building');
  const [payload, error] = await send(`/api/my/exercises/${open.id}/open`, json(undefined));
  if (error) {
    $('tryStatus').className = 'small bad';
    $('tryStatus').textContent = error;
    return;
  }
  if (!payload.ok) {
    $('tryStatus').className = 'small bad';
    $('tryStatus').textContent = t('ex.build_failed', {
      label: payload.failedSource?.label ?? '',
      message: payload.error?.message ?? '',
    });
    return;
  }
  $('tryStatus').className = 'small ok';
  $('tryStatus').textContent = payload.materialised
    ? t('ex.built', { schema: payload.schema })
    : t('ex.already_built', { schema: payload.schema });
}

// --- boot --------------------------------------------------------------------

const mePromise = get('/api/me');
await paintCached();
const paintTheme = wireThemeToggle($('theme'), (dark) =>
  t(dark ? 'nav.theme_light' : 'nav.theme_dark'),
);

me = await mePromise;
if (!me) location.href = '/login';

await load(me.user.locale);
apply();
paintTheme();
wireLanguageSelect($('lang'));
void mountVersion($('version'), (date) => formats().dateTime(date));

const staff = me.user.role === 'teacher' || me.user.role === 'admin';
$('lesson').hidden = me.user.role !== 'teacher';
$('roster').hidden = !staff;
$('help').hidden = !staff;
// Admins have no Postgres identity, so there is no editor for them to open.
$('sql').hidden = me.user.role === 'admin';

$('sql').onclick = () => (location.href = '/sql');
$('lesson').onclick = () => (location.href = '/lesson');
$('roster').onclick = () => (location.href = '/roster');
$('overview').onclick = () => (location.href = '/');
$('handinClose').onclick = () => $('handinDialog').close();

if (staff) {
  $('teach').hidden = false;
  const [exercises, klasses] = await Promise.all([get('/api/exercises'), get('/api/classes')]);
  list = exercises?.exercises ?? [];
  classes = klasses?.classes ?? [];
  renderList();
  renderDetail();

  $('new').onclick = async () => {
    const [payload, error] = await send('/api/exercises', json({ title: t('ex.untitled') }));
    if (error) return;
    await reloadList();
    await openExercise(payload.exercise.id);
  };
} else {
  $('mine').hidden = false;
  const payload = await get('/api/my/exercises');
  list = payload?.exercises ?? [];
  renderMine();
}
