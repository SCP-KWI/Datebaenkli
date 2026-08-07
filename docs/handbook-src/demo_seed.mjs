/**
 * Demo data for the handbook screenshots.
 *
 * Drives the app over its own HTTP API — the same calls the roster page makes —
 * so nothing here can drift out of step with a route. It writes into whatever
 * instance `APP_URL` points at, which `refresh.sh` sets up as a throwaway
 * cluster; do not aim it at anything real.
 *
 * Output: `shots/demo.json`, holding the teacher's login and every student's
 * slip password, because `shots.mjs` has to log in as four of them.
 */
import { writeFileSync } from "node:fs";

const BASE = process.env.APP_URL || "http://localhost:3222";
const ADMIN_PW = process.env.DBK_BOOTSTRAP_ADMIN_PASSWORD || "handbuch-admin-2026";
const ADMIN_PW2 = "handbuch-admin-2026-neu";
const TEACHER_PW = "handbuch-lehrperson-2026";

// --- a cookie jar per identity ----------------------------------------------
class Session {
  constructor() {
    this.cookie = "";
  }
  async call(path, body, method = "POST") {
    const response = await fetch(`${BASE}${path}`, {
      method: body === undefined && method === "POST" ? "GET" : method,
      headers: {
        "content-type": "application/json",
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const set = response.headers.getSetCookie?.() ?? [];
    for (const c of set) this.cookie = c.split(";")[0];
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`${method} ${path} → ${response.status} ${JSON.stringify(payload)}`);
    }
    return payload;
  }
  get(path) {
    return this.call(path, undefined, "GET");
  }
  post(path, body = {}) {
    return this.call(path, body, "POST");
  }
  patch(path, body) {
    return this.call(path, body, "PATCH");
  }
  async login(username, password) {
    await this.post("/api/login", { username, password });
    return this;
  }
}

// --- the class ---------------------------------------------------------------
const CLASS = { code: "i3a", name: "Informatik 3a", schoolYear: "2026/27" };

const STUDENTS = [
  { firstName: "Nino", lastName: "Bühler" },
  { firstName: "Timo", lastName: "Hafner" },
  { firstName: "Deniz", lastName: "Öztürk" },
  { firstName: "Jael", lastName: "Rüegg" },
  { firstName: "Luca", lastName: "Steiner" },
  { firstName: "Anna", lastName: "Von Gunten" },
  { firstName: "Alina", lastName: "Zimmermann" },
];

/**
 * What each student did in the lesson. The point of the list is the *shape* of
 * a lesson, not the SQL: two people working, one who mistyped a table name, one
 * who tried the demo data as if it were hers, and one cartesian join.
 * `expectFail: true` only documents intent — every statement is sent as written
 * and whatever Postgres answers is what the lesson view shows.
 */
const WORK = {
  u_i3a_buehler_nino: [
    `CREATE TABLE pausenkiosk (
  id        serial PRIMARY KEY,
  ware      text NOT NULL,
  preis     numeric(5,2) NOT NULL,
  bestand   int NOT NULL DEFAULT 0
);`,
    `INSERT INTO pausenkiosk (ware, preis, bestand) VALUES
  ('Gipfeli', 1.80, 40),
  ('Schoggibrötli', 2.20, 25),
  ('Eistee', 2.50, 60),
  ('Apfel', 0.90, 12),
  ('Energydrink', 3.50, 0);`,
    `SELECT ware, preis FROM pausenkiosk WHERE bestand > 0 ORDER BY preis DESC;`,
    // The classic: the table is called pausenkiosk, not kiosk. 42P01, and the
    // hint layer names the near miss.
    `SELECT * FROM kiosk;`,
    `SELECT ware, preis * bestand AS lagerwert FROM pausenkiosk ORDER BY lagerwert DESC;`,
  ],
  u_i3a_rueegg_jael: [
    `CREATE TABLE spotify_wrapped (
  id       serial PRIMARY KEY,
  song     text NOT NULL,
  artist   text NOT NULL,
  minuten  int  NOT NULL
);`,
    `INSERT INTO spotify_wrapped (song, artist, minuten) VALUES
  ('Bitzli', 'Nemo', 412),
  ('Us de Färi', 'Patent Ochsner', 208),
  ('Chind vo de Sunne', 'Sina', 96),
  ('Bern', 'Züri West', 350);`,
    // 42803: the column is not in the GROUP BY. One of the two most useful
    // hints in the whole layer.
    `SELECT artist, song, sum(minuten) FROM spotify_wrapped GROUP BY artist;`,
    `SELECT artist, sum(minuten) AS total FROM spotify_wrapped GROUP BY artist ORDER BY total DESC;`,
  ],
  u_i3a_oeztuerk_deniz: [
    `SELECT name, einwohner FROM demo.kantone ORDER BY einwohner DESC LIMIT 5;`,
    // 42501: demo is read-only, granted to PUBLIC. This is the lesson about
    // privileges, delivered by Postgres rather than by the teacher.
    `DELETE FROM demo.noten WHERE note < 4;`,
    `SELECT k.name, count(*) AS gemeinden
FROM demo.kantone k
JOIN demo.gemeinden g ON g.kanton_id = k.id
GROUP BY k.name
ORDER BY gemeinden DESC;`,
  ],
  u_i3a_zimmermann_alina: [
    // 42501 again, from the other direction: a peer's schema is visible in the
    // catalog but not readable. Exactly the thing §3's "honest caveats" mean.
    `SELECT * FROM u_i3a_buehler_nino.pausenkiosk;`,
    `SELECT vorname, nachname, klasse FROM demo.schuelerinnen ORDER BY nachname;`,
    // The cartesian join. Three tables, no ON clause, and the watchdog is what
    // ends it.
    `SELECT count(*) FROM demo.gemeinden, demo.noten, demo.bestellpositionen;`,
  ],
  u_i3a_hafner_timo: [
    `SELECT * FROM demo.artikel ORDER BY preis DESC LIMIT 10;`,
    // 42601: a syntax error with a position marker, which is the thing
    // beginners actually need pointed at.
    `SELECT * FROM demo.artikel WEHRE preis > 10;`,
  ],
};

/** The teacher's own playground — what §2 calls the teacher schema. */
const TEACHER_WORK = [
  `SELECT kuerzel, name, einwohner
FROM demo.kantone
ORDER BY einwohner DESC
LIMIT 8;`,
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- run ---------------------------------------------------------------------
const admin = new Session();
await admin.login("admin", ADMIN_PW);
await admin
  .post("/api/me/password", { currentPassword: ADMIN_PW, newPassword: ADMIN_PW2 })
  .catch(() => {});
await admin.login("admin", ADMIN_PW2);

const teacherCreated = await admin.post("/api/teachers", {
  firstName: "Marta",
  lastName: "Brunner",
});
const teacherName = teacherCreated.user.username;
console.log("teacher", teacherName, teacherCreated.password);

const teacher = new Session();
await teacher.login(teacherName, teacherCreated.password);
await teacher.post("/api/me/password", {
  currentPassword: teacherCreated.password,
  newPassword: TEACHER_PW,
});
await teacher.login(teacherName, TEACHER_PW);

const klass = (await teacher.post("/api/classes", CLASS)).class;
console.log("class", klass.code, klass.id);

const created = (
  await teacher.post(`/api/classes/${klass.id}/students`, { students: STUDENTS })
).students;
const slips = Object.fromEntries(created.map((c) => [c.user.username, c.password]));
for (const c of created) console.log("  ", c.user.username, c.password);

// The teacher's own schema only exists once they have used it, so touch it
// before the screenshots want a tree in the left pane.
for (const sql of TEACHER_WORK) await teacher.post("/api/query", { sql });

// Students run their lesson. Sequential on purpose: query_log is ordered by
// time and the lesson view's "last statement" column should read like a lesson
// rather than like a thundering herd.
for (const [username, script] of Object.entries(WORK)) {
  const password = slips[username];
  if (!password) {
    console.log("!! no slip for", username);
    continue;
  }
  const student = new Session();
  await student.login(username, password);
  for (const sql of script) {
    const started = Date.now();
    // The cartesian join is meant to be cancelled, not waited out: fire it and
    // ask the app to stop it, which is the same path the Cancel button uses.
    const isBomb = /count\(\*\) FROM demo\.gemeinden, demo\.noten/.test(sql);
    const run = student.post("/api/query", { sql }).catch((e) => ({ error: String(e) }));
    if (isBomb) {
      await sleep(1200);
      await student.post("/api/query/cancel", {}).catch(() => {});
    }
    const out = await run;
    const ms = Date.now() - started;
    const first = sql.split("\n")[0].slice(0, 46);
    console.log(`   ${username}  ${ms}ms  ${first}`);
    void out;
    await sleep(120);
  }
}

writeFileSync(
  new URL("./shots/demo.json", import.meta.url).pathname,
  JSON.stringify(
    { base: BASE, teacher: { username: teacherName, password: TEACHER_PW }, classId: klass.id, slips },
    null,
    2
  )
);
console.log("seeded.");
