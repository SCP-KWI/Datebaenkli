/**
 * German — the default locale, and the fallback for every key English has not
 * caught up with yet (`i18n.js`).
 *
 * **Swiss orthography: no ß, ever.** `gross`, `heisst`, `schliessen`, `verstösst`.
 * This is a Swiss school. `hints.js`'s header says the same thing and this is now
 * where the sentences it used to hold actually live.
 *
 * **SQL keywords stay English in both locales** (ARCHITECTURE §8a). `SELECT` is
 * `SELECT` in German, `GROUP BY` is `GROUP BY`, and a hint that explains one
 * names it as written.
 *
 * **Backticks mark identifiers and code.** The page escapes first and turns
 * `` `x` `` into `<code>x</code>` second — see `sql.js`'s `ticked()`, where that
 * order is the whole injection argument. Nothing else is markup: an asterisk
 * written for emphasis reaches the student as an asterisk.
 *
 * `{name}` is a substitution. A placeholder with no matching value is left in
 * the output rather than replaced with "undefined", so a mistake here looks like
 * a mistake.
 */

export default {
  // --- the SQLSTATE hints (phase 6a's sentences, phase 6b's keys) ------------
  //
  // Named for what the student got wrong rather than for the SQLSTATE: 42P01
  // alone covers four different mistakes, and `hint.schema.unknown` serves two
  // codes. `hints.js` decides which of these applies; it never phrases one.

  'hint.suggest.near': 'Meintest du {names}?',
  'hint.suggest.case':
    'Es gibt {names} — nur anders geschrieben. Postgres schreibt Namen ohne ' +
    'Anführungszeichen automatisch klein; in Anführungszeichen zählt die Gross- und ' +
    'Kleinschreibung genau.',
  /** The conjunction in "`a`, `b` oder `c`". Joined by `hints.js`, not by a template. */
  'hint.suggest.or': 'oder',

  'hint.table.missing_from':
    'Die Tabelle `{table}` steht nicht im FROM. Entweder fehlt sie dort — oder du hast ihr ' +
    'im FROM einen Alias gegeben, und dann musst du überall diesen Alias verwenden statt ' +
    'des Tabellennamens.',
  'hint.table.not_in_schema': 'In `{schema}` gibt es keine Tabelle `{table}`.',
  'hint.table.unknown': 'Die Tabelle `{table}` gibt es nicht.',
  'hint.table.unknown_alone':
    'Die Tabelle `{table}` gibt es nicht. Links in der Tabellenliste siehst du alle, die du ' +
    'lesen darfst.',
  'hint.table.other_schema':
    'Die Tabelle `{table}` gibt es in deinem Schema nicht. Es gibt aber {names} — Tabellen ' +
    'aus einem anderen Schema musst du mit dem Schema-Namen davor ansprechen.',
  'hint.table.exists':
    'Die Tabelle `{table}` gibt es schon. Wähle einen anderen Namen — oder lösche die alte ' +
    'zuerst, dann sind ihre Daten allerdings weg.',

  'hint.schema.unknown': 'Das Schema `{schema}` gibt es nicht.',

  'hint.column.unknown_in_table': 'Die Tabelle `{relation}` hat keine Spalte `{column}`.',
  'hint.column.unknown_in_alias': 'Die Spalte `{column}` gibt es in `{prefix}` nicht.',
  'hint.column.unknown': 'Die Spalte `{column}` gibt es nicht.',
  'hint.column.ambiguous':
    'Die Spalte `{column}` gibt es in mehr als einer Tabelle dieser Abfrage. Schreib dazu, ' +
    'welche gemeint ist, z. B. `kunden.{column}`.',
  'hint.column.twice': 'Die Spalte `{column}` kommt in dieser Anweisung zweimal vor.',
  'hint.column.not_null':
    'Die Spalte `{column}` in `{table}` ist als NOT NULL angelegt und braucht darum in jeder ' +
    'Zeile einen Wert.',

  'hint.syntax.at':
    'Bei `{token}` kommt Postgres nicht weiter. Der Fehler selbst steckt meist unmittelbar ' +
    'davor — ein fehlendes Komma, ein Tippfehler im Schlüsselwort oder eine nicht ' +
    'geschlossene Klammer.',
  'hint.syntax.end': 'Die Anweisung hört mitten drin auf — nach dem letzten Wort fehlt noch etwas.',
  'hint.syntax.other': 'Die Anweisung ist so nicht aufgebaut, wie SQL es erwartet.',

  'hint.groupby':
    'Sobald eine Aggregatfunktion wie `count(...)`, `sum(...)` oder `avg(...)` im SELECT ' +
    'steht, muss jede andere Spalte des SELECT auch im GROUP BY stehen — sonst weiss ' +
    'Postgres nicht, welchen der zusammengefassten Werte es zeigen soll.',

  'hint.function.unknown': 'Die Funktion `{name}` gibt es nicht — oder nicht für diese Datentypen.',
  'hint.operator.unknown':
    'Die Operation `{operator}` gibt es nicht: die beiden Seiten haben verschiedene ' +
    'Datentypen. Zum Aneinanderhängen von Text ist übrigens `||` zuständig, nicht `+`.',

  'hint.type.boolean_condition':
    'Eine {clause}-Bedingung muss wahr oder falsch ergeben. Ein Wert vom Typ `{type}` tut ' +
    "das nicht — es fehlt der Vergleich, also etwa `WHERE name = 'Muster'` statt `WHERE name`.",
  'hint.type.other': 'Hier passt der Datentyp nicht zu dem, was an dieser Stelle erwartet wird.',

  'hint.orderby.position':
    'Die Zahl nach ORDER BY meint die wievielte Spalte der SELECT-Liste — und so viele ' +
    'Spalten hat sie nicht. Sicherer ist es, den Spaltennamen zu schreiben statt die Position.',

  'hint.unique.key':
    'Der Wert `{value}` für `{column}` ist schon vergeben. Diese Spalte muss in jeder Zeile ' +
    'verschieden sein.',
  // 6a wrote "Dieser Wert gibt es", which is the wrong case. Corrected while the
  // sentence was being moved rather than left to be read by a class.
  'hint.unique.other': 'Diesen Wert gibt es in der Tabelle schon, und die Spalte muss eindeutig sein.',

  'hint.fk.missing':
    'In `{table}` gibt es keine Zeile mit `{column}` = `{value}`. Ein Fremdschlüssel darf nur ' +
    'auf eine Zeile zeigen, die es wirklich gibt — lege sie zuerst an.',
  'hint.fk.referenced_by_named':
    'Diese Zeile kann nicht weg, solange eine andere Tabelle noch auf sie zeigt — `{table}` ' +
    'tut das. Lösche zuerst dort.',
  'hint.fk.referenced_by':
    'Diese Zeile kann nicht weg, solange eine andere Tabelle noch auf sie zeigt. Lösche ' +
    'zuerst dort.',
  'hint.fk.other': 'Ein Fremdschlüssel zeigt auf eine Zeile, die es nicht (mehr) gibt.',

  'hint.check.violated':
    'Die Zeile verstösst gegen die Regel `{constraint}` der Tabelle `{table}`. Solche ' +
    'CHECK-Regeln stehen in der Tabellendefinition und gelten für jede Zeile.',

  'hint.input.invalid':
    '`{value}` ist kein gültiger Wert vom Typ `{type}`. Text gehört in einfache ' +
    'Anführungszeichen, Zahlen nicht — und in eine Zahlenspalte gehört kein Text.',

  'hint.divzero':
    'Durch null lässt sich nicht teilen. Wenn der Teiler null sein kann, hilft ' +
    '`NULLIF(spalte, 0)`: das ergibt dann einen leeren Wert statt eines Fehlers.',
  'hint.overflow': 'Der Wert ist zu gross (oder zu klein) für den Datentyp der Spalte.',

  'hint.date.invalid_named':
    '`{value}` ist kein gültiges Datum. Postgres erwartet Jahr-Monat-Tag, also `2025-04-03` ' +
    'für den 3. April 2025.',
  'hint.date.invalid':
    'Das ist kein gültiges Datum. Postgres erwartet Jahr-Monat-Tag, also `2025-04-03` für ' +
    'den 3. April 2025.',

  // Neutral about *what* depends on the table: 2BP01 also covers a foreign key
  // in another table, and the handler reads names out of `detail` without the
  // kind. "meistens eine View" in the unnamed variant is a guess and says so.
  'hint.depends.named':
    'Auf `{table}` bauen andere Objekte auf: {names}. Solange es die gibt, lässt sich die ' +
    'Tabelle nicht löschen — nimm die zuerst weg.',
  'hint.depends':
    'Auf `{table}` bauen andere Objekte auf, meistens eine View. Solange es die gibt, lässt ' +
    'sich die Tabelle nicht löschen.',

  'hint.denied':
    'Dafür fehlen dir die Rechte. Du darfst in deinem eigenen Schema alles und die ' +
    '`demo`-Tabellen lesen — andere Schemas sind für dich gesperrt.',
  'hint.aborted':
    'Eine frühere Anweisung in diesem Skript ist fehlgeschlagen. Alles danach wird ' +
    'übersprungen, bis die Transaktion beendet ist — korrigiere die erste fehlerhafte ' +
    'Anweisung und lass das Skript nochmals laufen.',

  // --- shared ---------------------------------------------------------------

  'common.loading': 'wird geladen …',
  'common.cancel': 'Abbrechen',
  'nav.overview': 'Übersicht',

  // --- API error codes ------------------------------------------------------
  //
  // Keyed off `error.code`, which `http/errors.ts` calls stable and
  // machine-readable "precisely so a German string can be keyed off it". A code
  // with no entry here falls back to the English developer `message` rather than
  // rendering the key — see `errorText()`.

  'error.offline': 'Keine Verbindung zum Server.',
  'error.unknown': 'Etwas ist schiefgelaufen.',
  'error.unauthenticated': 'Du bist nicht mehr angemeldet.',
  'error.forbidden': 'Dafür fehlen dir die Rechte.',
  'error.not_found': 'Nicht gefunden.',
  'error.bad_request': 'Die Anfrage war fehlerhaft.',
  'error.internal': 'Auf unserer Seite ist etwas schiefgelaufen.',
  'error.invalid_locale': 'Diese Sprache gibt es nicht.',
  'error.invalid_name': 'Dieser Name geht so nicht.',
  'error.invalid_code': 'Dieses Klassenkürzel geht so nicht — zwei bis zwölf Kleinbuchstaben oder Ziffern.',
  'error.empty_batch': 'Es wurde niemand eingetragen.',
  'error.invalid_table_name': 'Dieser Tabellenname geht so nicht.',
  'error.duplicate_column_name': 'Zwei Spalten haben denselben Namen.',
  'error.column_count_mismatch': 'Nicht alle Zeilen haben gleich viele Felder.',
  'error.empty_csv': 'Die Datei enthält keine Daten.',
  'error.csv_too_many_rows': 'Die Datei hat zu viele Zeilen für einen Import.',
  'error.csv_too_many_columns': 'Die Datei hat zu viele Spalten für einen Import.',
  'error.quota_exceeded':
    'Dein Speicherplatz ist voll. Lösche Tabellen, die du nicht mehr brauchst, und ' +
    'versuch es nochmals.',
  'error.table_exists':
    'Eine Tabelle mit diesem Namen gibt es schon. Wähle einen anderen Namen — oder kreuze ' +
    '«Bestehende Tabelle ersetzen» an.',
  'error.password_too_short': 'Das Passwort ist zu kurz.',
  'error.password_unchanged': 'Das neue Passwort ist dasselbe wie das alte.',
  'error.class_archived': 'Diese Klasse ist archiviert.',
  'error.code_taken': 'Dieses Klassenkürzel ist schon vergeben.',
  'error.last_class': 'Das ist die einzige Klasse dieser Person und kann nicht auch noch weg.',
  'error.user_not_active': 'Dieses Konto ist nicht aktiv.',
  'error.cold_students_only': 'Nur Konten von Lernenden lassen sich einlagern.',
  'error.restore_first': 'Dieses Konto muss zuerst wiederhergestellt werden.',
  'error.wrong_password': 'Das Passwort stimmt nicht.',
  'error.not_provisioned':
    'Für dieses Konto ist noch keine Datenbank eingerichtet. Versuch es in einem Moment nochmals.',
  // Deliberately not "deine vorherige Abfrage läuft noch", which is what the
  // English developer message says. That is the usual cause, not a known one —
  // and stating it as fact is what hid §4dd for a day. Name the symptom, offer
  // the likely fix, and say what to do when it is not that.
  'error.too_many_queries':
    'Alle deine Verbindungen sind gerade belegt. Meistens läuft noch eine eigene Abfrage — ' +
    'warte kurz oder brich sie ab. Hilft das nicht, sag der Lehrperson Bescheid.',
  'error.not_implemented': 'Das gibt es noch nicht.',
  'error.class_not_found': 'Diese Klasse gibt es nicht.',
  'error.teacher_not_found': 'Diese Lehrperson gibt es nicht.',
  'error.user_not_found': 'Dieses Konto gibt es nicht.',
  'error.member_not_found': 'Diese Person ist nicht in dieser Klasse.',

  // --- the SQL page ---------------------------------------------------------

  'sql.title': 'SQL — Datebänkli',
  'sql.import': 'CSV importieren',
  'sql.reset': 'Datenbank zurücksetzen',
  'sql.tables': 'Tabellen',
  'sql.run': 'Ausführen',
  'sql.run_key': 'Ausführen ({key})',
  'sql.ctrl': 'Strg+↵',
  'sql.result': 'Ergebnis',
  'sql.running': 'läuft …',
  'sql.row': 'Zeile',
  'sql.rows': 'Zeilen',
  'sql.detail': 'Detail',
  'sql.hint': 'Hinweis',
  'sql.place': 'Stelle',
  'sql.position': 'Zeile {line}, Zeichen {column}',
  'sql.error_status': 'Fehler {code} · {ms} ms',
  'sql.busy': 'Erst die laufende Abfrage abwarten oder abbrechen.',
  'sql.foreign_loaded': 'Abfrage eingefügt — zum Ausführen auf «Ausführen» klicken.',
  'sql.refused': 'Die Anfrage wurde abgelehnt.',
  'sql.cancel_failed': 'Abbruch fehlgeschlagen.',
  'sql.already_done': 'Die Abfrage war bereits fertig.',
  'sql.cancelled_user': 'Abgebrochen.',
  'sql.cancelled_timeout': 'Zu lange gelaufen und automatisch gestoppt.',
  'sql.tables_failed': 'Konnte die Tabellen nicht laden.',
  'sql.table_title': 'Klicken für SELECT * … LIMIT 50',
  'sql.no_columns': 'keine Spalten',
  // Only ever shown for the reader's OWN schema — it is the one place the
  // invitation is true. `sql.js`'s renderTree has the argument.
  'sql.no_tables': 'Noch keine Tabellen. Leg mit CREATE TABLE eine an.',
  // Every other empty schema: `public`, `demo`, another student's. Nobody can
  // create in those, so this says what is there and stops.
  'sql.no_tables_readonly': 'Keine Tabellen.',
  // Under the tree, and deliberately undramatic: it is ambient information for
  // a student who is nowhere near the limit, and only becomes an instruction in
  // `sql.quota_full` below. `lesson.over_quota` is the teacher's wording for the
  // same state — theirs answers "why is this student stuck", this one answers
  // "what do I do now", so the two are not shared.
  'sql.quota': '{used} von {total} belegt',
  'sql.quota_full':
    '{used} von {total} belegt — voll. Lösche Tabellen oder Zeilen, sonst wird jeder ' +
    'schreibende Befehl abgewiesen.',
  'sql.truncated': 'Es werden die ersten {shown} von {total} gezeigt.',
  'sql.rollback':
    'Ein Skript läuft als eine einzige Transaktion: schlägt eine Anweisung fehl, werden auch ' +
    'die Anweisungen davor zurückgenommen.',
  'sql.reset_confirm':
    'Alle deine Tabellen und alle Daten darin werden gelöscht. Das lässt sich nicht ' +
    'rückgängig machen.\n\nWirklich zurücksetzen?',
  'sql.resetting': 'wird zurückgesetzt …',
  'sql.reset_done': 'Datenbank zurückgesetzt.',
  'sql.reset_failed': 'Zurücksetzen fehlgeschlagen.',
  'sql.reset_unknown':
    'Keine Antwort vom Server. Lade die Seite neu, um zu sehen, ob das Zurücksetzen geklappt hat.',

  // --- the CSV import dialog ------------------------------------------------

  'import.title': 'CSV importieren',
  'import.file': 'Datei',
  'import.table': 'Tabellenname',
  'import.delimiter': 'Trennzeichen',
  'import.semicolon': 'Strichpunkt ;',
  'import.comma': 'Komma ,',
  'import.tab': 'Tabulator',
  'import.pipe': 'Strich |',
  'import.first_row': 'Erste Zeile sind Spaltennamen',
  'import.replace': 'Bestehende Tabelle ersetzen',
  'import.columns': 'Spalten',
  'import.in_file': 'in der Datei',
  'import.column_name': 'Spaltenname',
  'import.type': 'Datentyp',
  'import.preview': 'Vorschau',
  'import.go': 'Importieren',
  'import.summary': '{rows} · {columns} Spalten',
  'import.preview_first': 'Vorschau der ersten {rows} Zeilen.',
  'import.no_rows': 'Keine Datenzeilen gefunden.',
  'import.too_many_rows': 'Die Datei hat zu viele Zeilen für einen Import.',
  'import.too_many_columns': 'Die Datei hat zu viele Spalten für einen Import.',
  'import.refused': 'Der Server hat die Anfrage abgelehnt.',
  'import.too_large': 'Die Datei ist {size} MB gross; erlaubt sind 10 MB.',
  'import.reading': 'wird gelesen …',
  'import.importing': 'wird importiert …',
  'import.not_run': 'Der Import wurde nicht ausgeführt.',
  'import.pick_file': 'Wähle eine CSV-Datei.',
  'import.bad_values': 'Diese Werte passen nicht zum gewählten Datentyp:',
  'import.bad_value': 'Zeile {line}, Spalte',
  'import.not_of_type': 'ist kein Wert vom Typ',
  'import.choose_text': 'Wähle für diese Spalte den Typ text, oder korrigiere die Datei.',

  // The column types a student picks from. Names, not SQL — the `text`,
  // `integer` and `date` beside them in the dropdown are the SQL, and those stay
  // English in both locales like every other keyword.
  'type.text': 'Text',
  'type.integer': 'Ganzzahl',
  'type.bigint': 'grosse Ganzzahl',
  'type.numeric': 'Dezimalzahl',
  'type.boolean': 'Ja/Nein',
  'type.date': 'Datum',
  'type.timestamp': 'Datum + Zeit',

  // --- the forced / voluntary password change -------------------------------

  'password.title': 'Passwort ändern — Datebänkli',
  'password.heading': 'Passwort ändern',
  'password.rule': 'Mindestens 10 Zeichen.',
  'password.forced':
    'Dieses Konto braucht ein neues Passwort, bevor es benutzt werden kann. ' +
    'Mindestens 10 Zeichen.',
  'password.current': 'Aktuelles Passwort',
  'password.next': 'Neues Passwort',
  'password.repeat': 'Neues Passwort wiederholen',
  'password.save': 'Speichern',
  'password.mismatch': 'Die beiden neuen Passwörter stimmen nicht überein.',
  'password.failed': 'Änderung fehlgeschlagen.',

  // --- shared by the staff pages --------------------------------------------
  //
  // A word earns `common.*` by meaning the same thing on more than one page — a
  // column heading, a state, a button. One whose German only *happens* to
  // coincide stays with its page: two pages that drift apart later should not
  // have to untangle a shared key first. `home.col_code` and
  // `common.class_code` are that case ("Code" against "Kürzel", same column).

  'common.create': 'Anlegen',
  'common.close': 'Schliessen',
  'common.save': 'Speichern',
  'common.delete': 'Löschen',
  'common.edit': 'Bearbeiten',
  'common.name': 'Name',
  'common.username': 'Benutzername',
  'common.state': 'Status',
  'common.active': 'aktiv',
  'common.archived': 'archiviert',
  // "ausgelagert" rather than a translation of "cold": what the teacher needs
  // to know is that the tables have been moved off, not the temperature
  // metaphor the architecture document uses internally.
  'common.cold': 'ausgelagert',
  'common.first_name': 'Vorname',
  'common.last_name': 'Nachname',
  'common.teacher': 'Lehrperson',
  'common.students': 'Lernende',
  'common.class_code': 'Kürzel',
  'common.school_year': 'Schuljahr',
  'common.no_classes': 'Noch keine Klasse.',
  'common.class_empty': 'In dieser Klasse ist noch niemand eingetragen.',
  // The last resort of `send()` in `roster.js`: a non-2xx whose body carried no
  // error shape at all. The status number is in it because it is all there is.
  'common.failed': 'Fehlgeschlagen ({status}).',
  'common.role_admin': 'Administration',
  'common.role_teacher': 'Lehrperson',
  'common.role_student': 'Lernende:r',

  'nav.sql': 'SQL-Editor',
  'nav.lesson': 'Lektion',
  'nav.roster': 'Klassen',
  'nav.exercises': 'Übungen',
  // The theme toggle's label names the state it switches *to*, matching the icon
  // (Chalk §6). The control has no text of its own, so this label is the only
  // thing a screen reader gets — and `util.js` re-sets it on every flip.
  'nav.theme_dark': 'Auf dunkles Design wechseln',
  'nav.theme_light': 'Auf helles Design wechseln',

  // The footer. The address itself is not a catalogue entry — it is the same
  // string in both locales, and one that must never be translated by accident.
  'footer.contact': 'Fragen oder Probleme:',

  // --- the overview page ----------------------------------------------------

  'home.teachers': 'Lehrpersonen',
  'home.classes': 'Klassen',
  'home.col_code': 'Code',
  'home.nothing': 'Noch nichts zu sehen.',
  'home.password': 'Passwort ändern',
  'home.logout': 'Abmelden',

  // --- the roster page ------------------------------------------------------

  'roster.title': 'Klassen — Datebänkli',
  'roster.heading': 'Klassen & Lernende',
  'roster.teachers': 'Lehrpersonen',
  'roster.teacher_new': 'Neue Lehrperson',
  // Four of this page's hints wrap something in <code> or <strong> mid-sentence,
  // and `apply()` writes textContent — so each is split at the tag rather than
  // losing it. The split points are picked so both languages can leave the
  // marked-up word where it stands; roster.html carries the same note.
  'roster.teacher_hint_1':
    'Benutzernamen werden nie neu vergeben: eine zweite „Philip Schaffner“ wird für immer ',
  'roster.teacher_hint_2': '. Zuerst oben nachsehen.',
  'roster.classes': 'Klassen',
  'roster.class_new': 'Neue Klasse',
  'roster.class_hint_1': 'Das Kürzel steckt im Benutzernamen jeder Lernenden (',
  'roster.class_hint_2': ') und lässt sich nachher nicht mehr ändern.',
  'roster.add_students': 'Lernende hinzufügen',
  'roster.paste_hint_1': 'Eine Person pro Zeile. ',
  'roster.paste_hint_code': 'Nachname, Vorname',
  'roster.paste_hint_2': ' und aus Excel kopierte Spalten werden ebenfalls erkannt. Bei ',
  'roster.paste_hint_strong': 'zwei Vornamen',
  'roster.paste_hint_3':
    ' ist das Komma nötig — ohne es zählt der zweite Vorname zum Nachnamen, und der ' +
    'Benutzername bleibt so für immer.',
  // The example names stay as they are in both locales. They are there to show
  // the three *shapes* `names.js` handles — the plain line, the multi-word
  // surname, the comma that is the only way out of the case the space heuristic
  // gets wrong — and a translated "Von Gunten" would show none of them.
  'roster.paste_placeholder': 'Muster Lena\nVon Gunten Anna\nMaradona, Diego Armando',
  'roster.order': 'Reihenfolge',
  'roster.order_last_first': 'Nachname Vorname',
  'roster.order_first_last': 'Vorname Nachname',
  'roster.note':
    'Ein Zugangszettel existiert genau einmal — im Moment, in dem das Konto entsteht. ' +
    'Passwörter lassen sich nicht nachschlagen, nur neu ausstellen. Darum: erst drucken, ' +
    'dann schliessen. Geht die Ansicht trotzdem verloren, stellt „Neue Zettel“ in der ' +
    'Klassenliste welche aus für alle, die sich noch nie angemeldet haben — bei denen kann ' +
    'kein ausgeteilter Zettel entwertet werden.',

  'roster.slips_title': 'Zugangszettel',
  'roster.slips_last_chance':
    'Diese Passwörter sind hier zum letzten Mal zu sehen. Jetzt drucken oder abschreiben — ' +
    'danach sind sie nur noch neu ausstellbar.',
  'roster.print': 'Drucken',
  'roster.slips_done': 'Zettel sind gedruckt — schliessen',
  'roster.slips_no_schema':
    'Bei {count} Konto/Konten wurde das Schema noch nicht angelegt: {names}. Anmelden geht, ' +
    'eigene Tabellen noch nicht — der Abgleich beim nächsten Serverstart holt das nach.',
  'roster.slip_access': 'Datebänkli · Zugang',
  'roster.slip_address': 'Adresse',
  'roster.slip_password': 'Passwort',
  'roster.slip_foot':
    'Bitte aufbewahren. Das Passwort kann nicht nachgeschlagen, nur neu ausgestellt werden.',

  'roster.col_access': 'Zugang',
  'roster.col_first_login': 'Erste Anmeldung',
  'roster.no_teachers': 'Noch keine Lehrperson.',
  'roster.reslip': 'Neuer Zettel',
  'roster.reslip_teacher_confirm':
    'Neues Passwort ausstellen? Der alte Zettel gilt dann nicht mehr, und offene Sitzungen ' +
    'werden beendet.',
  'roster.slips_reslip': 'Neuer Zugangszettel',
  'roster.name_required': 'Vor- und Nachname sind nötig.',
  'roster.slips_new_teacher': 'Zugangszettel — neue Lehrperson',

  'roster.open': 'Öffnen',
  'roster.class_required': 'Kürzel und Name sind nötig.',
  'roster.class': 'Klasse',

  'roster.never': 'noch nie',
  'roster.archive': 'Archivieren',
  'roster.activate': 'Aktivieren',
  'roster.remove': 'Aus Klasse',
  'roster.reissue_one': 'Neue Zettel für eine:n Lernende:n ohne erste Anmeldung',
  'roster.reissue_many': 'Neue Zettel für {count} Lernende ohne erste Anmeldung',
  'roster.reissue_note': ' — für alle anderen wäre das ein bereits benutzter Zugang.',
  'roster.reissue_confirm':
    'Neue Zettel für {count} Lernende ausstellen? Betroffen sind nur Konten ohne erste ' +
    'Anmeldung.',
  'roster.reissue_aborted':
    'Abgebrochen bei {failure}\n\nDie bereits ausgestellten Zettel werden trotzdem angezeigt ' +
    '— diese Passwörter gelten jetzt.',
  'roster.slips_reissued': 'Neue Zugangszettel',
  'roster.reslip_student_confirm':
    'Neues Passwort für {name}? Der alte Zettel gilt dann nicht mehr.',
  'roster.slips_reslip_student': 'Neuer Zugangszettel — {name}',
  'roster.remove_confirm':
    '{name} aus dieser Klasse nehmen? Das Konto und die eigenen Tabellen bleiben bestehen; ' +
    'die Lehrperson verliert den Einblick.',

  // --- cold storage and deletion (phase 7.3) ----------------------------------
  //
  // The two are deliberately worded at different weights, because they are
  // different promises. Cold says "kommt zurück" and means it — "Aktivieren"
  // restores the dump. Deletion says the opposite in as many words, and the
  // one thing it must not do is imply a way back that this app does not have.
  'roster.cold': 'Auslagern',
  'roster.cold_confirm':
    'Die Tabellen von {name} auslagern? Sie werden auf den Server gesichert und aus der ' +
    'Datenbank entfernt — mit "Aktivieren" kommen sie zurück. Für Speicherplatz gedacht, ' +
    'nicht zum Aufräumen.',
  'roster.cold_incomplete':
    'Der Status von {name} steht auf "ausgelagert", aber die Sicherung ist ' +
    'fehlgeschlagen:\n\n{error}\n\nDie Tabellen sind noch da. Der Server versucht es beim ' +
    'nächsten Start erneut.',

  'roster.delete': 'Löschen',
  // Step one names the person and asks the question. Step two says what is
  // actually destroyed, what survives, and where. Two dialogs with the same
  // sentence would be one dialog and an extra click.
  'roster.delete_confirm':
    '{name} endgültig löschen?\n\nDas ist etwas anderes als "Aus Klasse" — das Konto ' +
    'verschwindet ganz.',
  'roster.delete_confirm_final':
    'Wirklich: {name} ({username})\n\nDas Schema und alle Tabellen darin werden gelöscht. ' +
    'Eine Sicherung bleibt auf dem Server liegen, aber diese Anwendung kann das Konto nicht ' +
    'wiederherstellen — nur ausgelagerte Konten lassen sich zurückholen.\n\nLöschen?',
  'roster.delete_incomplete':
    '{name} ist als gelöscht eingetragen, aber die Sicherung ist ' +
    'fehlgeschlagen:\n\n{error}\n\nDie Tabellen sind deshalb noch da — gelöscht wird erst, ' +
    'wenn die Sicherung geschrieben ist. Der Server versucht es beim nächsten Start erneut.',

  'roster.missing': 'fehlt',
  'roster.already_in_class': 'schon in der Klasse',
  'roster.preview_missing':
    '{count} Zeile(n) ohne Vornamen — bitte ergänzen, sonst steht der Name für immer falsch ' +
    'im Benutzernamen.',
  'roster.preview_ok':
    '{count} Personen. Bitte die Aufteilung prüfen: Benutzernamen werden nie geändert.',
  'roster.no_first_name': 'Mindestens eine Zeile hat keinen Vornamen.',
  'roster.create_confirm':
    '{count} Lernende anlegen? Die Zugangszettel erscheinen danach genau einmal.',
  'roster.slips_for': 'Zugangszettel — {class}',
  'roster.close_confirm': 'Die Passwörter sind danach nicht mehr einsehbar. Wirklich schliessen?',

  // --- the lesson page ------------------------------------------------------

  'lesson.title': 'Lektion — Datebänkli',
  'lesson.heading': 'Lektion',
  'lesson.window_30': 'letzte 30 Min.',
  'lesson.window_90': 'letzte 90 Min.',
  'lesson.window_240': 'letzte 4 Std.',
  'lesson.refresh': 'Jetzt aktualisieren',
  // Split around its <em>, for the reason the roster hints above are split.
  'lesson.note_1':
    '„Angemeldet“ heisst: eine gültige Sitzung — nicht unbedingt jemand am Platz. Wer über ' +
    'dem Speicherlimit ist, wird bei jedem schreibenden Befehl abgewiesen; solche Versuche ' +
    'erscheinen bewusst ',
  'lesson.note_em': 'nicht',
  'lesson.note_2': ' in der Liste der Befehle, darum steht das Limit hier daneben.',

  'lesson.just_now': 'gerade eben',
  'lesson.ago_seconds': 'vor {n} Sek.',
  'lesson.ago_minutes': 'vor {n} Min.',
  'lesson.ago_hours': 'vor {n} Std.',
  'lesson.over_quota': 'über Limit',
  'lesson.over_quota_detail': 'über Limit — schreibende Befehle werden abgewiesen',
  'lesson.nothing_run': 'noch nichts ausgeführt',
  'lesson.signed_in': 'angemeldet',
  'lesson.col_student': 'Schülerin / Schüler',
  'lesson.col_session': 'Sitzung',
  'lesson.col_last': 'Letzter Befehl',
  'lesson.col_errors': 'Fehler',
  'lesson.col_storage': 'Speicher',
  // Both the column heading and the heading over the drill-down list.
  'lesson.statements': 'Befehle',
  'lesson.no_statements': 'Noch keine Befehle.',
  'lesson.no_schema': 'Kein Einblick — dieses Konto hat keine eigene Datenbankrolle.',
  'lesson.schema_empty': 'Das Schema ist leer.',
  'lesson.not_counted': 'noch nicht gezählt',
  'lesson.sub': '{count} Eingetragene · Zähler ab {time}',

  'sql.imported': '{table} · {rows} importiert.',
  'sql.statement': '1 Anweisung',
  'sql.statements': '{n} Anweisungen',
  'sql.nothing': 'Nichts auszuführen.',
  'sql.changed': '{rows} geändert',

  // --- exercises (phase 9) ---------------------------------------------------
  //
  // `ex.` rather than `exercise.`, matching the `sql.`/`nav.`/`import.` prefixes
  // that are already short. The page is `/uebungen` but the keys are English,
  // like every other key in this file.
  'ex.title': 'Übungen — Datebänkli',
  'ex.heading': 'Übungen',
  'ex.eyebrow': 'Übung',
  'ex.mine_sub': 'Übungen, die deine Lehrperson verteilt hat.',
  'ex.none_yet': 'Im Moment ist keine Übung für dich freigegeben.',
  'ex.by': 'von {name}',
  'ex.opened': 'geöffnet',
  'ex.not_opened': 'noch nicht geöffnet',
  'ex.work_on': 'Bearbeiten',
  'ex.no_handins': 'Noch nichts abgegeben.',
  'ex.handin_count': '{count} Abgabe(n), zuletzt {when}',
  'ex.my_handins': 'Meine Abgaben',
  'ex.attempt': 'Abgabe {n}',
  'ex.download': 'Herunterladen',
  'ex.schema_label': 'Übung: {title}',

  // The teacher's half.
  'ex.yours': 'Deine Übungen',
  'ex.new': 'Neu',
  'ex.untitled': 'Neue Übung',
  'ex.none_authored': 'Noch keine Übung angelegt.',
  'ex.pick': 'Wähle links eine Übung aus oder leg eine neue an.',
  'ex.task': 'Aufgabenstellung (Markdown)',
  'ex.preview': 'Vorschau',
  'ex.saved': 'Gespeichert.',
  'ex.tables': 'Tabellen der Übung',
  'ex.no_tables': 'Noch keine Tabellen. Jede Lernende bekommt eine eigene Kopie davon.',
  'ex.add_csv': 'CSV hinzufügen',
  'ex.add_sql': 'SQL-Skript hinzufügen',
  'ex.csv_summary': '{rows} Zeilen, {columns} Spalten',
  'ex.sql_summary': 'Skript',
  'ex.move_up': 'Nach oben',
  'ex.sql_title': 'SQL-Skript',
  'ex.sql_label': 'Bezeichnung',
  'ex.sql_body': 'Skript',
  'ex.sql_hint':
    'Läuft im Übungs-Schema jeder Lernenden. Tabellennamen ohne Schema angeben.',
  'ex.drop_source_confirm': '„{label}“ aus der Übung entfernen?',

  'ex.distribution': 'Verteilung',
  'ex.not_distributed': 'Noch an keine Klasse verteilt.',
  'ex.class': 'Klasse',
  'ex.opened_by': 'geöffnet von',
  'ex.handins': 'Abgaben',
  'ex.distribute': 'Verteilen',
  'ex.view_handins': 'Abgaben ansehen',
  'ex.download_all': 'Alle herunterladen',
  'ex.take_back': 'Zurückziehen',
  // Two dialogs, and they say different things on purpose. The first asks; the
  // second states what does not survive. See `roster.js`'s header.
  'ex.take_back_confirm': 'Übung aus der Klasse {klass} zurückziehen?',
  'ex.take_back_confirm_final':
    'Endgültig: Bei {klass} werden {workspaces} Übungs-Datenbank(en) und {handins} Abgabe(n) gelöscht. Das lässt sich nicht rückgängig machen.',
  'ex.take_back_partial':
    '{count} Übungs-Datenbank(en) konnten nicht gelöscht werden. Bitte melden.',
  'ex.delete_confirm': 'Übung „{title}“ löschen?',
  'ex.delete_confirm_final':
    'Endgültig: „{title}“ wird gelöscht, samt allen Übungs-Datenbanken und allen Abgaben in allen Klassen.',
  'ex.no_handins_yet': 'Aus dieser Klasse ist noch nichts abgegeben worden.',

  'ex.try_it': 'Selber ausprobieren',
  'ex.try_it_why':
    'Baut die Tabellen in einem eigenen Schema auf, damit du das Skript vor der Lektion testen kannst.',
  'ex.build_mine': 'Tabellen aufbauen',
  'ex.open_editor': 'Im Editor öffnen',
  'ex.building': 'wird aufgebaut …',
  'ex.built': 'Aufgebaut in {schema}.',
  'ex.already_built': 'Ist schon da ({schema}).',
  'ex.build_failed': 'Fehler bei „{label}“: {message}',

  // The bar on /sql.
  'ex.show_task': 'Aufgabe',
  'ex.reset_tables': 'Tabellen zurücksetzen',
  'ex.hand_in': 'Abgeben',
  'ex.leave': 'Eigene Datenbank',
  'ex.opening': 'wird geöffnet …',
  'ex.open_failed': 'Die Übung konnte nicht geöffnet werden.',
  // The student can do nothing about this one, so it says whose problem it is.
  'ex.broken_fixture':
    'Die Tabelle „{label}“ der Übung liess sich nicht aufbauen ({message}). Bitte melde das deiner Lehrperson.',
  'ex.reset_confirm':
    'Die Tabellen von „{title}“ auf den Ausgangszustand zurücksetzen? Deine Änderungen darin gehen verloren. Deine eigene Datenbank bleibt unberührt.',
  'ex.resetting': 'wird zurückgesetzt …',
  'ex.reset_done': 'Tabellen zurückgesetzt.',
  'ex.reset_failed': 'Zurücksetzen fehlgeschlagen.',
  'ex.reset_unknown': 'Unklar, ob das Zurücksetzen geklappt hat. Lade die Seite neu.',
  'ex.hand_in_title': 'Lösung abgeben',
  'ex.hand_in_what': 'Abgegeben wird, was gerade im Editor steht. Du kannst mehrmals abgeben.',
  'ex.note': 'Notiz an die Lehrperson (freiwillig)',
  'ex.hand_in_empty': 'Der Editor ist leer.',
  'ex.hand_in_failed': 'Abgeben fehlgeschlagen.',
  'ex.handed_in': 'Abgabe {n} gespeichert.',

  // Errors this feature adds. `errorText()` keys off the API's `code`.
  'error.exercise_not_found': 'Diese Übung gibt es nicht (mehr).',
  'error.exercise_not_open': 'Öffne die Übung zuerst.',
  'error.not_your_exercise': 'Diese Übung gehört einer anderen Lehrperson.',
  'error.source_not_found': 'Diese Tabelle gehört nicht zu dieser Übung.',
  'error.submission_not_found': 'Diese Abgabe gibt es nicht.',
  'error.too_many_sources': 'Eine Übung kann höchstens 20 Tabellen oder Skripte haben.',
  'error.csv_types_rejected':
    'Einige Werte passen nicht zu den gewählten Datentypen. Korrigiere die Typen oder die Datei.',
};
