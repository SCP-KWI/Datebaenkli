/**
 * One assertion, and it exists because of how this file gets used elsewhere.
 *
 * `chalk-tokens.css` lives twice in this repo on purpose:
 * `chalk-design-system/` holds the portable artifact — the one that gets pasted
 * into the next app built on the system — and `app/src/web/assets/` holds the
 * copy this app actually serves. Two files, one content.
 *
 * The failure mode is silent and slow. Someone tunes a colour in the served
 * copy because that is the one with the live reload, the portable copy keeps the
 * old value, and then the *portable* one is what gets copied back out. Nobody
 * sees it here, because this app renders correctly either way.
 *
 * So: bytes, not "roughly equal". A diff of any kind is a decision someone made
 * in one place and not the other, and the fix is to decide which one is right
 * rather than to relax this test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(APP, '..');

test('the portable and served chalk-tokens.css are byte-identical', () => {
  const portable = readFileSync(join(REPO, 'chalk-design-system/chalk-tokens.css'), 'utf8');
  const served = readFileSync(join(APP, 'src/web/assets/chalk-tokens.css'), 'utf8');

  assert.equal(
    served,
    portable,
    'chalk-design-system/chalk-tokens.css and app/src/web/assets/chalk-tokens.css have ' +
      'drifted. The first is what gets copied into the next Chalk app, so fix the ' +
      'divergence rather than this test.',
  );
});

test('the app accent is declared and aliased', () => {
  const tokens = readFileSync(join(APP, 'src/web/assets/chalk-tokens.css'), 'utf8');
  const app = readFileSync(join(APP, 'src/web/assets/app.css'), 'utf8');

  // ARCHITECTURE §8, confirmed 2026-07-28; lightness revised 2026-07-30.
  // Pinned rather than merely pattern-matched: the Chalk rule is that lightness
  // and chroma match the rest of the accent ring and *only* the hue moves, so a
  // change to any of the three numbers is a change to the ring, not to this app.
  //
  // **The `0.578` is derived, not chosen.** It is the lightest this hue can be
  // while white text on it still clears WCAG AA (4.5:1); at the ring's previous
  // 0.690 it measured 2.87 and failed on every primary button on every accent.
  // Raising it back is not a palette preference, it is re-breaking
  // that — HANDOFF §4ww has the measurements and the per-hue targets, which
  // differ because luminance at a fixed OKLCH lightness does not.
  assert.match(tokens, /--datebaenkli:\s*oklch\(0\.578 0\.100 300\)/);

  // The alias is what actually reaches a component — every rule in app.css is
  // written against --accent, so the token existing is not enough.
  assert.match(app, /--accent:\s*var\(--datebaenkli\)/);
});
