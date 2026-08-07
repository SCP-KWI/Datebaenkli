/**
 * CSV in, typed rows out — phase 3. Pure: no database, no config, no I/O.
 *
 * Architecture §4 specified `csv-parse` for this. It is not used, and the
 * reason is not dependency asceticism: **the hard part of this file is not
 * RFC 4180.** A CSV that reaches this app is an Excel export from a de-CH
 * machine, which means semicolons for delimiters, `1'234.50` for numbers,
 * `31.12.2025` for dates and sometimes a comma for the decimal point. No
 * general-purpose parser decides any of that for us, so the sniffing, the
 * coercion table and the inference order below would have had to be written
 * either way. What `csv-parse` would have contributed is the ~60 lines of
 * record splitting in `records()`, against a second runtime dependency in an
 * app that has four.
 *
 * ## The two-mode thing every value goes through
 *
 * `coerce` is the whole file. It answers one question — "can this string be
 * this type, and if so what should Postgres be sent?" — and it is used twice
 * for opposite purposes:
 *
 *   - **inference** wants the *narrowest* type that accepts every value, so it
 *     must be conservative. `0` and `1` are not inferred as booleans (a column
 *     of ids in a two-row file would become a flag), even though `coerce`
 *     accepts them happily once a student has explicitly chosen boolean.
 *   - **import** wants to know whether the student's *chosen* type fits, and to
 *     say exactly which cell did not. So it must be permissive, and it must
 *     never guess.
 *
 * `INFERENCE_REJECTS` is the one place those two diverge. Everything else is
 * shared, which is what makes "the preview said integer and the import
 * disagreed" impossible.
 *
 * ## Why the coercion happens here and not in Postgres
 *
 * We could send `31.12.2025` straight into a `date` column and let Postgres
 * parse it. That is a trap with teeth: Postgres's default `DateStyle` is
 * `ISO, MDY`, under which `03.04.2025` is **March 4th**, not 3 April. It does
 * not error — it silently produces the wrong date, in a file where every other
 * row looks fine. Normalising to ISO here means Postgres is only ever handed
 * `2025-04-03`, which has exactly one reading.
 */

/** The types a student may pick in the preview. Also the Postgres type names verbatim. */
export const COLUMN_TYPES = [
  'boolean',
  'integer',
  'bigint',
  'numeric',
  'date',
  'timestamp',
  'text',
] as const;

export type ColumnType = (typeof COLUMN_TYPES)[number];

/**
 * Tried in this order; the first that accepts every non-blank value wins.
 *
 * Not a widening lattice, because these types do not form one — `date` and
 * `numeric` are simply incomparable. A fixed preference order is honest about
 * that and is trivial to reason about: narrower first, `text` last and
 * always accepting.
 */
const INFERENCE_ORDER: readonly ColumnType[] = COLUMN_TYPES;

/**
 * Values `coerce` accepts but inference must not, per type.
 *
 * Only booleans need this. `1`/`0` are a perfectly reasonable thing to *mean*
 * as a boolean and a perfectly ordinary thing for an integer column to
 * contain, and inference has no way to tell. Guessing wrong turns a column of
 * ids into `true`/`false`, which is unrecoverable without re-importing;
 * guessing "integer" costs the student one dropdown.
 */
const INFERENCE_REJECTS: Partial<Record<ColumnType, RegExp>> = {
  boolean: /^[01]$/,
};

export interface CsvOptions {
  /** Forced by the confirm step so it re-parses exactly what the preview showed. */
  delimiter?: string;
  hasHeader?: boolean;
  /** Stop after this many data rows. */
  maxRows?: number;
  /**
   * Clamp the width to this many columns. **Both callers must pass it.**
   *
   * Rows are padded to the widest record (see `parseCsv`), so the output holds
   * `width × rows` cells built from an input of only `width + rows` bytes. That
   * is quadratic, and it was a remote kill: one 100 KB request of `a;a;a;…`
   * followed by narrow rows materialised 100 M cells — 800 MB of heap and 8
   * seconds of blocked event loop, with the row cap doing nothing because the
   * rows really were short. `maxRows` bounds one factor; this bounds the other.
   */
  maxColumns?: number;
}

