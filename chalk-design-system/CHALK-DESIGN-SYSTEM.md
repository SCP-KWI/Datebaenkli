# Chalk — Design System

A warm, calm, professional design language for a family of teacher productivity
tools. One shared system; each app carries its own accent so a teacher always
knows where they are. Muted-pastel accents, warm-neutral surfaces, humanist
type, quiet borders, light **and** dark.

> **This document is the portable source of truth.** Archive it. To reuse the
> system in a new project or a fresh conversation, paste this file (and
> `chalk-tokens.css`) to Claude and say *"build with the Chalk design system as
> specified here."* The token CSS is the exact, copy-pasteable variable set;
> this doc explains how to apply it.

---

## 1. The accent ring

One shared system, several accents. They share nearly identical lightness and
chroma and differ **only in hue** — that shared L/C is what makes apps built on
different accents still feel related. An app picks one position on the ring and
keeps it, so a user always knows which tool they are looking at.

| Accent | Hue | Typical use |
|--------|-----|-------------|
| Terracotta | 45° | warm, people-facing tools |
| Sage | 152° | also the semantic "positive" hue |
| Slate blue | 255° | |
| Violet | 300° | Datebänkli, the app in this repo |
| Plum | 340° | |
| Teal | 200° | |

Each accent has three roles: **solid** (fills, icons, primary buttons), **tint**
(soft backgrounds, badges), **ink** (accent-colored text, readable on tint or
paper). The solid is constant across light/dark; tint and ink shift per mode.

---

## 2. Color

Full values live in `chalk-tokens.css`. Summary:

**Neutrals — warm, never pure white/black.**
- Light: paper `oklch(0.985 0.006 83)`, surface `0.998 0.003 83`, sunken
  `0.955 0.008 83`, hairline `0.912 0.010 83`, strong border `0.845 0.013 83`,
  ink `0.290 0.014 70`, muted `0.520 0.012 70`, faint `0.660 0.010 70`.
- Dark: paper `0.205 0.008 75`, surface `0.248 0.010 75`, sunken
  `0.292 0.011 75`, hairline `0.335 0.012 75`, strong `0.410 0.014 75`, ink
  `0.935 0.008 83`, muted `0.705 0.011 80`, faint `0.560 0.010 80`.

**Accents (solid, hue varies):** terracotta 45°, teal 200°, slate 255°, violet
300°, plum 340°, sage 152° — all at roughly `C 0.09–0.11`, with the lightness of
each solid set to the lightest value at which **white text on it clears WCAG AA
(4.5:1)**; see the `chalk-tokens.css` header. Tints are `L~0.955 C~0.03` (light)
/ `L~0.34 C~0.05` (dark); inks are `L~0.50 C~0.11` (light) / `L~0.83 C~0.09`
(dark).

**Semantic / status** (shared by every app):
- **Positive / success** = sage, hue 152 (the same hue as the sage accent)
- **Caution / low-confidence** = amber, hue 78
- **Negative / error** = red, hue 26
- **Neutral** marker = `oklch(0.760 0.012 80)`

Where an app expresses sentiment, map **positive → sage, neutral → neutral grey,
negative → red**, used consistently on chips, trend bars, and card borders.

**Rule:** never introduce a color outside this set. New accents must match the
shared chroma/lightness and only change hue.

---

## 3. Typography

Two families, loaded from Google Fonts (see `chalk-tokens.css` header for the
exact `<link>` tags).

- **Source Sans 3** — humanist sans; all UI and body text. Weights 400/500/600/700.
- **IBM Plex Mono** — figures, dates, scores, eyebrow labels, code/monospace.
  Weights 400/500/600. Use for anything numeric (tabular) and for small
  uppercase labels.

