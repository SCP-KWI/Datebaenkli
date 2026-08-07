// Drives the running app, writes handbook screenshots to ./shots and the
// bounding boxes of the annotated elements to ./shots/rects.json.
//
// The arrows are NOT placed by hand: every `shot(...)` call names the elements
// it wants numbered, this reads their bounding box out of the DOM, and
// build.mjs draws the overlay from that. A layout change in the app moves the
// arrows with it — as long as the selectors still hit. A miss prints `!! missing`.
import puppeteer from "puppeteer-core";
import { readFileSync, writeFileSync } from "node:fs";

const CHROME = process.env.CHROME_PATH || "/usr/bin/chromium";
const HERE = new URL("./", import.meta.url).pathname;
const OUT = `${HERE}shots/`;
const demo = JSON.parse(readFileSync(`${OUT}demo.json`, "utf8"));
const BASE = process.env.APP_URL || demo.base;

// Desktop-first on purpose: this is a laptop tool. The layout collapses under
// ~820 px and the page is capped at 1180, so anything narrower than ~1250 would
// screenshot a fold nobody sees while working.
const DESKTOP = { width: 1280, height: 880, deviceScaleFactor: 2 };
// The lesson view is the one screen a teacher uses while walking around the
// room, so it gets a touch viewport rather than the desktop one. iPad portrait
// and not a phone, deliberately: at 390 px the six-column table is wider than
// the screen and the page scrolls sideways, which is true of the app but would
// make a figure that misrepresents it in both possible crops.
const TABLET = {
  width: 820,
  height: 1180,
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const meta = {};

/**
 * Say yes to every `confirm()`.
 *
 * Not cosmetic: creating students goes through one, and Puppeteer dismisses an
 * unhandled dialog — so without this the run stalls on a click that silently
 * did nothing, which is exactly how it failed the first time.
 */
const acceptDialogs = (page) => page.on("dialog", (d) => void d.accept());

async function clickText(page, selector, text) {
  const ok = await page.evaluate(
    (sel, txt) => {
      const el = [...document.querySelectorAll(sel)].find((e) =>
        e.textContent.trim().includes(txt)
      );
      if (!el) return false;
      el.click();
      return true;
    },
    selector,
    text
  );
  if (!ok) throw new Error(`no ${selector} matching "${text}"`);
  await sleep(500);
}

// specs: [{ n, sel, nth?, text?, side, dy? }] — sel resolved in the page,
// optionally filtered by contained text or index.
async function shot(page, name, device, specs = []) {
  // A full-page shot of a page with `position: sticky` chrome paints that
  // chrome wherever the viewport happens to be, i.e. across the middle of the
  // image. Pin it and go back to the top first.
  await page.addStyleTag({
    content: ".topbar{position:static !important}",
  }).catch(() => {});
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(350);
  await page.screenshot({ path: `${OUT}${name}.png`, fullPage: true });
  const info = await page.evaluate((sp) => {
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return {
        x: r.left + window.scrollX,
        y: r.top + window.scrollY,
        w: r.width,
        h: r.height,
      };
    };
    const out = [];
    for (const s of sp) {
      let els = [...document.querySelectorAll(s.sel)];
      if (s.text) els = els.filter((e) => e.textContent.includes(s.text));
      const el = els[s.nth ?? 0];
      if (!el) {
        out.push({ n: s.n, missing: s.sel });
        continue;
      }
      out.push({ n: s.n, side: s.side, dy: s.dy ?? 0, ...box(el) });
    }
    return {
      pageW: document.documentElement.scrollWidth,
      pageH: document.documentElement.scrollHeight,
      marks: out,
    };
  }, specs);
  meta[name] = { device, ...info };
  const missing = info.marks.filter((m) => m.missing);
  if (missing.length) console.log("  !! missing:", missing);
  console.log("wrote", name, `${info.pageW}x${info.pageH}`);
}

/** Type into CodeMirror, then close whatever autocomplete popped up. */
async function typeSql(page, sql) {
  await page.click("#editor .cm-content");
  await page.evaluate(() => {
    document.execCommand("selectAll", false, null);
  });
  await page.keyboard.press("Backspace");
  await page.keyboard.type(sql, { delay: 4 });
  await page.keyboard.press("Escape");
  await sleep(200);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--font-render-hinting=none", "--force-color-profile=srgb"],
});