export interface ParsedCsv {
  delimiter: string;
  hasHeader: boolean;
  /** One entry per column: the header cell, or `spalte1…` where there was none. */
  header: string[];
  /** Data rows only, every one padded or clipped to `header.length`. */
  rows: string[][];
  /**
   * The 1-based file line each entry of `rows` started on — parallel array.
   *
   * Not `index + 2`. Blank lines are skipped and a quoted field may hold
   * newlines of its own, so the arithmetic drifts exactly in the files that are
   * hardest to debug. This is the number the student sees down the left of
   * their spreadsheet, which is the only one they can act on.
   */
  lines: number[];
  /** How many data rows the file held, even when `rows` stopped short. */
  totalRows: number;
  /**
   * How wide the file really was, even when `header` was clamped to
   * `maxColumns`. The caller refuses on this; clamping alone would silently
   * import the first N columns of a file the student thinks arrived whole.
   */
  totalColumns: number;
  truncated: boolean;
}

/** A record, and the 1-based file line it began on. */
type Record_ = readonly [row: string[], line: number];

/** Candidates in preference order — `;` first, because Excel de-CH writes `;`. */
export const DELIMITERS = [';', ',', '\t', '|'] as const;

/**
 * Split `text` into records.
 *
 * Quoting is RFC 4180 (`""` for a literal quote, delimiters and newlines legal
 * inside quotes), with two deliberate leniencies, because the input is a file
 * a fifteen-year-old exported rather than a protocol:
 *
 *   - a quote that does not start a field is just a character, so
 *     `5" Schraube` is not a parse error;
 *   - anything between a closing quote and the next delimiter is dropped
 *     instead of failing the whole file.
 *
 * Slices rather than character-by-character accumulation. At the 10 MB cap
 * `field += ch` is ~10 million rope nodes, which is measurably worse than
 * finding the next delimiter and taking one substring.
 */
function* records(text: string, delimiter: string): Generator<Record_> {
  const n = text.length;
  let i = 0;
  let row: string[] = [];
  let line = 1;
  let recordLine = 1;

  const atFieldEnd = (k: number): boolean => {
    const c = text[k];
    return c === delimiter || c === '\n' || c === '\r';
  };

  while (i < n) {
    if (row.length === 0) recordLine = line;
    let value: string;

    if (text[i] === '"') {
      i++;
      let start = i;
      const parts: string[] = [];
      for (;;) {
        const q = text.indexOf('"', i);
        if (q === -1) {
          // Unterminated quote: take the rest of the file as this field.
          parts.push(text.slice(start));
          i = n;
          break;
        }
        if (text[q + 1] === '"') {
          parts.push(text.slice(start, q + 1)); // keep one of the pair
          i = q + 2;
          start = i;
          continue;
        }
        parts.push(text.slice(start, q));
        i = q + 1;
        break;
      }
      value = parts.length === 1 ? parts[0]! : parts.join('');
      // A newline *inside* a quoted field still moves the file's line counter,
      // which is the whole reason this is counted rather than derived.
      for (const part of parts) {
        for (const ch of part) if (ch === '\n') line++;
      }
      while (i < n && !atFieldEnd(i)) i++;
    } else {
      const start = i;
      while (i < n && !atFieldEnd(i)) i++;
      value = text.slice(start, i);
    }

    row.push(value);

    if (i >= n) break;
    if (text[i] === delimiter) {
      i++;
      continue;
    }
    if (text[i] === '\r' && text[i + 1] === '\n') i += 2;
    else i++;
    line++;
    yield [row, recordLine];
    row = [];
  }

  if (row.length > 0) yield [row, recordLine];
}

/** A line with nothing on it parses as one empty field; it is not a data row. */
const isBlankRecord = (row: string[]): boolean => row.length <= 1 && (row[0] ?? '') === '';

