#!/usr/bin/env node
// Vendors the Chalk webfonts into src/web/assets/fonts/ and generates
// src/web/assets/fonts.css.
//
// Ported from tscheggsch/tools/vendor-fonts.mjs, which is where the argument
// was first made and where the parsing was debugged. Only the output paths and
// the URL prefix differ.
//
// Why not fonts.googleapis.com, which is what the Chalk doc's §3 and §11 both
// tell you to use: every page load would send the reader's IP and User-Agent to
// a third party, and the readers here are minors on school accounts. It also
// makes a lesson depend on Google being reachable from the classroom — this app
// is otherwise entirely self-contained, and a SQL editor that renders in Times
// New Roman because a CDN is blocked is a support call in the middle of a
// lesson.
//
// Licences permit the redistribution this does: Source Sans 3 and IBM Plex Mono
// are SIL OFL 1.1, Material Symbols is Apache 2.0. All three allow hosting the
// files yourself. That matters because this repo is public.
//
// NOT part of `npm run build`, on purpose — it needs the network, and the
// output is committed. Run it by hand when a weight, a family or the icon axis
// changes:
//
//   cd app && node tools/vendor-fonts.mjs

import { writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FONT_DIR = join(ROOT, 'src/web/assets/fonts');
const CSS_OUT = join(ROOT, 'src/web/assets/fonts.css');

// The URL the generated @font-face rules point at. Not `/fonts/` as in
// tscheggsch: this app serves everything under `/assets`, and the woff2 files
// need the `/assets/fonts/:file` route in server.ts because the older
// `/assets/:file` is a single path segment and cannot reach a subdirectory.
const URL_PREFIX = '/assets/fonts';

// Only Latin subsets — the UI is German and English. Adding a language with
// another script means adding its subset here and re-running.
const KEEP_SUBSETS = new Set(['latin', 'latin-ext']);

// A modern desktop UA, so Google serves woff2 rather than legacy formats.
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * The icon glyphs this app actually uses, and the reason this list exists at
 * all: the full Material Symbols Rounded font is **361 KB** — every icon Google
 * ships — and this app draws about twenty. Passing `icon_names` cuts it to
 * **5 KB**, a factor of 73. tscheggsch vendors the whole font; this is the one
 * place this script deliberately does not match it.
 *
 * Two rules, both learned the hard way:
 *
 *   - **Alphabetical order is mandatory.** Out of order, the API does not
 *     subset differently — it answers `400: Invalid selector` with an HTML
 *     error page, which lands here as an unparseable stylesheet. `assertSorted`
 *     below turns that into a sentence instead of a mystery.
 *   - **Adding an icon to a page means re-running this script.** An icon not in
 *     this list renders as its own name in plain text ("delete" as a word), so
 *     the failure is loud and on screen rather than a blank square. That is the
 *     property that makes the subset safe to take.
 */
const ICONS = [
  'add', 'arrow_back', 'cancel', 'check_circle', 'chevron_right', 'dark_mode',
  'database', 'delete', 'download', 'error', 'expand_more', 'groups', 'info',
  'key', 'language', 'light_mode', 'logout', 'play_arrow', 'print', 'refresh',
  'restart_alt', 'schedule', 'school', 'stop_circle', 'table_view',
  'upload_file', 'warning',
];

function assertSorted(names) {
  for (let i = 1; i < names.length; i++) {
    if (names[i - 1] >= names[i]) {
      throw new Error(
        `ICONS must be in alphabetical order — "${names[i - 1]}" precedes "${names[i]}". ` +
          `Google answers 400 otherwise, with an HTML page rather than a stylesheet.`,
      );
    }
  }
}
assertSorted(ICONS);

const SOURCES = [
  {
    label: 'text',
    subsetAware: true,
    url: 'https://fonts.googleapis.com/css2?family=Source+Sans+3:ital,wght@0,400;0,500;0,600;0,700;1,400&family=IBM+Plex+Mono:wght@400;500;600&display=swap',
  },
  {
    label: 'icons',
    subsetAware: false,
    url:
      'https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@24,400,0,0' +
      `&icon_names=${ICONS.join(',')}&display=block`,
  },
];

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

// Split a Google Fonts stylesheet into { subset, block } pairs. Google emits a
// /* subset */ comment immediately before each @font-face rule.
function parseBlocks(css) {
  const out = [];
  const re = /(?:\/\* ([a-z-]+) \*\/\s*)?(@font-face\s*\{[^}]*\})/g;
  let m;
  let subset = 'latin';
  while ((m = re.exec(css)) !== null) {
    if (m[1]) subset = m[1];
    out.push({ subset, block: m[2] });
  }
  return out;
}

const field = (block, name) => new RegExp(`${name}:\\s*([^;]+);`).exec(block)?.[1].trim();

await mkdir(FONT_DIR, { recursive: true });
for (const f of await readdir(FONT_DIR).catch(() => [])) {
  if (f.endsWith('.woff2')) await unlink(join(FONT_DIR, f));
}

const rules = [
  '/* Self-hosted webfonts — GENERATED FILE, do not edit by hand.',
  ' * Rebuild with:  cd app && node tools/vendor-fonts.mjs',
  ' * That script explains why these are not loaded from Google.',
  ' */',
  '',
];
let count = 0;
let bytes = 0;

for (const source of SOURCES) {
  const css = await fetchText(source.url);
  const blocks = parseBlocks(css);
  // A rejected selector comes back as `200 text/html`, not as an error status,
  // so `fetchText` is happy and `parseBlocks` simply finds nothing. Without
  // this the script would report success having written no icon font at all.
  if (blocks.length === 0) {
    throw new Error(
      `No @font-face rules in the "${source.label}" stylesheet. ` +
        `Google most likely rejected the selector and answered an HTML error page.`,
    );
  }
  for (const { subset, block } of blocks) {
    if (source.subsetAware && !KEEP_SUBSETS.has(subset)) continue;

    const family = /font-family:\s*'([^']+)'/.exec(block)?.[1];
    const url = /url\(([^)]+)\)/.exec(block)?.[1];
    if (!family || !url) continue;

    const weight = (field(block, 'font-weight') || '400').replace(/\s+/g, '-');
    const italic = field(block, 'font-style') === 'italic';
    const file =
      [
        family.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        italic ? 'italic' : null,
        weight,
        source.subsetAware ? subset : null,
      ]
        .filter(Boolean)
        .join('-') + '.woff2';

    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`${res.status} for ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(join(FONT_DIR, file), buf);
    count++;
    bytes += buf.length;
    console.log(`  ${file.padEnd(44)} ${(buf.length / 1024).toFixed(0).padStart(4)} KB`);

    // Keep Google's own font-display (block for icons, swap for text) and only
    // rewrite the URL to our own origin.
    rules.push(block.replace(/url\([^)]+\)/, `url('${URL_PREFIX}/${file}')`).trim(), '');
  }
}

await writeFile(CSS_OUT, rules.join('\n'));
console.log(`\n${count} files, ${(bytes / 1024).toFixed(0)} KB total`);
console.log(`src/web/assets/fonts/ + src/web/assets/fonts.css written.`);
