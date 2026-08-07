/**
 * The translation layer — phase 6b.
 *
 * German is the default and English is a first-class locale, not a fallback for
 * individuals: the school has immersion classes taught entirely in English, so a
 * whole class works in `en` for a term. That is what makes the missing-key
 * behaviour below worth thinking about rather than asserting.
 *
 * ---
 *
 * **German is statically imported; English is fetched only when asked for.**
 * Lookup runs `en -> de -> the key itself`. Three consequences, all deliberate:
 *
 *   - A key that exists in `de` but not yet in `en` renders *in German* rather
 *     than as `roster.students.none`. A half-swept catalogue degrades to a
 *     bilingual page, which is ugly but readable; the alternative degrades to
 *     debug output in front of a class.
 *   - A key missing from *both* renders as the key. Loud on purpose — a silent
 *     empty string is how a label disappears for a term without anyone filing it.
 *   - `t()` called before `load()` resolves returns German, because the German
 *     catalogue is already there. Pages ship with German in the markup and swap
 *     after `/api/me`, so this is the same string either way.
 *
 * **`localStorage["chalk-lang"]` is a cache, and the server always wins.**
 * Phase 6b left this out because there was no `chalk-theme` convention for it to
 * match; phase 7 built one, which made the question it was deferred over —
 * "which side wins after a switch on a second device?" — finally answerable.
 *
 * The answer is that the question was the wrong shape. There are not two sides.
 * `app_user.locale` is the source of truth and this key is a **paint-ahead
 * cache**: `paintCached()` reads it to choose the language for the first frame,
 * and the moment `/api/me` answers, that response overwrites both the DOM and
 * the key. So a student who switched to English in the classroom and opens the
 * app on a laptop that has never seen them gets one frame of German and then
 * English — strictly better than before, when they got German until `/api/me`
 * returned, and with no new authority anywhere.
 *
 * This is the opposite of `chalk-theme`, which `util.js` documents from its
 * side: the theme is device-local so `localStorage` *is* authoritative there.
 * Two keys, adjacent, deliberately asymmetric.
 *
 * `/login` is the one page where this key genuinely decides, because there is no
 * account yet to ask. It is also the only place a stale value can survive a
 * whole page view, which is a good trade for a login form in the last language
 * this browser used.
 *
 * **Substitution values are plain text, never markup.** `t()` does not escape —
 * the caller does, because the caller knows whether it is writing to
 * `textContent` (no escaping, and `esc()` there would render a literal `&amp;`)
 * or building HTML. Backticks in a catalogue string mark an identifier and the
 * page turns them into `<code>` *after* escaping; see `sql.js`'s `ticked()` for
 * why that order is the whole safety argument.
 */

/**
 * Relative, not `/assets/i18n-de.js` like the other page scripts import each
 * other. The page scripts get away with absolute because nothing imports *them*
 * outside a browser; this module is imported by `test/i18n.test.mjs` under Node,
 * where a root-absolute specifier does not resolve to anything. Relative works
 * in both — the module is served from `/assets/`, so `./i18n-de.js` is the same
 * file either way. The dynamic import in `load()` is relative for the same reason.
 */
import de from './i18n-de.js';
import { json } from './util.js';

/** The locales `app_user.locale`'s CHECK constraint allows. Keep in step with it. */
export const LOCALES = ['de', 'en'];

/** The paint-ahead cache's key. See the header for why it is not a source of truth. */
const LANG_KEY = 'chalk-lang';

/**
 * The last locale this browser is known to have rendered, or `null`.
 *
 * Validated against `LOCALES` rather than trusted: this is the one input to the
 * page that a student can edit by hand, and while the blast radius is "the first
 * frame is in a language you asked for", `load()` should not be handed arbitrary
 * strings on its account. `null` means "no opinion", which paints German.
 */
export function cachedLocale() {
  try {
    const stored = localStorage.getItem(LANG_KEY);
    return LOCALES.includes(stored) ? stored : null;
  } catch {
    // Private browsing can throw on access rather than returning null.
    return null;
  }
}

/**
 * Update the cache. Called with what was *asked for*, not with what was
 * successfully loaded — those differ when the English catalogue fails to fetch,
 * and in that case the account is still English. Writing the German fallback
 * here would mean one transient asset failure poisons the first frame of every
 * later visit.
 */
function remember(wanted) {
  if (!LOCALES.includes(wanted)) return;
  try {
    localStorage.setItem(LANG_KEY, wanted);
  } catch {
    /* private mode: the cache is simply always empty, which paints German */
  }
}