/**
 * Pick the delimiter that makes the file rectangular.
 *
 * Scored on the first 20 records: what fraction of them agree on a field count,
 * and how wide that count is. A file with no delimiter at all parses
 * identically under every candidate, so the tie falls through to `,` — which
 * is only ever reached for a single-column file, where it cannot matter.
 */
function sniffDelimiter(text: string): string {
  let best = ',';
  let bestScore = 0;

  for (const candidate of DELIMITERS) {
    const counts: number[] = [];
    for (const [row] of records(text, candidate)) {
      if (!isBlankRecord(row)) counts.push(row.length);
      if (counts.length >= 20) break;
    }
    if (counts.length === 0) continue;

    const tally = new Map<number, number>();
    for (const c of counts) tally.set(c, (tally.get(c) ?? 0) + 1);
    let width = 1;
    let agree = 0;
    for (const [c, howMany] of tally) {
      if (howMany > agree || (howMany === agree && c > width)) {
        width = c;
        agree = howMany;
      }
    }
    if (width < 2) continue; // this candidate does not split the file at all

    const score = (agree / counts.length) * 100 + Math.min(width, 50);
    // Strictly greater, so an exact tie keeps the earlier — i.e. Swiss —
    // candidate. `a;b,c` is far likelier to be two semicolon-separated fields.
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return best;
}

/**
 * Is the first record a header?
 *
 * True when it holds at least one name and nothing in it looks like data.
 *
 * Blank cells are *skipped*, not disqualifying — a spreadsheet whose first
 * column is unlabelled row numbers is completely ordinary, and requiring every
 * cell to be filled would send exactly that file down the no-header path, which
 * then names every column `spalte1…` including the ones that had perfectly good
 * names. (The `spalteN` fallback in `parseCsv` exists for those gaps; the two
 * rules have to agree that a gap is survivable.)
 *
 * Still deliberately crude, and wrong in one direction: a file of all-text data
 * rows and no header loses its first row. Excel always writes a header, the
 * preview shows what was decided, and the checkbox beside it overrides — so the
 * wrong guess costs one click, and being cleverer costs a rule nobody can
 * predict.
 */
function looksLikeHeader(first: string[], decimalComma: boolean): boolean {
  const named = first.filter((cell) => cell.trim() !== '');
  return named.length > 0 && named.every((cell) => inferType([cell], decimalComma) === 'text');
}

/** Excel de-CH writes `1'234,50` when the delimiter is `;`, and `1,234.50` when it is `,`. */
const usesDecimalComma = (delimiter: string): boolean => delimiter !== ',';

export function parseCsv(text: string, opts: CsvOptions = {}): ParsedCsv {
  // A BOM survives as U+FEFF on the first header cell, which becomes a column
  // named `﻿id` — invisible in every UI and impossible to type in SQL.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const delimiter = opts.delimiter ?? sniffDelimiter(body);
  const maxRows = opts.maxRows ?? Number.MAX_SAFE_INTEGER;
  const maxColumns = opts.maxColumns ?? Number.MAX_SAFE_INTEGER;

  const all: Record_[] = [];
  let totalRecords = 0;
  for (const record of records(body, delimiter)) {
    if (isBlankRecord(record[0])) continue;
    totalRecords++;
    // Keep one record past the cap: the first of them may be the header, which
    // is not a data row and must not eat a slot.
    if (all.length <= maxRows) all.push(record);
  }

  if (all.length === 0) {
    return {
      delimiter,
      hasHeader: false,
      header: [],
      rows: [],
      lines: [],
      totalRows: 0,
      totalColumns: 0,
      truncated: false,
    };
  }

  const decimalComma = usesDecimalComma(delimiter);
  const hasHeader = opts.hasHeader ?? looksLikeHeader(all[0]![0], decimalComma);

  // The widest record wins, not the header's: a header short by one column
  // would otherwise silently throw away the last column of every data row.
  //
  // Clamped, and the clamp has to happen *here* rather than in the caller —
  // every allocation below is `width`-sized, so a check that runs after
  // `parseCsv` returns has already paid for the thing it was meant to prevent.
  // `totalColumns` carries the real number out so the caller can still refuse.
  const totalColumns = all.reduce((max, [row]) => Math.max(max, row.length), 0);
  const width = Math.min(totalColumns, maxColumns);

  const headerRow = hasHeader ? all[0]![0] : [];
  const header = Array.from({ length: width }, (_, i) => {
    const cell = headerRow[i]?.trim() ?? '';
    return cell === '' ? `spalte${i + 1}` : cell;
  });

  const kept = (hasHeader ? all.slice(1) : all).slice(0, maxRows);
  const totalRows = hasHeader ? Math.max(0, totalRecords - 1) : totalRecords;

  return {
    delimiter,
    hasHeader,
    header,
    // Ragged rows are padded rather than rejected. A trailing empty field is
    // the single commonest thing wrong with a hand-edited CSV, and refusing
    // the file over it teaches nothing.
    rows: kept.map(([row]) =>
      row.length === width ? row : Array.from({ length: width }, (_, i) => row[i] ?? ''),
    ),
    lines: kept.map(([, line]) => line),
    totalRows,
    totalColumns,
    truncated: totalRows > kept.length,
  };
}

// --- coercion ----------------------------------------------------------------

/** A blank cell is NULL, whatever the column's type. Excel writes an empty cell as ``. */
const isBlank = (value: string): boolean => value.trim() === '';

const TRUE_WORDS = new Set(['true', 't', 'yes', 'y', 'ja', 'j', 'wahr', '1']);
const FALSE_WORDS = new Set(['false', 'f', 'no', 'n', 'nein', 'falsch', '0']);

const INT32 = { min: -2147483648n, max: 2147483647n };
const INT64 = { min: -9223372036854775808n, max: 9223372036854775807n };

/**
 * Strip the group separators a Swiss spreadsheet emits, then settle the decimal
 * mark.
 *
 * `'` is the de-CH thousands separator (`1'234'567`), and U+2019 is what it
 * becomes after Word or Excel autocorrects it into a typographic apostrophe —
 * the two are indistinguishable on screen and only one of them is an ASCII
 * quote. NBSP and thin space appear in exports from LibreOffice.
 */
function normaliseNumber(raw: string, decimalComma: boolean): string | undefined {
  let s = raw.trim().replace(/[’'    ]/g, '');

  if (s.includes(',')) {
    if (s.includes('.')) {
      // Both present: the last one is the decimal mark and the other is
      // grouping. `1,234.50` and `1.234,50` both come out as `1234.50`.
      s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '') : s.replace(/,/g, '');
      s = s.replace(',', '.');
    } else if (decimalComma) {
      s = s.replace(',', '.');
    } else {
      // The delimiter is a comma, so a comma inside a field came through a
      // quoted `"1,234"` and can only be grouping.
      s = s.replace(/,/g, '');
    }
  }

  return s === '' ? undefined : s;
}

/** `2025-04-03`, validated against the real calendar so 31.02 is not a date. */
function isoDate(year: number, month: number, day: number): string | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return undefined;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * ISO `2025-04-03` and Swiss `3.4.2025`. Slashes are deliberately **not** a
 * date.
 *
 * `03/04/2025` is 3 April to everyone in this building and 4 March to
 * Postgres's default `DateStyle`, and nothing in the file says which the
 * student meant. Leaving it as `text` is the only answer that cannot be
 * silently wrong — and the preview is right there to say otherwise.
 *
 * A two-digit year pivots at 70, the same as Postgres itself.
 */
function normaliseDate(raw: string): string | undefined {
  const s = raw.trim();

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (iso) return isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const swiss = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/.exec(s);
  if (swiss) {
    const raw3 = Number(swiss[3]);
    const year = swiss[3]!.length === 2 ? (raw3 < 70 ? 2000 + raw3 : 1900 + raw3) : raw3;
    return isoDate(year, Number(swiss[2]), Number(swiss[1]));
  }

  return undefined;
}

/** A date followed by `hh:mm[:ss[.fff]]`, separated by a space or a `T`. */
function normaliseTimestamp(raw: string): string | undefined {
  const m = /^(.*?)[ T](\d{1,2}):(\d{2})(?::(\d{2})(\.\d{1,6})?)?$/.exec(raw.trim());
  if (!m) return undefined;

  const date = normaliseDate(m[1]!);
  if (date === undefined) return undefined;

  const hh = Number(m[2]);
  const mm = Number(m[3]);
  const ss = m[4] === undefined ? 0 : Number(m[4]);
  if (hh > 23 || mm > 59 || ss > 59) return undefined;

  const time = [hh, mm, ss].map((n) => String(n).padStart(2, '0')).join(':');
  return `${date} ${time}${m[5] ?? ''}`;
}

/**
 * `null` for a blank cell, the text to send for a value that fits, `undefined`
 * for one that does not.
 *
 * Three outcomes rather than a thrown error because the caller wants to collect
 * every bad cell in the file and show them together — "row 41 and row 90 are
 * not numbers" is a fixable report; the first failure alone is a guessing game.
 */
export function coerce(
  value: string,
  type: ColumnType,
  decimalComma: boolean,
): string | null | undefined {
  if (isBlank(value)) return null;
  const trimmed = value.trim();

  switch (type) {
    case 'text':
      // Not trimmed: leading space may be the data. Every other type is a
      // scalar whose surrounding whitespace is an artefact of the export.
      return value;

    case 'boolean': {
      const word = trimmed.toLowerCase();
      if (TRUE_WORDS.has(word)) return 'true';
      if (FALSE_WORDS.has(word)) return 'false';
      return undefined;
    }

    case 'integer':
    case 'bigint': {
      const n = normaliseNumber(trimmed, decimalComma);
      if (n === undefined || !/^[+-]?\d+$/.test(n)) return undefined;
      // Range-checked here rather than at the database, so an id column that
      // overflows int4 reports the row it happened in instead of failing the
      // whole import with a 22003 and no location.
      const { min, max } = type === 'integer' ? INT32 : INT64;
      const big = BigInt(n);
      return big < min || big > max ? undefined : n;
    }

    case 'numeric': {
      const n = normaliseNumber(trimmed, decimalComma);
      if (n === undefined || !/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(n)) return undefined;
      return n;
    }

    case 'date':
      return normaliseDate(trimmed);

    case 'timestamp':
      return normaliseTimestamp(trimmed);
  }
}

/** The narrowest type in `INFERENCE_ORDER` that every non-blank value fits. */
export function inferType(values: readonly string[], decimalComma: boolean): ColumnType {
  // An all-blank column has no evidence at all. `boolean` would win vacuously,
  // and a column that is empty *today* is exactly the one a student is about to
  // put anything into.
  if (values.every(isBlank)) return 'text';

  for (const type of INFERENCE_ORDER) {
    const reject = INFERENCE_REJECTS[type];
    const fits = values.every((v) => {
      if (isBlank(v)) return true;
      if (reject?.test(v.trim())) return false;
      return coerce(v, type, decimalComma) !== undefined;
    });
    if (fits) return type;
  }

  return 'text';
}

/** One inferred column: the header cell as written, and the type guessed for it. */
export interface InferredColumn {
  /** The header cell verbatim — what the student recognises from their file. */
  sourceName: string;
  type: ColumnType;
}

export function inferColumns(parsed: ParsedCsv): InferredColumn[] {
  const decimalComma = usesDecimalComma(parsed.delimiter);
  return parsed.header.map((sourceName, i) => ({
    sourceName,
    type: inferType(
      parsed.rows.map((row) => row[i] ?? ''),
      decimalComma,
    ),
  }));
}

export { usesDecimalComma };