// ---------- desktop ----------
{
  const page = await browser.newPage();
  acceptDialogs(page);
  await page.setViewport(DESKTOP);

  // --- 01 login -------------------------------------------------------------
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#username");
  await page.type("#username", demo.teacher.username, { delay: 8 });
  await page.type("#password", demo.teacher.password, { delay: 8 });
  await shot(page, "01-login", "desktop", [
    { n: 1, sel: "#username", side: "l" },
    { n: 2, sel: "#password", side: "l" },
    { n: 3, sel: 'button[type="submit"]', side: "r" },
  ]);

  await page.click('button[type="submit"]');
  await page.waitForSelector("#content table, #content p", { timeout: 15000 });
  await sleep(700);

  // --- 02 home --------------------------------------------------------------
  // The six controls in the bar all sit on one line, so they get one mark
  // between them: a badge per button would stack six circles on the same y.
  await shot(page, "02-uebersicht", "desktop", [
    { n: 1, sel: ".topbar-actions", side: "r" },
    { n: 2, sel: "#content table", side: "l" },
  ]);

  // --- 03 a new class -------------------------------------------------------
  await page.goto(`${BASE}/roster`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#classes table");
  await sleep(500);
  await page.evaluate(() => {
    document.querySelectorAll("#classes ~ details, section details").forEach((d) => {
      if (d.querySelector("#c-code")) d.open = true;
    });
  });
  await page.type("#c-code", "i3b", { delay: 10 });
  await page.type("#c-name", "Informatik 3b", { delay: 10 });
  await page.type("#c-year", "2026/27", { delay: 10 });
  await sleep(250);
  await shot(page, "03-klasse-anlegen", "desktop", [
    { n: 1, sel: "#classes table tbody tr", side: "l" },
    { n: 2, sel: "label:has(> #c-code)", side: "l" },
    { n: 3, sel: "label:has(> #c-name)", side: "l" },
    { n: 4, sel: "#c-year", side: "r" },
    { n: 5, sel: "#c-create", side: "l" },
  ]);

  // --- 04 pasting a name list ----------------------------------------------
  await page.click("#c-create");
  await page.waitForSelector("#roster-section:not([hidden])", { timeout: 10000 });
  await sleep(600);
  await page.evaluate(() => {
    document.getElementById("add-details").open = true;
  });
  await page.click("#paste");
  await page.keyboard.type("Marti Sven\nDa Silva Ricardo\nMeier, Anna Sophie", {
    delay: 6,
  });
  await sleep(500);
  await shot(page, "04-lernende-anlegen", "desktop", [
    { n: 1, sel: "#paste", side: "l" },
    { n: 2, sel: "label:has(> #order)", side: "l" },
    { n: 3, sel: "#preview", side: "l" },
    { n: 4, sel: "#s-create", side: "r" },
  ]);

  // --- 05 the credential slips ---------------------------------------------
  await page.click("#s-create");
  await page.waitForSelector("#slips-view:not([hidden])", { timeout: 20000 });
  await sleep(900);
  await shot(page, "05-zettel", "desktop", [
    { n: 1, sel: "#slips-title", side: "l" },
    { n: 2, sel: "#print", side: "l" },
    { n: 3, sel: "#slips-done", side: "r" },
    { n: 4, sel: ".slip", side: "l" },
    { n: 5, sel: ".slip dd code", nth: 0, side: "l" },
    { n: 6, sel: ".slip dd code", nth: 1, side: "l" },
  ]);

  // --- 06 the roster of the real class --------------------------------------
  await page.click("#slips-done");
  await sleep(400);
  await clickText(page, "#classes tr.row", "Informatik 3a");
  await page.waitForSelector("#roster table", { timeout: 10000 });
  await sleep(600);
  await shot(page, "06-klassenliste", "desktop", [
    { n: 1, sel: "#roster table tbody tr td code", nth: 1, side: "l" },
    { n: 2, sel: "#roster table tbody tr .tag", side: "l" },
    // The whole action cell, not its four buttons: they sit side by side on
    // one line, so an arrow to the leftmost is drawn through the other three.
    { n: 3, sel: "#roster table tbody tr .act", nth: 0, side: "r" },
    { n: 4, sel: "#reissue", side: "l" },
  ]);

  // --- 07 the lesson view ---------------------------------------------------
  await page.goto(`${BASE}/lesson`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#content table", { timeout: 15000 });
  await sleep(900);
  await shot(page, "07-lektion", "desktop", [
    { n: 1, sel: ".controls", side: "l" },
    // The cells rather than what is in them: a table cell here is two or three
    // lines tall, so its vertical centre falls in a gap between them and the
    // arrow runs through white space instead of through a name.
    { n: 2, sel: "#content tbody tr td:nth-child(2)", side: "l" },
    { n: 3, sel: "#content tbody tr:nth-child(2) td.sql", side: "r" },
    // Luca has run nothing and Alina is the busiest — two different rows, so
    // the two numeric columns can be marked without colliding.
    { n: 4, sel: "#content tbody tr:nth-child(5) td.num", nth: 0, side: "r" },
    { n: 5, sel: "#content tbody tr:nth-child(7) td.num", nth: 2, side: "r" },
  ]);

  // --- 08 one student in detail --------------------------------------------
  await clickText(page, "#content tbody tr.row", "Nino Bühler");
  await page.waitForSelector("#detail[open]", { timeout: 10000 });
  await sleep(600);
  await shot(page, "08-lektion-detail", "desktop", [
    { n: 1, sel: "#detail-body .cols > div:first-child li pre", side: "l" },
    { n: 2, sel: "#detail-body .cols > div:first-child li .bad", side: "r" },
    { n: 3, sel: "#detail-body .cols > div:last-child li", side: "r" },
  ]);
  await page.click("#close");
  await sleep(300);

  // --- 09 the CSV import ----------------------------------------------------
  await page.goto(`${BASE}/sql`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#tree:not(.empty)", { timeout: 15000 });
  await sleep(700);
  await page.click("#import");
  await sleep(400);
  const file = await page.$("#importFile");
  await file.uploadFile(`${HERE}kioskumsatz.csv`);
  await page.waitForSelector("#importConfig:not([hidden])", { timeout: 15000 });
  await sleep(700);
  await shot(page, "09-csv", "desktop", [
    { n: 1, sel: "label:has(> #importFile)", side: "l" },
    // The whole options block, not its three controls: they share one line.
    { n: 2, sel: "#importConfig .opts", side: "l" },
    { n: 3, sel: "#importColumns", side: "r" },
    { n: 4, sel: "#importPreview", side: "l" },
    { n: 5, sel: "#importGo", side: "r" },
  ]);

  // --- 10 the editor, with a result -----------------------------------------
  await page.click("#importGo");
  await sleep(2500);
  await page.evaluate(() => document.getElementById("importDialog")?.close());
  await sleep(600);
  await typeSql(
    page,
    "SELECT artikel, sum(menge) AS stueck, sum(umsatz) AS franken\nFROM kioskumsatz\nGROUP BY artikel\nORDER BY franken DESC;"
  );
  await page.click("#run");
  await page.waitForSelector("#results table", { timeout: 20000 });
  await sleep(800);
  await shot(page, "10-editor", "desktop", [
    { n: 1, sel: "#tree .table", nth: 0, side: "l" },
    { n: 2, sel: "#quota", side: "l" },
    // The bar and the toolbar are marked whole: their buttons sit side by
    // side, and an arrow to one of them would be drawn across the others.
    { n: 3, sel: ".topbar-actions", side: "r" },
    { n: 4, sel: "#toolbar", side: "r" },
    { n: 5, sel: "#editor", side: "r" },
    { n: 6, sel: "#results table", side: "r" },
  ]);

  // --- 11 an error, and the hint -------------------------------------------
  await typeSql(page, "SELECT artikel, umsatz FROM kioskumsat;");
  await page.click("#run");
  await page.waitForSelector("#results .error", { timeout: 20000 });
  await sleep(700);
  await shot(page, "11-fehler", "desktop", [
    { n: 1, sel: "#results .hint-de", side: "l" },
    { n: 2, sel: "#results .msg", side: "l" },
    { n: 3, sel: "#results dl", side: "r" },
  ]);

  await page.close();
}

// ---------- mobile ----------
{
  const page = await browser.newPage();
  acceptDialogs(page);
  await page.setViewport(TABLET);
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#username", { timeout: 15000 });
  await page.type("#username", demo.teacher.username, { delay: 6 });
  await page.type("#password", demo.teacher.password, { delay: 6 });
  await page.click('button[type="submit"]');
  await page.waitForSelector("#content", { timeout: 15000 });
  await sleep(600);

  await page.goto(`${BASE}/lesson`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#content table", { timeout: 15000 });
  await sleep(900);
  await shot(page, "12-lektion-tablet", "tablet", [
    { n: 1, sel: "#class", side: "l" },
    { n: 2, sel: "#content tbody tr td.sql pre.bad", side: "r" },
  ]);

  await page.close();
}

writeFileSync(`${OUT}rects.json`, JSON.stringify(meta, null, 2));
await browser.close();
console.log("done");
