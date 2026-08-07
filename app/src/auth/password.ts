/**
 * Password hashing — scrypt from node:crypto.
 *
 * Deliberately not argon2/bcrypt: both are native modules, and building them
 * on alpine adds a toolchain to the image for no security gain at this scale.
 * scrypt is memory-hard, in the standard library, and has no build step.
 *
 * Format: scrypt$N$r$p$<salt b64>$<key b64>
 * The parameters are stored per-hash so they can be raised later without
 * invalidating existing passwords.
 */

import { randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const PARAMS = { N: 16384, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
// scrypt needs roughly 128 * N * r bytes; give it headroom or it throws.
const MAX_MEM = 128 * PARAMS.N * PARAMS.r * 4;

/**
 * At most this many scrypt calls in flight; the rest queue.
 *
 * scrypt is memory-hard *by design* — N=16384, r=8 is about 16 MB and ~100 ms
 * each — and node's crypto runs it on the libuv threadpool, which defaults to
 * four threads. That makes every hash a scarce resource shared with file I/O.
 *
 * Unbounded, the arithmetic goes the wrong way: `POST /api/me/password` costs
 * up to two verifies plus a hash, so a logged-in student looping it ties up the
 * threadpool and stalls everyone else's login. The limiter in `routes/session.ts`
 * bounds *failures* per account, which by definition does not touch a caller
 * who keeps succeeding.
 *
 * Four, matching the default threadpool: more in flight than there are threads
 * buys nothing but memory. Queueing rather than rejecting is deliberate — the
 * honest case is a class of 25 logging in within the same minute, and 25 × 100 ms
 * spread over four threads is under a second of queue, which nobody notices.
 */
const MAX_CONCURRENT_HASHES = 4;
let inFlight = 0;
const waiting: (() => void)[] = [];

async function withHashSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= MAX_CONCURRENT_HASHES) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  inFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
    waiting.shift()?.();
  }
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length === 0) throw new Error('Refusing to hash an empty password.');
  const salt = randomBytes(SALT_LENGTH);
  const key = await withHashSlot(() =>
    scryptAsync(password.normalize('NFKC'), salt, KEY_LENGTH, {
      ...PARAMS,
      maxmem: MAX_MEM,
    }),
  );
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');

  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (salt.length === 0 || expected.length === 0) return false;

  const actual = await withHashSlot(() =>
    scryptAsync(password.normalize('NFKC'), salt, expected.length, {
      N,
      r,
      p,
      maxmem: 128 * N * r * 4,
    }),
  );

  // Lengths are equal by construction here, but timingSafeEqual throws if they
  // ever aren't, so check first.
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * 64 words and 16 colours, and both counts are load-bearing — see the entropy
 * arithmetic on `generateSlipPassword`. Adding or removing an entry changes the
 * strength of every slip password the app issues, so change the count
 * deliberately and update the number in that docblock.
 *
 * All lowercase ASCII, no umlauts, and deliberately no near-twins: a slip is
 * copied by hand off paper by someone who has never seen the word before.
 * `firn` is here, so `farn` is not; `kiesel` is here, so `kies` is not;
 * `eiche` is here, so `esche` is not.
 */
const WORDS = [
  'hafer', 'birke', 'anker', 'wolke', 'feder', 'gipfel', 'kiesel', 'lawine',
  'moos', 'nebel', 'pfad', 'quelle', 'rebe', 'schnee', 'tanne', 'ufer',
  'vogel', 'wiese', 'zeiger', 'brise', 'delta', 'firn', 'ahorn', 'alpen',
  'bach', 'berg', 'blatt', 'boden', 'distel', 'dohle', 'eiche', 'krokus',
  'falke', 'fels', 'flut', 'garbe', 'gras', 'hain', 'halm', 'hecke',
  'heide', 'holz', 'insel', 'kranz', 'klee', 'korn', 'lehm', 'linde',
  'molke', 'mulde', 'otter', 'pilz', 'raps', 'reif', 'rinde', 'sand',
  'stein', 'storch', 'strand', 'tau', 'torf', 'wald', 'welle', 'wurzel',
];
const COLOURS = [
  'blau', 'gruen', 'rot', 'gelb', 'grau', 'braun', 'weiss', 'silber',
  'gold', 'schwarz', 'orange', 'violett', 'rosa', 'tuerkis', 'beige', 'kupfer',
];

/**
 * A passphrase a 15-year-old can copy off a printed slip without typos:
 * two words around a colour, plus four digits — e.g. "hafer-blau-tanne-4821".
 *
 * **29.1 bits** (64 × 16 × 64 × 9000 = 589 824 000). Count the lists before
 * trusting that number; the previous version of this comment claimed ~22 bits
 * for a generator that produced 22 × 9 × 90 = 17 820 — **14.1 bits** — and
 * `ratelimit.ts` then sized the per-account budget by reasoning from the wrong
 * figure. At 14 bits and 10 tries per 15 minutes a targeted account fell in
 * about nine days, and usernames are guessable by construction
 * (`u_<class>_<surname>_<firstname>`) and readable out of `pg_roles` by any
 * student. Teacher accounts used the same generator.
 *
 * Still weak in the abstract, and still deliberately so: login is rate-limited
 * in two dimensions, the account holds nothing sensitive, and a random string
 * gets mistyped ten times in the first lesson. The difference is that 29 bits
 * survives the arithmetic — an exhaustive search at the per-account budget is
 * on the order of a million years — and the slip is meant to be changed on
 * first login anyway.
 *
 * `randomInt` rather than `randomBytes[i] % length`: the modulo folded 256 onto
 * 22 and 90, so the low words and low digits came up measurably more often.
 * Worth ~0.02 bits, which is nothing, but it also biased any ordered guess list
 * in the attacker's favour and there is no reason to pay for it.
 */
export function generateSlipPassword(): string {
  const word = () => WORDS[randomInt(WORDS.length)]!;
  const colour = COLOURS[randomInt(COLOURS.length)]!;
  // The two words are drawn independently and may coincide. That is what makes
  // the count above exactly 64 × 16 × 64 and not something needing a caveat.
  return `${word()}-${colour}-${word()}-${1000 + randomInt(9000)}`;
}

/** A full-strength password for a Postgres role. Never shown to anyone. */
export function generateDbPassword(): string {
  return randomBytes(24).toString('base64url');
}
