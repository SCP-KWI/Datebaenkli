/**
 * Explanations for Postgres errors — the SQLSTATE hint layer, phases 6a and 6b.
 *
 * A beginner who writes `SELECT * FROM kunde` gets
 * `ERROR: relation "kunde" does not exist` — English, and phrased for someone
 * who already knows what a relation is. This module turns that into one
 * sentence in the student's own language and, where it safely can, names the
 * table they probably meant.
 *
 * ARCHITECTURE §8a calls this one of the highest-value teaching features in the
 * app, and the reason is that the alternative was rejected: Postgres *can*
 * localise its own messages via `lc_messages`, but the alpine image ships no
 * German locale and the translations are uneven. A hint layer of our own is
 * also the only version that can mention *this student's* tables.
 *
 * **An English-locale student still wants the hints.** Postgres speaks English
 * and they can read it, but `42803` is not *explained* by `column … must appear
 * in the GROUP BY clause` — it is restated by it. The hint earns its place in
 * both locales, which is what 6b below is for.
 *
 * ---
 *
 * **6a fused the analysis with the phrasing; 6b separated them.** Each handler
 * used to return a finished German sentence. It now returns a *key* and its
 * substitutions — `{ key: 'hint.table.unknown', vars: { table }, suggestion }` —
 * and the phrasing lives in `i18n-de.js` / `i18n-en.js` beside every other
 * string. `renderHint()` puts the two back together.
 *
 * The alternative — a second set of twenty handlers returning English — was
 * rejected explicitly. *Which* message shape matched and *which* catalog object
 * is the near miss are locale-independent; only the sentence is not. Forking
 * would have doubled the branching, and the branching is the part that was hard
 * to get right (HANDOFF §4jj). One bug fixed once, in one place, is the whole
 * point.
 *
 * **Pure, and that is the point.** No DOM, no fetch, and the only import is the
 * `t` the caller hands to `renderHint`. Same argument as `names.js`: it is the
 * part of the page a test can reach, and it is the part that can be quietly
 * wrong for months. `test/hints.test.mjs` drives it.
 *
 * **Every message pattern here was read off a real server, not remembered.**
 * That was not pedantry — three of them are not what they look like:
 *
 *   - `SELECT * FROM demoo.kantone` is **42P01** `relation "demoo.kantone"
 *     does not exist`, not 3F000 and not a bare table name. The schema is
 *     *inside* the quotes.
 *   - 42703 has three shapes, one of which is unquoted:
 *     `column "x" does not exist`, `column "x" of relation "y" does not exist`,
 *     and `column k.x does not exist` for an alias-qualified reference.
 *   - 42P01 also covers `missing FROM-clause entry for table "x"`, which is a
 *     completely different mistake from a misspelled table and deserves its own
 *     sentence.
 *
 * If you add a code, get its message from a server first. `psql` and a
 * `GET STACKED DIAGNOSTICS` loop took ten minutes and corrected four guesses.
 *
 * **Swiss German orthography: no ß, ever.** `gross`, `heisst`, `schliessen`.
 * This is a Swiss school and the rest of the app follows the same rule. It
 * applies to `i18n-de.js`, which is now where the sentences are.
 *
 * **Backticks mark identifiers**, and the caller turns them into `<code>` after
 * escaping — never before, or a table named `<script>` becomes one. The
 * backticks now live in the catalogue templates, which is the right place: where
 * a name is shown as code is a phrasing decision. What does *not* live there is
 * the safety strip — every substitution value goes through `plain()` on its way
 * out of a handler, so a table whose name contains a backtick cannot unbalance
 * the caller's pairs. A translator cannot forget that, because a translator
 * never touches it.
 */

/**
 * A short list of the functions a beginner reaches for, so `lenght(...)` can be
 * answered with `length`. There is no function catalog on the client and asking
 * the server for one would make an error panel wait on a round trip.
 *
 * Deliberately short. It only has to cover the typo a student actually makes;
 * a suggestion drawn from all 2 800 built-ins would match noise.
 */
