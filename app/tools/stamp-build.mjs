#!/usr/bin/env node
// Writes dist/build-info.json — the one fact about a running instance that
// nobody has to remember to update.
//
// The footer shows a version and a build time. The version comes from
// package.json and is bumped by hand at release (§7's runbook); the build time
// comes from here and cannot be forgotten, which is the whole point of having
// both. `package.json` said 0.1.0 through seven phases and five deploys, so a
// semver on its own would have confidently named the wrong release. Paired with
// a timestamp, a stale semver is merely uninformative rather than misleading.
//
// Runs as part of `postbuild`, so it happens inside `docker compose build` with
// no build-args and nothing to pass through from the host. That matters: the
// build context has no `.git` (see app/Dockerfile), so a commit SHA is not
// available here even if it were wanted.
//
// **Which means this file must be COPYed into the image**, and it was not — the
// first deploy carrying it failed at `RUN npm run build` with MODULE_NOT_FOUND,
// because the Dockerfile copied only `package.json`, `tsconfig.json` and `src`.
// `COPY tools ./tools` is now there and has a comment saying why. HANDOFF §4ss
// records how to check this class of thing without Docker.
//
// Absence is meaningful and is not an error: `npm run dev` executes from `src`
// and never produces a `dist`, so `config.ts` finding no file is exactly how it
// knows it is not running a build.

import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

// Second precision, UTC, and the `Z` kept: the container runs UTC (HANDOFF
// §4gg) and the page renders this through `Intl` in the reader's locale, so the
// stored value must be an unambiguous instant rather than a local-looking
// string. §4l is the same argument about dates one layer down.
const builtAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

await mkdir(DIST, { recursive: true });
await writeFile(join(DIST, 'build-info.json'), `${JSON.stringify({ builtAt }, null, 2)}\n`);
console.log(`build stamped ${builtAt}`);