**Scale (guidance, not dogma):**
| Role | Size / weight / tracking |
|------|--------------------------|
| Display | `clamp(30px, 4.4vw, 44px)` · 700 · `-0.025em` |
| H1 | 32px · 700 · `-0.02em` |
| Section head (H2) | 26px · 700 · `-0.015em` |
| Card title | 17px · 600 |
| Body | 15–16px · 400 · line-height 1.55 |
| Small / hint | 12.5–13px · muted |
| Mono eyebrow | 11–12px · 500 · uppercase · tracking `0.08–0.12em` · faint/accent-ink |

Minimums: never below 24px on 1920×1080 slides; 12–13px floor in dense UI.

---

## 4. Iconography

**Material Symbols Rounded** (rounded fits the humanist type). Used as ligature
text via a `.mi` span (see token file). Keep icons purposeful — app identities,
nav, primary actions, list affordances (`chevron_right`). Avoid decorative
emoji; the one place emoji appear is never required.

Common glyphs used: `groups`, `grading`, `visibility`, `quiz`, `mic`,
`stop_circle`, `insights`, `tune`, `upload_file`, `table_view`, `folder_open`,
`picture_as_pdf`, `check_circle`, `cancel`, `adjust`, `emoji_events`, `star`,
`arrow_forward`, `arrow_back`, `dark_mode`, `light_mode`, `restart_alt`,
`chevron_right`, `expand_more`.

---

## 5. Shape, elevation, spacing

- **Radius:** sm 9–10px, base 12–13px, md 14px, lg 16px, xl 20–22px. Cards use
  lg/xl; inputs/buttons base; pills `999px`.
- **Borders:** 1px `--line` on cards; 1.5px `--line-strong` on inputs and
  dropzones. Borders do a lot of the work — Chalk is quiet, not heavy on shadow.
- **Elevation:** two soft, warm shadows (`--shadow`, `--shadow-lg`). Never harsh.
- **Spacing:** generous but balanced. Card padding 20–26px; gaps 10–18px; use
  flex/grid with `gap` for all groupings (not margins between inline siblings).

---

## 6. Theming (light / dark)

- Dark mode activates when `html` (or any ancestor) has `data-theme="dark"`.
  Light is the default with no attribute.
- **Persistence:** store the choice in `localStorage` under the key
  **`chalk-theme`** (`"light"` | `"dark"`).
- **No-flash:** in `<head>`, before the app renders, run:
  ```html
  <script>
    try { if (localStorage.getItem("chalk-theme") === "dark")
      document.documentElement.setAttribute("data-theme", "dark"); } catch (e) {}
  </script>
  ```
- **Toggle button:** shows `dark_mode` in light mode, `light_mode` in dark;
  flips the attribute and writes `localStorage`.
- **Important:** drive theme with the `data-theme` attribute + CSS variables,
  not by animating `opacity` — and never leave content at `opacity:0` via a
  fill-mode entrance animation, since throttled iframes/tabs can strand it
  invisible. If you use entrance animations, animate `transform` only.

---

## 7. Components (recipes)

Build against the variables. Canonical patterns:

**Top bar** — sticky, translucent (`color-mix(in oklch, var(--paper) 82%,
transparent)` + `backdrop-filter: blur(12px)`), 1px bottom border. Left: a
32–34px rounded accent **brand badge** (solid accent bg, white icon) + wordmark.
Right: actions incl. the theme toggle (36–38px bordered square button).

**Buttons**
- *Primary:* solid `--accent` (or `--ink` for a neutral primary), white text,
  radius 11–13px, `--shadow`, hover `filter: brightness(1.05)`.
- *Secondary:* `--surface` bg, `--ink` text, 1px `--line-strong`, hover border → `--ink`.
- *Ghost:* transparent, `--accent-ink` text, hover bg `--accent-tint`.
- Full-width block buttons for primary mobile actions (height 50px).

**Inputs / selects / textarea** — `--paper` bg, 1.5px `--line-strong`, radius
12px; focus: border `--accent` + `box-shadow: 0 0 0 4px var(--accent-tint)`.
Custom chevron on selects. Numeric fields use the mono font.