/**
 * Pure, and exported for the test: a catalogue pair in, a lookup function out.
 *
 * `fallback` is the German catalogue for English and null for German itself.
 * Kept a parameter rather than reaching for the module-level import so the test
 * can drive the fallback chain with two small objects instead of the real 200-key
 * catalogues, where a missing key is hard to arrange on purpose.
 */
export function translator(catalog, fallback = null) {
  const lookup = (key) => catalog?.[key] ?? fallback?.[key] ?? null;

  const t = (key, vars) => {
    const template = lookup(key);
    if (template === null) return key;
    if (vars === undefined) return template;
    /**
     * A placeholder with no matching var is left as written rather than replaced
     * with `undefined`. `{name}` in the output is a bug report; the string
     * "undefined" mid-sentence is a bug report that looks like a translation.
     */
    return template.replace(/\{(\w+)\}/g, (whole, name) =>
      Object.hasOwn(vars, name) ? String(vars[name]) : whole,
    );
  };

  /**
   * Whether a key resolves at all, which the error map needs and plain lookup
   * cannot express: an unmapped `error.code` has to fall through to the English
   * developer message from the API, and `t()` returning the key is
   * indistinguishable from a catalogue entry that happens to equal its key.
   */
  t.has = (key) => lookup(key) !== null;

  return t;
}

/**
 * The active translator. German until `load()` says otherwise — see the header:
 * this is what makes a `t()` before the locale is known render German instead of
 * a key.
 */
let current = translator(de);
let currentLocale = 'de';

/** What `load()` last accepted — for `<html lang>` and the select's initial value. */
export const locale = () => currentLocale;

/** `t(key, vars)`. A binding rather than a re-export so `load()` can swap it. */
export const t = (key, vars) => current(key, vars);
t.has = (key) => current.has(key);

/**
 * Point `t` at a locale. Idempotent, and safe to call with anything: an
 * unrecognised locale is German, which is the same answer the database's
 * `app_user_locale_ck` would give.
 *
 * The dynamic import is why the English catalogue is a `.js` module and not the
 * `i18n/en.json` ARCHITECTURE §8a described. Two reasons, and the first is
 * mechanical: `/assets/:file` is a *single* path segment (server.ts), so
 * `/assets/i18n/en.json` does not route, and JSON import attributes are still
 * uneven across the browsers a school laptop actually runs. A module also lets
 * `test/i18n.test.mjs` import the real catalogues directly with no fetch to
 * stub. The shape is what §8a asked for — one flat object of string keys.
 *
 * **Never rejects.** Every page calls this with a top-level `await` before it
 * renders, so a throw here would abort module evaluation and leave the shell on
 * screen with nothing behind it — a dead page, for English students only, on the
 * day the asset fails to load. That is §4k's failure in a new costume, and it is
 * worth two lines to not have it: a catalogue that will not load means the page
 * is German, which is what it already says in its markup.
 */
export async function load(wanted) {
  cachedFormats = null;
  remember(wanted);
  if (wanted !== 'en') {
    current = translator(de);
    currentLocale = 'de';
    return t;
  }
  try {
    const { default: en } = await import('./i18n-en.js');
    current = translator(en, de);
    currentLocale = 'en';
  } catch {
    current = translator(de);
    currentLocale = 'de';
  }
  return t;
}

/**
 * Swap the German that ships in the markup for the active locale.
 *
 * Pages carry their strings twice — once as readable German in the HTML, once as
 * a `data-i18n` key — and this replaces the first from the second. That is not
 * redundancy for its own sake: the pages are served as static bytes with no
 * substitution of any kind (`routes/pages.ts`), so *something* has to be in the
 * markup, and German that a broken script leaves standing beats an empty shell.
 * §4k is the same argument one level down.
 *
 * `data-i18n-attr` carries `attribute:key` pairs for the strings that are not
 * text — placeholders and titles — because those cannot be expressed as a child
 * node.
 *
 * **`data-i18n` sets `textContent`, so it destroys child elements.** Never put
 * it on a `<label>` that wraps its own `<input>`: the swap eats the control and
 * leaves a dead form field, in whichever locale was swept second. Wrap the text
 * in a `<span data-i18n>` instead — `sql.html`'s import dialog is the worked
 * example. The same applies to any element that has markup inside it.
 */
export function apply(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of root.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of el.dataset.i18nAttr.split(/\s+/)) {
      const split = pair.indexOf(':');
      if (split > 0) el.setAttribute(pair.slice(0, split), t(pair.slice(split + 1)));
    }
  }
  document.documentElement.lang = currentLocale;
}

