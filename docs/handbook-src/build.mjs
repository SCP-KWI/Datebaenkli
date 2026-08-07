// Builds the standalone handbook: inlines fonts, screenshots and the numbered
// arrow overlays into a single HTML file.
import { readFileSync, writeFileSync } from "node:fs";

const SP = new URL("./", import.meta.url).pathname;   // docs/handbook-src/
const REPO = new URL("../../", import.meta.url).pathname;
const SHOTS = `${SP}shots/`;
const ASSETS = `${REPO}app/src/web/assets/`;
const rects = JSON.parse(readFileSync(`${SHOTS}rects.json`, "utf8"));

// ---- figures ---------------------------------------------------------------
// crop: [y0, y1] in page CSS px. only: subset of mark numbers to draw.
const FIGURES = {
  login: { shot: "01-login", crop: [215, 630] },
  uebersicht: { shot: "02-uebersicht", crop: [0, 300] },
  klasse: { shot: "03-klasse-anlegen", crop: [175, 490] },
  lernende: { shot: "04-lernende-anlegen", crop: [600, 1075] },
  zettel: { shot: "05-zettel", crop: [30, 790] },
  klassenliste: { shot: "06-klassenliste", crop: [535, 935] },
  lektion: { shot: "07-lektion", crop: [55, 745] },
  detail: { shot: "08-lektion-detail", crop: [95, 795] },
  csv: { shot: "09-csv", crop: [45, 855] },
  editor: { shot: "10-editor", crop: [0, 700] },
  fehler: { shot: "11-fehler", crop: [0, 645] },
  tablet: { shot: "12-lektion-tablet", crop: [0, 835] },
};

const b64 = (p) => readFileSync(p).toString("base64");

function figure(key) {
  const cfg = FIGURES[key];
  if (!cfg) throw new Error(`unknown figure ${key}`);
  const m = rects[cfg.shot];
  if (!m) throw new Error(`no rects for ${cfg.shot}`);
  const marks = m.marks.filter(
    (r) => !r.missing && (!cfg.only || cfg.only.includes(r.n))
  );
  const [y0, y1] = cfg.crop ?? [0, m.pageH];

  const contentL = Math.min(...marks.map((r) => r.x));
  const contentR = Math.max(...marks.map((r) => r.x + r.w));
  const bxL = contentL - 46;
  const bxR = contentR + 46;
  const minX = Math.min(0, bxL - 22);
  const maxX = Math.max(m.pageW, bxR + 22);

  const R = 14;
  const parts = [];
  for (const r of marks) {
    // dy nudges the BADGE only, so marks sharing a row don't collide. The arrow
    // still has to land on the element: when the badge is offset, the line runs
    // horizontally out of it and then bends onto the element's true centre. A
    // straight line from an offset badge points at empty space beside the mark.
    const cyTarget = Math.round(r.y + r.h / 2);
    const cyBadge = cyTarget + (r.dy || 0);
    const left = r.side === "l";
    const bx = left ? bxL : bxR;
    const x1 = left ? bx + R + 2 : bx - R - 2;
    const x2 = left ? r.x - 7 : r.x + r.w + 7;
    if (Math.abs(x2 - x1) > 8) {
      const bend = left ? Math.max(x1, x2 - 26) : Math.min(x1, x2 + 26);
      const d =
        cyBadge === cyTarget
          ? `M${x1} ${cyTarget} H${x2}`
          : `M${x1} ${cyBadge} H${bend} L${x2} ${cyTarget}`;
      parts.push(
        `<path class="hal" d="${d}"/>`,
        `<path class="arw" d="${d}" marker-end="url(#ah-${key})"/>`
      );
    }
    parts.push(
      `<circle class="bdg" cx="${bx}" cy="${cyBadge}" r="${R}"/>`,
      `<text class="bdgt" x="${bx}" y="${cyBadge + 1}">${r.n}</text>`
    );
  }

  const img = b64(`${SHOTS}web/${cfg.shot}.webp`);
  return `<svg class="fig fig--${m.device}" viewBox="${minX} ${y0} ${maxX - minX} ${y1 - y0}" role="img">
<defs><marker id="ah-${key}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="currentColor"/></marker></defs>
<image href="data:image/webp;base64,${img}" x="0" y="0" width="${m.pageW}" height="${m.pageH}"/>
${parts.join("\n")}
</svg>`;
}

// ---- fonts -----------------------------------------------------------------
// Taken from the app's own vendored set rather than a second copy, so the
// handbook cannot drift typographically away from the thing it documents.
//
// The `latin-ext` subsets are dropped and only these weights are kept: German
// and the Swiss quotation marks live inside `latin`, and shipping everything
// would put ~400 KB of base64 into a file that is mostly screenshots.
const KEEP = [
  "source-sans-3-400-latin.woff2",
  "source-sans-3-600-latin.woff2",
  "source-sans-3-700-latin.woff2",
  "ibm-plex-mono-400-latin.woff2",
  "ibm-plex-mono-600-latin.woff2",
];

const fonts = readFileSync(`${ASSETS}fonts.css`, "utf8")
  .split("@font-face")
  .slice(1)
  .map((block) => `@font-face${block.slice(0, block.indexOf("}") + 1)}`)
  .filter((block) => KEEP.some((f) => block.includes(f)))
  .map((block) =>
    block.replace(/url\('\/assets\/fonts\/([^']+)'\)/, (_, file) =>
      `url(data:font/woff2;base64,${b64(ASSETS + "fonts/" + file)})`
    )
  )
  .join("\n");

if (fonts.split("@font-face").length - 1 !== KEEP.length) {
  throw new Error("fonts.css no longer carries the expected faces");
}

// ---- assemble --------------------------------------------------------------
let html = readFileSync(`${SP}handbuch.src.html`, "utf8");
html = html.replace(/\{\{FONTS\}\}/g, fonts);
html = html.replace(/\{\{FIG:([a-z0-9-]+)\}\}/g, (_, k) => figure(k));

const left = html.match(/\{\{[^}]+\}\}/g);
if (left) throw new Error(`unreplaced placeholders: ${left.join(", ")}`);

const out = `${REPO}docs/handbuch.html`;
writeFileSync(out, html);
console.log(`wrote ${out} — ${(html.length / 1024 / 1024).toFixed(2)} MB`);
