/**
 * The CSV upload dialog — the client half of `/api/workspace/import`.
 *
 * A separate module from `sql.js` rather than another 200 lines inside it:
 * this is a self-contained conversation with its own state (a chosen file, an
 * edited column list) that only reports one thing back — the table it made.
 *
 * ## The preview is the feature
 *
 * It would be shorter to upload and create in one call. The point of showing
 * the inferred types in an editable list first is that correcting them *is* the
 * lesson (architecture §4): a column of postcodes guessed as `integer` is the
 * moment a student finds out why `8003` and `"8003"` are different things. So
 * the dialog is deliberately two steps, and the second one is a form, not a
 * confirmation.
 *
 * ## Why the file is read here and sent as a JSON string
 *
 * `multipart/form-data` would be the obvious transport and cannot be used:
 * it is CORS-safelisted, and requiring `application/json` on every
 * state-changing call is the app's whole CSRF defence (server.ts). So the
 * browser reads the bytes and sends them as a string, twice — once to preview
 * and once to import. Ten megabytes over a school LAN, in exchange for a server
 * that holds no upload state between the two requests.
 */

import { hintFor, renderHint } from '/assets/hints.js';
import { errorText, formats, t } from '/assets/i18n.js';
import { esc, json, ticked } from '/assets/util.js';

/** Lazy for the reason the identical wrapper in `sql.js` is; `i18n.js` has it. */
const number = { format: (value) => formats().number.format(value) };

/** Must match COLUMN_TYPES in services/csv.ts. The gloss teaches the mapping. */
const TYPES = [
  ['text', 'type.text'],
  // The second element is a catalogue key, not a label: these are read through
  // `t()` at render time, because the dialog is rebuilt on every preview but
  // this table is built once at module load, before the locale is known.
  ['integer', 'type.integer'],
  ['bigint', 'type.bigint'],
  ['numeric', 'type.numeric'],
  ['boolean', 'type.boolean'],
  ['date', 'type.date'],
  ['timestamp', 'type.timestamp'],
];

/** Mirrors MAX_CSV_LENGTH in services/import.ts, so the refusal is instant. */
const MAX_BYTES = 10 * 1024 * 1024;

const el = (id) => document.getElementById(id);

/**
 * Decode the file, guessing the encoding rather than assuming UTF-8.
 *
 * `file.text()` assumes UTF-8 and replaces anything else with U+FFFD, which
 * turns every `ä` in a German dataset into `�` — silently, and unrecoverably,
 * because the original bytes are gone by the time anyone notices. Excel on
 * Windows still writes Windows-1252 unless explicitly told to do otherwise, so
 * that is exactly the file this app will be handed most often.
 *
 * The `fatal` decoder is what makes the guess safe: it *throws* on a byte
 * sequence that is not valid UTF-8, and valid UTF-8 is a strong enough signal
 * that a file passing it is essentially never Windows-1252.
 */
async function readText(file) {
  const buffer = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

/**
 * POST JSON and throw the translated error on a 4xx/5xx.
 *
 * Module-scope since phase 9 so the second caller's `submit` can reach it: the
 * useful half is `errorText()` rather than `error.message`, and a caller that
 * writes its own fetch is a caller that shows the English developer sentence to
 * a German-speaking teacher.
 */
export async function post(path, body) {
  const response = await fetch(path, json(body));
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error ? errorText(payload.error) : t('import.refused'));
  }
  return payload;
}

/**
 * Open the dialog and run one import.
 *
 * Resolves with `{ table, rowCount }` when a table was created, or `null` when
 * the student backed out — so the caller can reload the schema browser and show
 * the new table without knowing anything about what happened in between.
 *
 * ## Two callers since phase 9, and what is parameterised
 *
 * The student uploads into their own schema; a teacher uploads a fixture into an
 * exercise. Everything a person *does* here is identical — pick a file, look at
 * the guessed types, correct them — and that interaction is the whole value of
 * this file, so it is shared rather than written twice. What differs is only the
 * two endpoints and one checkbox, so those are the options:
 *
 *   - `previewUrl` — both routes answer the identical `previewCsv` shape, which
 *     is why one renderer serves both;
 *   - `submit` — the caller does its own POST and normalises the answer to
 *     `{ ok, table, rowCount }` or `{ ok: false, errors | error }`. A URL alone
 *     would not do: the two routes take different field names and answer
 *     different shapes, and hiding that behind a flag here would put the
 *     difference in the place least likely to be read;
 *   - `showReplace` — "replace the existing table" means nothing when the target
 *     schema is built fresh from these very sources.
 *
 * The dialog's markup is copied into both pages, `sql.html` and `uebungen.html`,
 * for the reason `routes/pages.ts` gives for the copied `<head>`: there is no
 * template engine and deliberately no want of one. `test/pages.test.mjs` asserts
 * the two copies have not drifted, which is `test/chalk.test.mjs`'s trick and is
 * the only thing that makes copying safe.
 */