**Card** — `--surface`, 1px `--line`, radius 16–22px, `--shadow`, padding 20–26px.

**Badges / chips** — pill (`999px`), tint bg + ink text, 12–13px 600. Status
variants: ok → `--ok-tint`/`--ok-ink`, warn → `--warn-*`, bad → `--bad-*`,
neutral → `--surface-2`/`--muted`. Count chips use the mono font.

**Tabs** — segmented control: `--surface-2` track with 1px `--line`, radius 12px,
4px padding; active tab gets `--surface` bg + `--shadow` + `--accent-ink` text;
each tab an icon + label.

**List rows** (classes, students) — `--surface` card rows, 1px `--line`, radius
12px, hover border `--accent`; trailing `chevron_right` in `--faint`.

**Status banner** — tinted rounded box (ok/warn/bad tint bg + matching ink),
icon + message; reserve min-height so layout doesn't jump.

**Table / preview** — `--surface-2` header row with mono uppercase labels; 1px
`--line` cells; numeric cells right-aligned in mono with tabular figures; a
highlighted "Max"/summary row uses `--accent-tint`.

**Trend bar** — flex row of segments; positive `--ok` solid, neutral
`--neutral`, negative `--bad` solid; `999px` radius; `flex:` weighted by count.

**Dropzone** — dashed 1.5px `--line-strong`, radius 16–20px, `--surface` bg;
hover/dragover: border `--accent`, bg `--accent-tint`; centered icon tile
(accent-tint bg, accent-ink icon) + title + sub + optional button.

**Mic / record button** — full-width, 1.5px accent border, accent bg when active
with a gentle `pulse` opacity keyframe.

---

## 8. Layout

- **Mobile / PWA:** single column, `max-width: 640px`, centered, generous bottom
  padding, `env(safe-area-inset-*)` respected. Hit targets ≥ 44px.
- **Desktop tools:** content `max-width: 1080–1180px`; two-column splits
  (e.g. form + live preview) collapse to one column under ~820px.
- Group everything with flex/grid + `gap`.

---

## 9. Principles (and anti-slop)

- **Do:** warm neutrals; muted accents sharing chroma/lightness; humanist sans +
  mono for figures; quiet 1px borders; soft shadows; tabular numerals; flex/grid
  with gap; light + dark parity.
- **Don't:** gradient backgrounds; saturated colors; decorative emoji;
  rounded-box-with-left-accent "AI card" clichés everywhere (the left status
  border is used *intentionally* only for sentiment/match state); inventing new
  hues; pure `#fff`/`#000`; icon soup or stat padding. Less is more.

---

## 10. Applying Chalk to an app (reference)

The system has been applied to both vanilla HTML/CSS/JS tools and to a React
PWA, and neither needed a build step to adopt it:

- **Vanilla app** — include `chalk-tokens.css`, set `data-app` on `<html>`, and
  write plain CSS against the variables. This repo is that case.
- **Existing app with its own markup** — add a Chalk `styles.css` that keeps the
  app's existing class names and re-expresses them in tokens. Nothing in the
  HTML has to move.

Two ways to pick an accent, both supported by the token file: **bring a new
hue** (declare it in `chalk-tokens.css` and alias `--accent` to it) or **reuse
an existing one** (re-point the `:root` alias block and add no token). Bringing
a hue is the bigger commitment — it changes the shared file every other app
reads.

---

## 11. Quick-start checklist for a new screen

1. Load the three font `<link>`s and the no-flash theme script in `<head>`.
2. Include `chalk-tokens.css`.
3. Set the app's accent alias (`--accent…`) or put `data-app="…"` on a wrapper.
4. Build with `--surface` cards, `--line` borders, `--ink`/`--muted` text, the
   accent for primary actions, semantic tokens for status.
5. Source Sans 3 everywhere; IBM Plex Mono for numbers/labels; `.mi` for icons.
6. Add a light/dark toggle wired to `data-theme` + `localStorage["chalk-theme"]`.
