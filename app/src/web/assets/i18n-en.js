/**
 * English — a first-class locale, not a fallback for individuals.
 *
 * The school has immersion classes taught entirely in English, so a whole class
 * works in this file for a term. It is not a courtesy translation of the German
 * and should not read like one.
 *
 * Loaded only when the student's locale is `en` (`i18n.js` imports it
 * dynamically). Any key missing here falls back to `i18n-de.js` rather than to
 * the raw key, so a half-finished sweep degrades to a bilingual page instead of
 * to debug output in front of a class.
 *
 * **SQL keywords stay English** — which costs nothing here, but is the same rule
 * the German file follows, and it means `hint.type.boolean_condition`'s
 * `{clause}` substitution is identical in both.
 *
 * Backticks and `{name}` substitutions work exactly as in `i18n-de.js`; its
 * header has the argument.
 *
 * **The register is a 13-to-18-year-old being taught, not a manual.** The German
 * addresses the student as `du`; English has no such choice to make, so the
 * equivalent is the plain second person and short sentences. Where the German
 * says "Meintest du …?" the English says "Did you mean …?", not "The identifier
 * could not be resolved".
 */

export default {
  // --- the SQLSTATE hints ---------------------------------------------------
  //
  // An English-locale student still wants these. Postgres already speaks
  // English, but `42803` is not *explained* by `column … must appear in the
  // GROUP BY clause` — it is restated by it. These say why, not what.

  'hint.suggest.near': 'Did you mean {names}?',
  'hint.suggest.case':
    'There is {names} — the same name written differently. Postgres lower-cases names ' +
    'automatically when they are not in quotation marks; inside quotation marks the ' +
    'capitalisation has to match exactly.',
  /** The conjunction in "`a`, `b` or `c`". Joined by `hints.js`, not by a template. */
  'hint.suggest.or': 'or',

  'hint.table.missing_from':
    'The table `{table}` is not in the FROM. Either it is missing there — or you gave it an ' +
    'alias in the FROM, and then you have to use that alias everywhere instead of the table ' +
    'name.',
  'hint.table.not_in_schema': 'There is no table `{table}` in `{schema}`.',
  'hint.table.unknown': 'There is no table `{table}`.',
  'hint.table.unknown_alone':
    'There is no table `{table}`. The table list on the left shows every one you are allowed ' +
    'to read.',
  'hint.table.other_schema':
    'There is no table `{table}` in your own schema. There is {names} though — a table in ' +
    'another schema has to be written with its schema name in front.',
  'hint.table.exists':
    'The table `{table}` already exists. Pick another name — or drop the old one first, ' +
    'though that loses its data.',

  'hint.schema.unknown': 'There is no schema `{schema}`.',

  'hint.column.unknown_in_table': 'The table `{relation}` has no column `{column}`.',
  'hint.column.unknown_in_alias': 'There is no column `{column}` in `{prefix}`.',
  'hint.column.unknown': 'There is no column `{column}`.',
  'hint.column.ambiguous':
    'The column `{column}` exists in more than one table of this query. Say which one you ' +
    'mean, for example `kunden.{column}`.',
  'hint.column.twice': 'The column `{column}` appears twice in this statement.',
  'hint.column.not_null':
    'The column `{column}` in `{table}` is declared NOT NULL, so every row needs a value for ' +
    'it.',

  'hint.syntax.at':
    'Postgres cannot get past `{token}`. The mistake itself is usually just before it — a ' +
    'missing comma, a typo in a keyword, or a bracket that was never closed.',
  'hint.syntax.end': 'The statement stops in the middle — something is missing after the last word.',
  'hint.syntax.other': 'This statement is not put together the way SQL expects.',

  'hint.groupby':
    'As soon as an aggregate like `count(...)`, `sum(...)` or `avg(...)` appears in the ' +
    'SELECT, every other column in the SELECT has to appear in the GROUP BY as well — ' +
    'otherwise Postgres does not know which of the combined values to show.',

  'hint.function.unknown':
    'There is no function `{name}` — or not one that takes these data types.',
  'hint.operator.unknown':
    'There is no operation `{operator}`: the two sides have different data types. To join ' +
    'text together the operator is `||`, by the way, not `+`.',

  'hint.type.boolean_condition':
    'A {clause} condition has to come out true or false. A value of type `{type}` does not — ' +
    "the comparison is missing, so `WHERE name = 'Muster'` rather than `WHERE name`.",
  'hint.type.other': 'The data type here does not match what is expected in this position.',

  'hint.orderby.position':
    'The number after ORDER BY means the nth column of the SELECT list — and the list does ' +
    'not have that many columns. Writing the column name instead of the position is safer.',

  'hint.unique.key':
    'The value `{value}` for `{column}` is already taken. That column has to be different in ' +
    'every row.',
  'hint.unique.other': 'This value is already in the table, and the column has to be unique.',

  'hint.fk.missing':
    'There is no row in `{table}` with `{column}` = `{value}`. A foreign key may only point ' +
    'at a row that really exists — create it first.',
  'hint.fk.referenced_by_named':
    'This row cannot go while another table still points at it — `{table}` does. Delete ' +
    'there first.',
  'hint.fk.referenced_by':
    'This row cannot go while another table still points at it. Delete there first.',
  'hint.fk.other': 'A foreign key points at a row that does not exist (any more).',

  'hint.check.violated':
    'The row breaks the rule `{constraint}` on the table `{table}`. CHECK rules like that ' +
    'are part of the table definition and apply to every row.',

  'hint.input.invalid':
    '`{value}` is not a valid value of type `{type}`. Text belongs in single quotes and ' +
    'numbers do not — and text does not belong in a number column at all.',

  'hint.divzero':
    'You cannot divide by zero. If the divisor can be zero, `NULLIF(column, 0)` helps: it ' +
    'gives an empty value instead of an error.',
  'hint.overflow': 'The value is too large (or too small) for the column’s data type.',

  'hint.date.invalid_named':
    '`{value}` is not a valid date. Postgres expects year-month-day, so `2025-04-03` for the ' +
    '3rd of April 2025.',
  'hint.date.invalid':
    'That is not a valid date. Postgres expects year-month-day, so `2025-04-03` for the 3rd ' +
    'of April 2025.',

  'hint.depends.named':
    'Other objects are built on `{table}`: {names}. The table cannot be dropped while they ' +
    'exist — remove those first.',
  'hint.depends':
    'Other objects are built on `{table}`, usually a view. The table cannot be dropped while ' +
    'they exist.',

  'hint.denied':
    'You do not have the rights for that. You may do anything in your own schema and read ' +
    'the `demo` tables — other schemas are closed to you.',
  'hint.aborted':
    'An earlier statement in this script failed. Everything after it is skipped until the ' +
    'transaction ends — fix the first failing statement and run the script again.',

  // --- shared ---------------------------------------------------------------

  'common.loading': 'loading …',
  'common.cancel': 'Cancel',
  'nav.overview': 'Overview',

  // --- API error codes ------------------------------------------------------

  'error.offline': 'No connection to the server.',
  'error.unknown': 'Something went wrong.',
  'error.unauthenticated': 'You are not logged in any more.',
  'error.forbidden': 'You do not have the rights for that.',
  'error.not_found': 'Not found.',
  'error.bad_request': 'There was something wrong with the request.',
  'error.internal': 'Something went wrong on our side.',
  'error.invalid_locale': 'There is no such language.',
  'error.invalid_name': 'That name will not work.',
  'error.invalid_code': 'That class code will not work — two to twelve lower-case letters or digits.',
  'error.empty_batch': 'Nobody was entered.',
  'error.invalid_table_name': 'That table name will not work.',
  'error.duplicate_column_name': 'Two columns have the same name.',
  'error.column_count_mismatch': 'Not every row has the same number of fields.',
  'error.empty_csv': 'There is no data in the file.',
  'error.csv_too_many_rows': 'The file has too many rows to import.',
  'error.csv_too_many_columns': 'The file has too many columns to import.',
  'error.quota_exceeded':
    'Your storage is full. Drop tables you do not need any more, then try again.',
  'error.table_exists':
    'A table with that name already exists. Pick another name — or tick ' +
    '“Replace an existing table”.',
  'error.password_too_short': 'That password is too short.',
  'error.password_unchanged': 'The new password is the same as the old one.',
  'error.class_archived': 'That class is archived.',
  'error.code_taken': 'That class code is already taken.',
  'error.last_class': 'That is this person’s only class, so it cannot go as well.',
  'error.user_not_active': 'That account is not active.',
  'error.cold_students_only': 'Only student accounts can go into cold storage.',
  'error.restore_first': 'That account has to be restored first.',
  'error.wrong_password': 'That password is not right.',
  'error.not_provisioned':
    'This account has no database set up yet. Try again in a moment.',
  // See the German entry: the usual cause is deliberately not stated as a known
  // one.
  'error.too_many_queries':
    'All of your connections are busy right now. Usually that means a query of your own is ' +
    'still running — wait a moment or cancel it. If that does not help, tell your teacher.',
  'error.not_implemented': 'That does not exist yet.',
  'error.class_not_found': 'There is no such class.',
  'error.teacher_not_found': 'There is no such teacher.',
  'error.user_not_found': 'There is no such account.',
  'error.member_not_found': 'That person is not in that class.',

  // --- the SQL page ---------------------------------------------------------

  'sql.title': 'SQL — Datebänkli',
  'sql.import': 'Import CSV',
  'sql.reset': 'Reset database',
  'sql.tables': 'Tables',
  'sql.run': 'Run',
  'sql.run_key': 'Run ({key})',
  'sql.ctrl': 'Ctrl+↵',
  'sql.result': 'Result',
  'sql.running': 'running …',
  'sql.row': 'row',
  'sql.rows': 'rows',
  'sql.detail': 'Detail',
  'sql.hint': 'Hint',
  'sql.place': 'Position',
  'sql.position': 'Line {line}, character {column}',
  'sql.error_status': 'Error {code} · {ms} ms',
  'sql.busy': 'Wait for the running query, or cancel it first.',
  'sql.foreign_loaded': 'Query loaded — press Run to execute it.',
  'sql.refused': 'The request was refused.',
  'sql.cancel_failed': 'Cancelling did not work.',
  'sql.already_done': 'The query had already finished.',
  'sql.cancelled_user': 'Cancelled.',
  'sql.cancelled_timeout': 'Ran too long and was stopped automatically.',
  'sql.tables_failed': 'Could not load the tables.',
  'sql.table_title': 'Click for SELECT * … LIMIT 50',
  'sql.no_columns': 'no columns',
  'sql.no_tables': 'No tables yet. Create one with CREATE TABLE.',
  'sql.no_tables_readonly': 'No tables.',
  'sql.quota': '{used} of {total} used',
  'sql.quota_full':
    '{used} of {total} used — full. Delete some tables or rows, or anything that writes ' +
    'will be refused.',
  'sql.truncated': 'Showing the first {shown} of {total}.',
  'sql.rollback':
    'A script runs as one single transaction: if one statement fails, the statements before ' +
    'it are rolled back too.',
  'sql.reset_confirm':
    'All of your tables and all the data in them will be deleted. This cannot be undone.' +
    '\n\nReally reset?',
  'sql.resetting': 'resetting …',
  'sql.reset_done': 'Database reset.',
  'sql.reset_failed': 'The reset did not work.',
  'sql.reset_unknown':
    'No answer from the server. Reload the page to see whether the reset went through.',

  // --- the CSV import dialog ------------------------------------------------

  'import.title': 'Import CSV',
  'import.file': 'File',
  'import.table': 'Table name',
  'import.delimiter': 'Separator',
  'import.semicolon': 'Semicolon ;',
  'import.comma': 'Comma ,',
  'import.tab': 'Tab',
  'import.pipe': 'Pipe |',
  'import.first_row': 'First row holds the column names',
  'import.replace': 'Replace an existing table',
  'import.columns': 'Columns',
  'import.in_file': 'in the file',
  'import.column_name': 'Column name',
  'import.type': 'Data type',
  'import.preview': 'Preview',
  'import.go': 'Import',
  'import.summary': '{rows} · {columns} columns',
  'import.preview_first': 'Preview of the first {rows} rows.',
  'import.no_rows': 'No data rows found.',
  'import.too_many_rows': 'The file has too many rows to import.',
  'import.too_many_columns': 'The file has too many columns to import.',
  'import.refused': 'The server refused the request.',
  'import.too_large': 'The file is {size} MB; the limit is 10 MB.',
  'import.reading': 'reading …',
  'import.importing': 'importing …',
  'import.not_run': 'The import was not carried out.',
  'import.pick_file': 'Choose a CSV file.',
  'import.bad_values': 'These values do not fit the data type you chose:',
  'import.bad_value': 'Row {line}, column',
  'import.not_of_type': 'is not a value of type',
  'import.choose_text': 'Choose the type text for that column, or fix the file.',

  'type.text': 'Text',
  'type.integer': 'Whole number',
  'type.bigint': 'Large whole number',
  'type.numeric': 'Decimal number',
  'type.boolean': 'Yes/No',
  'type.date': 'Date',
  'type.timestamp': 'Date + time',

  // --- the forced / voluntary password change -------------------------------

  'password.title': 'Change password — Datebänkli',
  'password.heading': 'Change password',
  'password.rule': 'At least 10 characters.',
  'password.forced':
    'This account needs a new password before it can be used. At least 10 characters.',
  'password.current': 'Current password',
  'password.next': 'New password',
  'password.repeat': 'Repeat the new password',
  'password.save': 'Save',
  'password.mismatch': 'The two new passwords are not the same.',
  'password.failed': 'The change did not work.',

  // --- shared by the staff pages --------------------------------------------
  //
  // These are read by a teacher rather than a student, which changes the
  // register a little — but not the rule: short, plain, and the same word for
  // the same thing every time it appears.

  'common.create': 'Create',
  'common.close': 'Close',
  'common.save': 'Save',
  'common.delete': 'Delete',
  'common.edit': 'Edit',
  'common.name': 'Name',
  'common.username': 'Username',
  'common.state': 'Status',
  'common.active': 'active',
  'common.archived': 'archived',
  'common.cold': 'in storage',
  'common.first_name': 'First name',
  'common.last_name': 'Surname',
  'common.teacher': 'Teacher',
  'common.students': 'Students',
  'common.class_code': 'Class code',
  'common.school_year': 'School year',
  'common.no_classes': 'No classes yet.',
  'common.class_empty': 'Nobody is in this class yet.',
  'common.failed': 'That did not work ({status}).',
  'common.role_admin': 'Administration',
  'common.role_teacher': 'Teacher',
  'common.role_student': 'Student',

  'nav.sql': 'SQL editor',
  'nav.lesson': 'Lesson',
  'nav.roster': 'Classes',
  'nav.exercises': 'Exercises',
  'nav.theme_dark': 'Switch to dark theme',
  'nav.theme_light': 'Switch to light theme',

  'footer.contact': 'Questions or problems:',

  // --- the overview page ----------------------------------------------------

  'home.teachers': 'Teachers',
  'home.classes': 'Classes',
  'home.col_code': 'Code',
  'home.nothing': 'Nothing to see yet.',
  'home.password': 'Change password',
  'home.logout': 'Log out',

  // --- the roster page ------------------------------------------------------

  'roster.title': 'Classes — Datebänkli',
  'roster.heading': 'Classes & students',
  'roster.teachers': 'Teachers',
  'roster.teacher_new': 'New teacher',
  // The `_1` / `_2` pairs wrap a <code> or <strong> that `apply()` would
  // otherwise overwrite; see the German file. Keep the marked-up word in the
  // same position, or the sentence comes apart.
  'roster.teacher_hint_1':
    'A username is never handed out twice: a second “Philip Schaffner” is ',
  'roster.teacher_hint_2': ' for ever. Look at the list above first.',
  'roster.classes': 'Classes',
  'roster.class_new': 'New class',
  'roster.class_hint_1': 'The class code is part of every student’s username (',
  'roster.class_hint_2': ') and cannot be changed afterwards.',
  'roster.add_students': 'Add students',
  'roster.paste_hint_1': 'One person per line. ',
  'roster.paste_hint_code': 'Surname, First name',
  'roster.paste_hint_2': ' and columns copied out of Excel are recognised too. With ',
  'roster.paste_hint_strong': 'two first names',
  'roster.paste_hint_3':
    ' the comma is needed — without it the second first name is counted as part of the ' +
    'surname, and the username stays that way for ever.',
  // The same three names as in German, and for the same reason: they show the
  // shapes the parser handles, not the language.
  'roster.paste_placeholder': 'Muster Lena\nVon Gunten Anna\nMaradona, Diego Armando',
  'roster.order': 'Order',
  'roster.order_last_first': 'Surname First name',
  'roster.order_first_last': 'First name Surname',
  'roster.note':
    'A credential slip exists exactly once — at the moment the account is created. Passwords ' +
    'cannot be looked up, only issued again. So print first, then close. If you lose the view ' +
    'anyway, “New slips” in the class list issues fresh ones for everybody who has never ' +
    'signed in — for them, no slip you handed out can be invalidated.',

  'roster.slips_title': 'Credential slips',
  'roster.slips_last_chance':
    'This is the last time you will see these passwords. Print them or write them down now — ' +
    'after this they can only be issued again.',
  'roster.print': 'Print',
  'roster.slips_done': 'The slips are printed — close',
  'roster.slips_no_schema':
    '{count} account(s) have no schema yet: {names}. They can sign in, but they cannot make ' +
    'tables of their own — the next server start will catch that up.',
  'roster.slip_access': 'Datebänkli · Access',
  'roster.slip_address': 'Address',
  'roster.slip_password': 'Password',
  'roster.slip_foot':
    'Please keep this. The password cannot be looked up, only issued again.',

  'roster.col_access': 'Access',
  'roster.col_first_login': 'First sign-in',
  'roster.no_teachers': 'No teachers yet.',
  'roster.reslip': 'New slip',
  'roster.reslip_teacher_confirm':
    'Issue a new password? The old slip stops working, and any open sessions end.',
  'roster.slips_reslip': 'New credential slip',
  'roster.name_required': 'A first name and a surname are both needed.',
  'roster.slips_new_teacher': 'Credential slip — new teacher',

  'roster.open': 'Open',
  'roster.class_required': 'A class code and a name are both needed.',
  'roster.class': 'Class',

  'roster.never': 'never',
  'roster.archive': 'Archive',
  'roster.activate': 'Activate',
  'roster.remove': 'Remove from class',
  'roster.reissue_one': 'New slip for the one student who has never signed in',
  'roster.reissue_many': 'New slips for the {count} students who have never signed in',
  'roster.reissue_note': ' — for anyone else this would invalidate a slip already in use.',
  'roster.reissue_confirm':
    'Issue new slips for {count} students? Only accounts that have never signed in are ' +
    'affected.',
  'roster.reissue_aborted':
    'Stopped at {failure}\n\nThe slips issued so far are shown anyway — those passwords are ' +
    'the live ones now.',
  'roster.slips_reissued': 'New credential slips',
  'roster.reslip_student_confirm':
    'A new password for {name}? The old slip stops working.',
  'roster.slips_reslip_student': 'New credential slip — {name}',
  'roster.remove_confirm':
    'Take {name} out of this class? The account and their own tables stay; the teacher just ' +
    'loses sight of them.',

  // --- cold storage and deletion (phase 7.3) ----------------------------------
  // See the German entries: the two are worded at deliberately different
  // weights, because cold comes back and deletion does not.
  'roster.cold': 'Move to storage',
  'roster.cold_confirm':
    "Move {name}'s tables to storage? They are saved to the server and taken out of the " +
    'database — "Activate" brings them back. Meant for disk space, not for tidying up.',
  'roster.cold_incomplete':
    '{name} is now marked as stored, but the backup failed:\n\n{error}\n\nThe tables are ' +
    'still there. The server will try again on its next start.',

  'roster.delete': 'Delete',
  'roster.delete_confirm':
    'Delete {name} for good?\n\nThis is not the same as "Remove from class" — the whole ' +
    'account goes.',
  'roster.delete_confirm_final':
    'To be clear: {name} ({username})\n\nTheir schema and every table in it will be ' +
    'dropped. A backup stays on the server, but this application cannot restore the ' +
    'account — only stored accounts can be brought back.\n\nDelete?',
  'roster.delete_incomplete':
    '{name} is recorded as deleted, but the backup failed:\n\n{error}\n\nSo the tables are ' +
    'still there — nothing is dropped until the backup is written. The server will try ' +
    'again on its next start.',

  'roster.missing': 'missing',
  'roster.already_in_class': 'already in the class',
  'roster.preview_missing':
    '{count} line(s) with no first name — please fill them in, or the name will sit in the ' +
    'username wrongly for ever.',
  'roster.preview_ok':
    '{count} people. Please check how the names were split: usernames are never changed.',
  'roster.no_first_name': 'At least one line has no first name.',
  'roster.create_confirm':
    'Create {count} students? The credential slips appear exactly once afterwards.',
  'roster.slips_for': 'Credential slips — {class}',
  'roster.close_confirm': 'The passwords cannot be seen again after this. Really close?',

  // --- the lesson page ------------------------------------------------------

  'lesson.title': 'Lesson — Datebänkli',
  'lesson.heading': 'Lesson',
  'lesson.window_30': 'last 30 min',
  'lesson.window_90': 'last 90 min',
  'lesson.window_240': 'last 4 hours',
  'lesson.refresh': 'Refresh now',
  'lesson.note_1':
    '“Signed in” means there is a valid session — not necessarily somebody at the desk. ' +
    'Anyone over the storage limit is refused every statement that writes; those attempts ' +
    'deliberately do ',
  'lesson.note_em': 'not',
  'lesson.note_2': ' appear in the list of statements, which is why the limit is beside it.',

  'lesson.just_now': 'just now',
  'lesson.ago_seconds': '{n} s ago',
  'lesson.ago_minutes': '{n} min ago',
  'lesson.ago_hours': '{n} h ago',
  'lesson.over_quota': 'over the limit',
  'lesson.over_quota_detail': 'over the limit — anything that writes is refused',
  'lesson.nothing_run': 'nothing run yet',
  'lesson.signed_in': 'signed in',
  'lesson.col_student': 'Student',
  'lesson.col_session': 'Session',
  'lesson.col_last': 'Last statement',
  'lesson.col_errors': 'Errors',
  'lesson.col_storage': 'Storage',
  'lesson.statements': 'Statements',
  'lesson.no_statements': 'No statements yet.',
  'lesson.no_schema': 'Nothing to show — this account has no database role of its own.',
  'lesson.schema_empty': 'The schema is empty.',
  'lesson.not_counted': 'not counted yet',
  'lesson.sub': '{count} on the roster · counting from {time}',

  'sql.imported': '{table} · {rows} imported.',
  'sql.statement': '1 statement',
  'sql.statements': '{n} statements',
  'sql.nothing': 'Nothing to run.',
  'sql.changed': '{rows} changed',

  // --- exercises (phase 9) ---------------------------------------------------
  'ex.title': 'Exercises — Datebänkli',
  'ex.heading': 'Exercises',
  'ex.eyebrow': 'Exercise',
  'ex.mine_sub': 'Exercises your teacher has handed out.',
  'ex.none_yet': 'No exercise has been given to you yet.',
  'ex.by': 'by {name}',
  'ex.opened': 'opened',
  'ex.not_opened': 'not opened yet',
  'ex.work_on': 'Work on it',
  'ex.no_handins': 'Nothing handed in yet.',
  'ex.handin_count': '{count} hand-in(s), last {when}',
  'ex.my_handins': 'My hand-ins',
  'ex.attempt': 'Hand-in {n}',
  'ex.download': 'Download',
  'ex.schema_label': 'Exercise: {title}',

  'ex.yours': 'Your exercises',
  'ex.new': 'New',
  'ex.untitled': 'New exercise',
  'ex.none_authored': 'No exercises yet.',
  'ex.pick': 'Pick an exercise on the left, or make a new one.',
  'ex.task': 'Task (Markdown)',
  'ex.preview': 'Preview',
  'ex.saved': 'Saved.',
  'ex.tables': 'The exercise’s tables',
  'ex.no_tables': 'No tables yet. Every student gets their own copy of these.',
  'ex.add_csv': 'Add CSV',
  'ex.add_sql': 'Add SQL script',
  'ex.csv_summary': '{rows} rows, {columns} columns',
  'ex.sql_summary': 'Script',
  'ex.move_up': 'Move up',
  'ex.sql_title': 'SQL script',
  'ex.sql_label': 'Label',
  'ex.sql_body': 'Script',
  'ex.sql_hint':
    'Runs in each student’s exercise schema. Write table names without a schema.',
  'ex.drop_source_confirm': 'Remove “{label}” from this exercise?',

  'ex.distribution': 'Distribution',
  'ex.not_distributed': 'Not handed to any class yet.',
  'ex.class': 'Class',
  'ex.opened_by': 'opened by',
  'ex.handins': 'hand-ins',
  'ex.distribute': 'Hand out',
  'ex.view_handins': 'View hand-ins',
  'ex.download_all': 'Download all',
  'ex.take_back': 'Take back',
  'ex.take_back_confirm': 'Take this exercise back from {klass}?',
  'ex.take_back_confirm_final':
    'Final: {klass} loses {workspaces} exercise database(s) and {handins} hand-in(s). This cannot be undone.',
  'ex.take_back_partial': '{count} exercise database(s) could not be dropped. Please report this.',
  'ex.delete_confirm': 'Delete the exercise “{title}”?',
  'ex.delete_confirm_final':
    'Final: “{title}” is deleted, along with every exercise database and every hand-in, in every class.',
  'ex.no_handins_yet': 'Nothing has been handed in from this class yet.',

  'ex.try_it': 'Try it yourself',
  'ex.try_it_why':
    'Builds the tables in a schema of your own, so you can test the script before the lesson.',
  'ex.build_mine': 'Build the tables',
  'ex.open_editor': 'Open in the editor',
  'ex.building': 'building …',
  'ex.built': 'Built in {schema}.',
  'ex.already_built': 'Already there ({schema}).',
  'ex.build_failed': 'Failed on “{label}”: {message}',

  'ex.show_task': 'Task',
  'ex.reset_tables': 'Reset the tables',
  'ex.hand_in': 'Hand in',
  'ex.leave': 'My own database',
  'ex.opening': 'opening …',
  'ex.open_failed': 'The exercise could not be opened.',
  'ex.broken_fixture':
    'The exercise’s table “{label}” could not be built ({message}). Please tell your teacher.',
  'ex.reset_confirm':
    'Reset the tables of “{title}” to how they started? Your changes in them are lost. Your own database is not touched.',
  'ex.resetting': 'resetting …',
  'ex.reset_done': 'Tables reset.',
  'ex.reset_failed': 'The reset failed.',
  'ex.reset_unknown': 'It is unclear whether the reset worked. Reload the page.',
  'ex.hand_in_title': 'Hand in your solution',
  'ex.hand_in_what': 'What is in the editor right now is what gets handed in. You may hand in more than once.',
  'ex.note': 'A note for your teacher (optional)',
  'ex.hand_in_empty': 'The editor is empty.',
  'ex.hand_in_failed': 'Handing in failed.',
  'ex.handed_in': 'Hand-in {n} saved.',

  'error.exercise_not_found': 'That exercise does not exist (any more).',
  'error.exercise_not_open': 'Open the exercise first.',
  'error.not_your_exercise': 'That exercise belongs to another teacher.',
  'error.source_not_found': 'That table is not part of this exercise.',
  'error.submission_not_found': 'No such hand-in.',
  'error.too_many_sources': 'An exercise may hold at most 20 tables or scripts.',
  'error.csv_types_rejected':
    'Some values do not fit the chosen data types. Fix the types or the file.',
};