export function openImportDialog(options = {}) {
  const {
    previewUrl = '/api/workspace/import/preview',
    showReplace = true,
    submit = (payload) => post('/api/workspace/import', payload),
  } = options;
  const dialog = el('importDialog');

  /** The raw file text, kept so the confirm step can send the same bytes again. */
  let csv = '';
  let preview = null;
  let done = null;

  const status = (message) => {
    el('importStatus').textContent = message ?? '';
  };

  const setBusy = (busy) => {
    el('importGo').disabled = busy || preview === null || preview.columns.length === 0;
    el('importFile').disabled = busy;
  };

  function renderPreview({ keepTableName = false } = {}) {
    el('importConfig').hidden = false;
    if (!keepTableName) el('importTable').value = preview.table;
    el('importHeader').checked = preview.hasHeader;
    el('importDelimiter').value = preview.delimiter;

    const rows = preview.totalRows;
    el('importSummary').textContent =
      t('import.summary', {
        rows: `${number.format(rows)} ${rows === 1 ? t('sql.row') : t('sql.rows')}`,
        columns: preview.columns.length,
      });

    el('importColumns').innerHTML = preview.columns
      .map(
        (column, i) => `
          <tr>
            <td class="src">${esc(column.sourceName)}</td>
            <td><input type="text" data-name="${i}" value="${esc(column.name)}" /></td>
            <td>
              <select data-type="${i}">
                ${TYPES.map(
                  ([value, label]) =>
                    `<option value="${value}"${value === column.type ? ' selected' : ''}>${esc(value)} — ${esc(t(label))}</option>`,
                ).join('')}
              </select>
            </td>
          </tr>`,
      )
      .join('');

    // The sample grid shows the *file's* values, untouched. Showing them
    // already coerced would hide the one thing the student is here to check.
    el('importPreview').innerHTML = preview.rows.length
      ? `<table>
           <thead><tr>${preview.columns.map((c) => `<th>${esc(c.name)}</th>`).join('')}</tr></thead>
           <tbody>${preview.rows
             .map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join('')}</tr>`)
             .join('')}</tbody>
         </table>${
           preview.truncated
             ? `<p class="note">${esc(t('import.preview_first', { rows: preview.rows.length }))}</p>`
             : ''
         }`
      : `<p class="note">${esc(t('import.no_rows'))}</p>`;

    // Width first: a file that is both too wide and too long is too wide as
    // far as the student's next action goes, and two stacked refusals read as
    // one broken upload rather than two things to fix.
    el('importErrors').innerHTML = preview.tooManyColumns
      ? `<p class="msg">${esc(t('import.too_many_columns'))}</p>`
      : preview.tooManyRows
        ? `<p class="msg">${esc(t('import.too_many_rows'))}</p>`
        : '';
  }

  /** Read the edited names and types back out of the form. */
  const columnsFromForm = () =>
    preview.columns.map((column, i) => ({
      name: el('importColumns').querySelector(`[data-name="${i}"]`).value,
      type: el('importColumns').querySelector(`[data-type="${i}"]`).value,
    }));

  async function pick(file) {
    if (!file) return;
    if (file.size > MAX_BYTES) {
      status(
        t('import.too_large', { size: number.format(Math.round(file.size / 1048576)) }),
      );
      return;
    }

    setBusy(true);
    status(t('import.reading'));
    el('importErrors').innerHTML = '';
    try {
      csv = await readText(file);
      preview = await post(previewUrl, { csv, filename: file.name });
      renderPreview();
      status('');
    } catch (err) {
      preview = null;
      el('importConfig').hidden = true;
      status(err.message);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Re-run the guess with what the student has overruled.
   *
   * The server does it again rather than the browser adjusting the arrays in
   * place, because changing the delimiter or the header flag changes the column
   * *names*, their inferred *types* and the row count together. Reproducing
   * that here would be the same inference written twice, in two languages, with
   * only the ones that disagree ever showing up — and they would show up as a
   * confirm step that imports something other than what was on screen.
   */
  async function repreview() {
    const table = el('importTable').value;
    setBusy(true);
    status('');
    try {
      preview = await post(previewUrl, {
        csv,
        delimiter: el('importDelimiter').value,
        hasHeader: el('importHeader').checked,
      });
      renderPreview({ keepTableName: true });
      el('importTable').value = table;
    } catch (err) {
      status(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function go() {
    setBusy(true);
    status(t('import.importing'));
    el('importErrors').innerHTML = '';

    let outcome;
    try {
      outcome = await submit({
        csv,
        table: el('importTable').value,
        columns: columnsFromForm(),
        delimiter: preview.delimiter,
        hasHeader: el('importHeader').checked,
        replace: showReplace && el('importReplace').checked,
      });
    } catch (err) {
      // Includes `table_exists`, whose fix is the checkbox two lines up — so
      // the dialog stays open with everything the student typed still in it.
      status(err.message);
      setBusy(false);
      return;
    }

    if (!outcome.ok) {
      status(t('import.not_run'));
      renderFailure(outcome);
      setBusy(false);
      return;
    }

    finish({ table: outcome.table, rowCount: outcome.rowCount });
  }

  function renderFailure(outcome) {
    if (outcome.error) {
      // A database-level refusal: out of space, a privilege gone. Postgres's
      // own words, for the same reason the query pane shows them.
      //
      // With the same explanation above them, from the same catalogue — this
      // pane and `sql.js`'s `renderFailure` now render one hint layer, not two.
      // The markup is deliberately identical (`.hint-de` then `.msg`), because
      // `app.css` keys an adjacent-sibling rule off exactly that pair (§4ll).
      //
      // `hintFor` is called **without a catalog**, which is not an oversight and
      // is why this is one line rather than a parameter threaded through
      // `openImportDialog`. The catalog-backed handlers (`42P01`, `42703`,
      // `3F000`) all answer "you named something that is not there" with a
      // did-you-mean drawn from what *is*. Nothing in this transaction reads an
      // existing object: it creates one table and inserts into it, so the
      // suggestion would have nothing to suggest against. The handlers that can
      // fire here — a privilege gone, a value the type cannot hold, an aborted
      // transaction — read the message and ignore the catalog anyway.
      const explained = renderHint(hintFor(outcome.error), t);
      el('importErrors').innerHTML =
        (explained ? `<p class="hint-de">${ticked(explained)}</p>` : '') +
        `<p class="msg">${esc(outcome.error.message)}</p>` +
        `<p class="note">SQLSTATE ${esc(outcome.error.code)}</p>`;
      return;
    }

    // The interesting case: a type the student chose that the data does not
    // fit. Naming the line and the value is the difference between "fix row
    // 412" and "read your file again".
    el('importErrors').innerHTML = `
      <p class="msg">${esc(t('import.bad_values'))}</p>
      <ul>${outcome.errors
        .map(
          (e) =>
            `<li>${esc(t('import.bad_value', { line: number.format(e.line) }))}
             <code>${esc(e.column)}</code>:
             <code>${esc(e.value)}</code> ${esc(t('import.not_of_type'))}
             <code>${esc(e.expected)}</code>.</li>`,
        )
        .join('')}</ul>
      <p class="note">${esc(t('import.choose_text'))}</p>`;
  }

  function finish(result) {
    dialog.close();
    done?.(result);
    done = null;
  }

  // Reset every time, so a second import does not open onto the first one's
  // preview, error list or half-typed table name.
  csv = '';
  preview = null;
  el('importFile').value = '';
  el('importConfig').hidden = true;
  el('importErrors').innerHTML = '';
  el('importReplace').checked = false;
  // `closest`, because the checkbox and its translated <span> share one <label>
  // and hiding only the input would leave the words behind it.
  el('importReplace').closest('label').hidden = !showReplace;
  status(t('import.pick_file'));
  setBusy(false);

  el('importFile').onchange = (event) => void pick(event.target.files[0]);
  el('importGo').onclick = () => void go();
  el('importCancel').onclick = () => finish(null);
  el('importHeader').onchange = () => csv && void repreview();
  el('importDelimiter').onchange = () => csv && void repreview();

  dialog.showModal();
  return new Promise((resolve) => {
    done = resolve;
    // Escape closes a <dialog> without going through our buttons.
    dialog.onclose = () => {
      done?.(null);
      done = null;
    };
  });
}
