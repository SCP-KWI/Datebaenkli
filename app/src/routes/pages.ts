/**
 * The HTML pages, served from memory.
 *
 * Deliberately *not* @fastify/static: static routes live in an encapsulated
 * plugin scope and carry no route `config`, so serving the pages that way would
 * need the global auth hook exempted by URL prefix — and these pages must be
 * public, which is exactly the exemption that weakens "closed unless marked
 * public". Phase 3's asset tree (`/assets`) is registered with `serve: false`
 * and fronted by one explicit route in server.ts, and that route is `public`
 * too — this comment used to claim the opposite, which §4k reversed: gating a
 * page's *script* leaves the user a dead shell instead of a redirect to
 * `/login`, because the code that would redirect never runs.
 *
 * These pages are unstyled beyond a few lines of CSS. The Chalk pass is phase 7
 * — anything prettier written now would only be thrown away.
 *
 * **They are also byte-for-byte constant, and phase 6b turns on that.** There is
 * no template engine and no substitution of any kind here, so the server cannot
 * render a page in the reader's language. Every page therefore ships with German
 * in its markup and swaps it client-side once `/api/me` answers
 * (`web/assets/i18n.js`). ARCHITECTURE §8a's "server renders the initial page in
 * the stored locale so there's no flash of German" is *not* what happens;
 * getting it would mean introducing templating here, which 6b deliberately did
 * not do for one frame of German. The German left in the markup is also what a
 * reader sees if the script never runs at all, which is §4k one level down.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

/** Resolved against the compiled output; `postbuild` copies src/web to dist/web. */
const WEB_DIR = join(import.meta.dirname, '..', 'web');

/**
 * Read once at boot: these never change at runtime, and a disk read per request
 * during a lesson is pure waste.
 *
 * A missing file means `dist/web` was not populated — `tsc` failing makes npm
 * skip `postbuild`, leaving fresh JS beside a stale or absent web directory.
 * Say so, rather than letting an ENOENT stack be the whole explanation. The
 * caller runs inside `start()`, so this goes through the structured
 * "startup failed" log and a non-zero exit.
 */
function page(name: string): string {
  try {
    return readFileSync(join(WEB_DIR, name), 'utf8');
  } catch (err) {
    throw new Error(
      `Could not read the page ${name} from ${WEB_DIR}. ` +
        `The build is incomplete — "npm run build" copies src/web to dist/web in its postbuild step.`,
      { cause: err },
    );
  }
}

export function registerPageRoutes(app: FastifyInstance): void {
  const pages: Record<string, string> = {
    '/login': page('login.html'),
    '/password': page('password.html'),
    '/sql': page('sql.html'),
    '/lesson': page('lesson.html'),
    '/roster': page('roster.html'),
    // German in the path, unlike the five above, and deliberately: the other
    // routes are words a reader of either locale recognises, `exercises` and
    // `uebungen` are not, and this is the one URL a teacher will type or paste
    // in front of a class. Nothing here is localised per request anyway — see
    // the note above about these pages being byte-for-byte constants.
    '/uebungen': page('uebungen.html'),
    '/': page('home.html'),
  };

  for (const [route, html] of Object.entries(pages)) {
    // Public: each page decides client-side what to render, and every action it
    // offers goes through an /api route that enforces the real rules. Serving
    // the shell to a logged-out browser leaks nothing.
    app.get(route, { config: { public: true } }, async (_req, reply) =>
      reply.type('text/html; charset=utf-8').send(html),
    );
  }
}