const COMMON_FUNCTIONS = [
  'count', 'sum', 'avg', 'min', 'max', 'round', 'floor', 'ceil', 'abs',
  'length', 'upper', 'lower', 'initcap', 'trim', 'substring', 'replace',
  'concat', 'coalesce', 'nullif', 'position', 'left', 'right',
  'now', 'current_date', 'extract', 'to_char', 'to_date', 'age',
];

// --- string distance ---------------------------------------------------------

/**
 * Levenshtein distance, two-row DP.
 *
 * Small inputs (identifiers), so the classic full-matrix version's memory does
 * not matter — but the two-row form is barely longer and makes the bound
 * obvious. No early exit: the caller wants the true minimum across candidates
 * in order to keep ties, so a cut-off would only hide information.
 */
function distance(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/**
 * How wrong a name may be before naming a candidate stops being help and starts
 * being a guess. Scaled to length, because one wrong letter in `id` is a
 * different claim from one wrong letter in `bestellpositionen`.
 */
const tolerance = (name) => (name.length <= 3 ? 1 : name.length <= 7 ? 2 : 3);

/**
 * The did-you-mean. Returns `null` rather than a bad guess.
 *
 * `kind` is the locale-independent half of the answer and the reason this is
 * worth returning as a structure rather than a sentence: a capitalisation-only
 * difference is not a guess at all, it is a diagnosis, and it gets a different
 * explanation in every language.
 */
export function suggest(name, candidates) {
  if (!name || !Array.isArray(candidates) || candidates.length === 0) return null;

  const cased = candidates.filter((c) => c !== name && c.toLowerCase() === name.toLowerCase());
  if (cased.length > 0) return { kind: 'case', names: cased };

  const limit = tolerance(name);
  let best = Infinity;
  let names = [];
  for (const candidate of candidates) {
    if (candidate === name) return null;
    const d = distance(name.toLowerCase(), candidate.toLowerCase());
    if (d > limit) continue;
    if (d < best) [best, names] = [d, [candidate]];
    else if (d === best) names.push(candidate);
  }
  return names.length > 0 ? { kind: 'near', names } : null;
}

// --- reading the catalog -----------------------------------------------------

const schemasOf = (catalog) => (Array.isArray(catalog?.schemas) ? catalog.schemas : []);

const tablesOf = (schema) => (Array.isArray(schema?.tables) ? schema.tables : []);

/** Bare names in the student's own schema — what an unqualified name resolves to. */
function ownTables(catalog) {
  const own = schemasOf(catalog).filter((s) => s.own);
  return own.flatMap((s) => tablesOf(s).map((t) => t.name));
}

/** Everything else, qualified, because that is how the student would have to write it. */
function foreignTables(catalog) {
  return schemasOf(catalog)
    .filter((s) => !s.own)
    .flatMap((s) => tablesOf(s).map((t) => `${s.name}.${t.name}`));
}

/**
 * Columns to match a near miss against. With a relation named, only that one —
 * otherwise every table the student can read, because a bare `column "x" does
 * not exist` does not say which table it was looking in.
 */
function columnsFor(catalog, relation) {
  const tables = schemasOf(catalog).flatMap((s) => tablesOf(s));
  const scoped = relation ? tables.filter((t) => t.name === relation) : tables;
  const names = scoped.flatMap((t) => (Array.isArray(t.columns) ? t.columns : []).map((c) => c.name));
  return [...new Set(names)];
}

// --- building a hint ---------------------------------------------------------

/**
 * The safety strip, applied to every value on its way *out* of a handler.
 *
 * A student can name a table `` a`b ``. If that reached the caller with its
 * backtick intact it would close the catalogue template's pair early and the
 * rest of the sentence would render inside a `<code>`. Stripping here rather
 * than at the render site means a new handler gets it by construction.
 */
const plain = (value) => String(value ?? '').replace(/`/g, '');

/** A hint: a catalogue key, its substitutions, and optionally a did-you-mean. */
const hint = (key, vars = null, suggestion = null) => ({ key, vars, suggestion });

/**
 * `suggest`, packaged for a hint. Null when there is nothing worth saying, which
 * several callers below branch on — a bare "there is no table `x`" reads
 * differently when we have nothing to offer, and gets its own key.
 */
function nearby(name, candidates) {
  const found = suggest(name, candidates);
  return found ? { kind: found.kind, names: found.names.map(plain) } : null;
}

// --- the codes ---------------------------------------------------------------

/**
 * Each handler returns a `hint(...)` or null. The keys are named for what the
 * student got wrong, not for the SQLSTATE — one code covers four different
 * mistakes (42P01) and two codes share one sentence (`hint.schema.unknown`), so
 * numbering the keys would misdescribe both.
 *
 * `57014` is deliberately absent. A cancelled query never reaches here: the page
 * short-circuits on `outcome.cancelled` and renders the reason it already knows
 * (the student's own Cancel button, or the timeout), which is more than a
 * SQLSTATE could tell it.
 */
const HANDLERS = {
  '42P01': (error, catalog) => {
    const missingFrom = /missing FROM-clause entry for table "(.+)"/.exec(error.message);
    if (missingFrom) return hint('hint.table.missing_from', { table: plain(missingFrom[1]) });

    const match = /relation "(.+)" does not exist/.exec(error.message);
    if (!match) return null;
    const written = match[1];

    /**
     * A dot in the written name *might* be a schema qualification — the schema
     * is inside the quotes, so `relation "demo.kantone"` and `relation
     * "kunden.2025"` are indistinguishable from the message alone, and
     * `CREATE TABLE "kunden.2025"` is legal SQL.
     *
     * So the schema reading is only taken when the catalog backs it up: the
     * prefix is a schema the student can see, or is one small typo away from
     * one. Otherwise the dot is treated as part of an ordinary table name and
     * this falls through. Found by pasting an HTML-injection attempt into the
     * editor: it escaped correctly, and then confidently announced that the
     * schema `<img src=x onerror='document.title=String` did not exist.
     */
    const dot = written.lastIndexOf('.');
    if (dot > 0) {
      const [schema, table] = [written.slice(0, dot), written.slice(dot + 1)];
      const known = schemasOf(catalog).find((s) => s.name === schema);
      if (known) {
        return hint(
          'hint.table.not_in_schema',
          { schema: plain(schema), table: plain(table) },
          nearby(table, tablesOf(known).map((t) => t.name)),
        );
      }
      const nearSchema = nearby(schema, schemasOf(catalog).map((s) => s.name));
      if (nearSchema) return hint('hint.schema.unknown', { schema: plain(schema) }, nearSchema);
    }

    // Unqualified — or dotted in a way the catalog would not vouch for. Their
    // own schema is what a bare name resolves to, so a hit there is the answer;
    // only if there is none is it worth pointing at another schema, where the
    // fix is not a spelling correction at all.
    const here = nearby(written, ownTables(catalog));
    if (here) return hint('hint.table.unknown', { table: plain(written) }, here);

    // `suggest` refuses to return an exact match — a "did you mean `kunden`?"
    // for a name that *is* `kunden` reads as nonsense. This is the one caller
    // for which exact is the interesting case: `SELECT * FROM kantone` when the
    // table is `demo.kantone` is spelled perfectly and still fails, and the
    // missing thing is the qualification. So exact is checked separately, and
    // ahead of the near misses.
    const foreign = foreignTables(catalog);
    const leaf = (qualified) => qualified.split('.').at(-1);

    let qualified = foreign.filter((q) => leaf(q) === written);
    if (qualified.length === 0) {
      const found = suggest(written, foreign.map(leaf));
      qualified = found ? foreign.filter((q) => found.names.includes(leaf(q))) : [];
    }

    if (qualified.length > 0) {
      return hint('hint.table.other_schema', {
        table: plain(written),
        // An array var: the renderer backticks each element and joins them with
        // the locale's conjunction. See `fill()`.
        names: qualified.map(plain),
      });
    }
    return hint('hint.table.unknown_alone', { table: plain(written) });
  },

  '42703': (error, catalog) => {
    // Three shapes, and the middle one is the only that names its table.
    const ofRelation = /column "(.+)" of relation "(.+)" does not exist/.exec(error.message);
    if (ofRelation) {
      const [, column, relation] = ofRelation;
      return hint(
        'hint.column.unknown_in_table',
        { relation: plain(relation), column: plain(column) },
        nearby(column, columnsFor(catalog, relation)),
      );
    }

    // `column k.nachnahme does not exist` — alias-qualified, and unquoted.
    const qualified = /column ([^ "]+)\.([^ "]+) does not exist/.exec(error.message);
    if (qualified) {
      const [, prefix, column] = qualified;
      return hint(
        'hint.column.unknown_in_alias',
        { prefix: plain(prefix), column: plain(column) },
        nearby(column, columnsFor(catalog, prefix)),
      );
    }

    const bare = /column "(.+)" does not exist/.exec(error.message);
    if (!bare) return null;
    return hint(
      'hint.column.unknown',
      { column: plain(bare[1]) },
      nearby(bare[1], columnsFor(catalog, null)),
    );
  },

  '3F000': (error, catalog) => {
    const match = /schema "(.+)" does not exist/.exec(error.message);
    if (!match) return null;
    return hint(
      'hint.schema.unknown',
      { schema: plain(match[1]) },
      nearby(match[1], schemasOf(catalog).map((s) => s.name)),
    );
  },

  '42601': (error) => {
    const at = /syntax error at or near "(.+)"/.exec(error.message);
    // The single most useful thing to tell a beginner about a syntax error: the
    // position is where the parser gave up, which is one token *after* the
    // mistake. Students stare at the marked word and find nothing wrong with it,
    // because there is nothing wrong with it. The catalogue strings carry that,
    // and carry it with no markup beyond backticks — the page converts `…` to
    // <code> and nothing else, so an asterisk for emphasis would reach the
    // student as an asterisk. Emphasis has to be in the wording, in every locale.
    if (at) return hint('hint.syntax.at', { token: plain(at[1]) });
    if (error.message.includes('at end of input')) return hint('hint.syntax.end');
    return hint('hint.syntax.other');
  },

  '42803': () => hint('hint.groupby'),

  '42883': (error) => {
    const operator = /operator does not exist: (.+)/.exec(error.message);
    if (operator) return hint('hint.operator.unknown', { operator: plain(operator[1]) });

    const fn = /function ([^(]+)\(/.exec(error.message);
    if (!fn) return null;
    const name = fn[1].trim();
    return hint(
      'hint.function.unknown',
      { name: plain(name) },
      nearby(name.split('.').at(-1), COMMON_FUNCTIONS),
    );
  },

  '42702': (error) => {
    const match = /column reference "(.+)" is ambiguous/.exec(error.message);
    return match ? hint('hint.column.ambiguous', { column: plain(match[1]) }) : null;
  },

  '42P07': (error) => {
    const match = /relation "(.+)" already exists/.exec(error.message);
    return match ? hint('hint.table.exists', { table: plain(match[1]) }) : null;
  },

  '42701': (error) => {
    const match = /column "(.+)" specified more than once/.exec(error.message);
    return match ? hint('hint.column.twice', { column: plain(match[1]) }) : null;
  },

  '42804': (error) => {
    const where = /argument of (WHERE|HAVING|JOIN\/ON) must be type boolean, not type (.+)/.exec(
      error.message,
    );
    // `clause` is a SQL keyword and stays English in both catalogues — the same
    // rule as every other keyword (ARCHITECTURE §8a). It is a substitution
    // rather than three keys because WHERE, HAVING and JOIN/ON take the same
    // sentence in both languages.
    if (where) {
      return hint('hint.type.boolean_condition', { clause: where[1], type: plain(where[2]) });
    }
    return hint('hint.type.other');
  },

  '42P10': () => hint('hint.orderby.position'),

  '23505': (error) => {
    const key = /Key \((.+)\)=\((.+)\) already exists\./.exec(error.detail ?? '');
    if (key) return hint('hint.unique.key', { column: plain(key[1]), value: plain(key[2]) });
    return hint('hint.unique.other');
  },

  '23503': (error) => {
    const key = /Key \((.+)\)=\((.+)\) is not present in table "(.+)"\./.exec(error.detail ?? '');
    if (key) {
      return hint('hint.fk.missing', {
        table: plain(key[3]),
        column: plain(key[1]),
        value: plain(key[2]),
      });
    }
    // The other direction: deleting a row something else still points at.
    if (error.message.startsWith('update or delete')) {
      const still = /is still referenced from table "(.+)"\./.exec(error.detail ?? '');
      return still
        ? hint('hint.fk.referenced_by_named', { table: plain(still[1]) })
        : hint('hint.fk.referenced_by');
    }
    return hint('hint.fk.other');
  },

  '23502': (error) => {
    const match = /null value in column "(.+)" of relation "(.+)" violates/.exec(error.message);
    if (!match) return null;
    return hint('hint.column.not_null', { column: plain(match[1]), table: plain(match[2]) });
  },

  '23514': (error) => {
    const match = /new row for relation "(.+)" violates check constraint "(.+)"/.exec(
      error.message,
    );
    if (!match) return null;
    return hint('hint.check.violated', { constraint: plain(match[2]), table: plain(match[1]) });
  },

  '22P02': (error) => {
    const match = /invalid input syntax for type (.+): "(.*)"/.exec(error.message);
    if (!match) return null;
    return hint('hint.input.invalid', { value: plain(match[2]), type: plain(match[1]) });
  },

  '22012': () => hint('hint.divzero'),

  '22003': () => hint('hint.overflow'),

  '22008': (error) => {
    const match = /date\/time field value out of range: "(.*)"/.exec(error.message);
    return match
      ? hint('hint.date.invalid_named', { value: plain(match[1]) })
      : hint('hint.date.invalid');
  },

  /**
   * A drop blocked by something built on top of the object.
   *
   * Added with the CSV import's hint pane (7.2) because it is that pane's
   * characteristic failure rather than the query editor's: "replace existing
   * table" issues `DROP TABLE` **without** `CASCADE` on purpose
   * (`services/import.ts` says why), so a view the student built on last week's
   * table stops the re-import cold. It fires for a hand-typed `DROP` too.
   *
   * Naming the dependents is the point here, and it is worth more in the import
   * dialog than anywhere else: that pane renders the message and the SQLSTATE
   * and *not* `error.detail`, so this hint is the only place the student is told
   * which view is in the way.
   *
   * The table name is passed through exactly as Postgres wrote it, quotes and
   * all — unlike `42P07`, whose message always quotes and where they are always
   * stripped. Postgres quotes here only when the name needs it, so `"Meine
   * Kunden"` arriving with its quotes is not noise: it is what the student would
   * have to type back.
   */
  '2BP01': (error) => {
    const dropped = /^cannot drop \w+ (.+) because other objects depend on it/.exec(error.message);
    if (!dropped) return null;
    const table = plain(dropped[1]);

    /**
     * `detail` is one `<kind> <name> depends on <kind> <target>` line per
     * dependent — and, past a hundred of them, a final line that is a count
     * rather than an object.
     *
     * So a line that does not parse is not skipped: the whole naming branch is
     * dropped for the unnamed one. A list that is shorter than the truth reads
     * as complete, and the student deletes what it names and hits the same
     * error again. `.+` is greedy on purpose — the separator is the *last*
     * " depends on " in the line, which is what makes a dependent whose own
     * name contains those words parse correctly.
     */
    const lines = (error.detail ?? '').split('\n').filter((line) => line.length > 0);
    const parsed = lines.map((line) => /^\w+ (.+) depends on /.exec(line));
    if (lines.length === 0 || parsed.some((match) => match === null)) {
      return hint('hint.depends', { table });
    }
    return hint('hint.depends.named', { table, names: parsed.map((m) => plain(m[1])) });
  },

  '42501': () => hint('hint.denied'),

  '25P02': () => hint('hint.aborted'),
};

/**
 * The hint for one Postgres error as `{ key, vars, suggestion }`, or `null` when
 * we have nothing better to say than the raw message.
 *
 * `null` is a real answer and is returned often — for an unlisted SQLSTATE, and
 * for a listed one whose message did not match the shape we know. A hint that
 * is merely plausible is worse than none: this is the one panel a student reads
 * when they are already stuck, and being confidently wrong there costs more
 * than being silent.
 *
 * Never throws. A bug in a regex or a catalog shaped unexpectedly must not take
 * the error panel down with it — the raw message is the thing that has to
 * survive, and the hint is the extra.
 */
export function hintFor(error, catalog = null) {
  try {
    if (!error?.code || typeof error.message !== 'string') return null;
    const handler = HANDLERS[error.code];
    return handler ? (handler(error, catalog) ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Substitute into one catalogue string.
 *
 * Two kinds of value, and the difference is deliberate:
 *
 *   - **A scalar goes in bare**, and the *template* decides whether it is shown
 *     as code: `` Die Tabelle `{table}` gibt es nicht. `` Where a name is
 *     formatted is a phrasing decision, so it belongs with the phrasing — and
 *     `hint.column.ambiguous` needs one substitution inside a larger backticked
 *     example (`` `kunden.{column}` ``), which a blanket rule could not express.
 *   - **An array is backticked per element and joined** with the locale's
 *     conjunction — `` `a`, `b` oder `c` `` / `` `a`, `b` or `c` ``. It has to be
 *     done here rather than in the template because the number of names is not
 *     known until runtime, and the joiner is itself a translated word.
 */
function fill(t, key, vars) {
  if (!vars) return t(key);
  const prepared = {};
  for (const [name, value] of Object.entries(vars)) {
    prepared[name] = Array.isArray(value) ? joinNames(t, value) : value;
  }
  return t(key, prepared);
}

/** "`a`", "`a` oder `b`", "`a`, `b` oder `c`" — a translated list, not a JS join. */
function joinNames(t, names) {
  const ticked = names.map((name) => `\`${name}\``);
  if (ticked.length <= 1) return ticked[0] ?? '';
  return `${ticked.slice(0, -1).join(', ')} ${t('hint.suggest.or')} ${ticked.at(-1)}`;
}

/**
 * A hint as one sentence in the active locale.
 *
 * `t` is a parameter rather than an import: this file stays pure, and the test
 * can render the same hint through both catalogues without a module-level
 * locale to set and reset between cases.
 *
 * The did-you-mean is appended as its own sentence rather than being part of
 * the main template, because the same fragment follows six different openings
 * and `kind` picks between two very different claims — a near miss is a guess,
 * a capitalisation difference is a diagnosis.
 */
export function renderHint(found, t) {
  if (!found) return null;
  const text = fill(t, found.key, found.vars);
  if (!found.suggestion) return text;
  return `${text} ${fill(t, `hint.suggest.${found.suggestion.kind}`, {
    names: found.suggestion.names,
  })}`;
}

/** Which SQLSTATEs have an explanation — for the test, and for a quick count. */
export const EXPLAINED = Object.keys(HANDLERS);