/**
 * Paint the first frame in the language this browser last used, before anyone
 * has asked the server who is looking.
 *
 * Call it *without* awaiting `/api/me` first — start that fetch, call this, then
 * await it — or the round trip this exists to hide is still in front of you.
 * The pattern every page uses:
 *
 *     const mePromise = get('/api/me');
 *     await paintCached();
 *     const me = await mePromise;
 *     ...
 *     await load(me.user.locale);   // the server, which is the actual authority
 *     apply();
 *
 * The second `load()`/`apply()` pair is not redundant and must not be optimised
 * away on the grounds that it usually matches: it is the entire reason this is
 * safe. Removing it would promote `localStorage` to a source of truth, and a
 * student whose locale a teacher changed would keep seeing the old language on
 * the one device that had cached it.
 */
export async function paintCached() {
  await load(cachedLocale());
  apply();
}

/**
 * Number, date and time formatters for the active locale — `de-CH` or `en-CH`.
 *
 * **The region stays Swiss in both; only the language moves.** That is the whole
 * point, and it is what makes following the UI language safe here. `en-CH` keeps
 * the apostrophe group separator (`1'234.5`), the day-first date and the
 * 24-hour clock; against `de-CH` the only visible difference across these four
 * call sites is that dates gain zero-padding — `04.03.2026` rather than
 * `4.3.2026`. So two students side by side, one reading English, still see the
 * same numbers in the same shape, which was the requirement.
 *
 * `en-US` would have broken it: `3/4/2026` and `2:03:22 PM` put month before day
 * in a Swiss classroom. If this ever gets a third locale, keep the `-CH`.
 *
 * None of this touches the result grid, and it must not start to. §4l has the
 * app return dates as *text* from Postgres precisely so the process timezone
 * cannot reach a student's data, and the Swiss formatting of the values
 * themselves is the databases' ICU `de-CH` collation, server-side. These
 * formatters are for chrome: row counts, durations, a login date.
 *
 * Memoised rather than rebuilt per call, because `renderTree()` formats a row
 * estimate for every table a teacher can see. `load()` clears it — a formatter
 * built before the locale was known would be German for the rest of the page.
 */
let cachedFormats = null;

export function formats() {
  if (cachedFormats === null) {
    const tag = `${currentLocale}-CH`;
    cachedFormats = {
      tag,
      number: new Intl.NumberFormat(tag),
      date: (value) => value.toLocaleDateString(tag),
      time: (value) => value.toLocaleTimeString(tag),
      /**
       * The footer's build stamp. `short`/`short` rather than the `date` + `time`
       * pair above, because those give seconds — precision nobody reads on a
       * build time, and three more characters on the one line of the page that
       * has to stay out of the way.
       */
      dateTime: (value) =>
        new Intl.DateTimeFormat(tag, { dateStyle: 'short', timeStyle: 'short' }).format(value),
    };
  }
  return cachedFormats;
}

/**
 * The German (or English) text for an API error, falling back to the English
 * developer message when the code is not in the catalogue.
 *
 * That fallback is the whole design. `http/errors.ts` says `code` is stable and
 * machine-readable "precisely so a German string can be keyed off it", and
 * `message` "is never the thing a student reads" — but a code we have not mapped
 * yet is a real possibility, and an English sentence beats `error.last_class`
 * rendered raw. `t.has()` exists for exactly this distinction.
 *
 * Takes the whole `{ code, message }` rather than a code, because the caller
 * always has both and the fallback needs the second.
 */
export function errorText(error) {
  const key = `error.${error?.code}`;
  if (error?.code && t.has(key)) return t(key);
  return error?.message ?? t('error.unknown');
}

/**
 * Point the language `<select>` at the account and make it switch on change.
 *
 * A full reload rather than a re-render: the pages build most of their content
 * from script, and a locale swap would have to re-run every render function on
 * every page to be complete. Reloading is one line, is obviously correct, and
 * costs a student one page load in a term. `PATCH /api/me` first, so the
 * reloaded page reads the new value back from the server rather than trusting
 * anything held on the client.
 *
 * If the PATCH fails the select is put back — silently switching the label while
 * the account still says `de` would make the next page load look like it lost
 * the setting.
 */
export function wireLanguageSelect(select) {
  if (!select) return;
  select.value = currentLocale;
  select.addEventListener('change', async () => {
    const wanted = select.value;
    const response = await fetch('/api/me', json({ locale: wanted }, 'PATCH')).catch(() => null);
    if (!response?.ok) {
      select.value = currentLocale;
      return;
    }
    // Before the reload, not after: the reloaded page paints its first frame
    // from this key, so writing it only on the way back up would mean every
    // language switch flashes the language you just left.
    remember(wanted);
    location.reload();
  });
}
