/**
 * Identifier derivation and login throttling. Pure logic, no database.
 *
 * These names end up as real Postgres roles and schemas, so the rules here are
 * load-bearing: a name longer than 63 bytes is silently truncated by Postgres
 * (two students could then collide *inside* the server, after our uniqueness
 * check passed), and anything outside [a-z0-9_] would need quoting everywhere
 * a student ever types their own schema name.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = (p) => pathToFileURL(join(import.meta.dirname, '..', 'dist', p)).href;

process.env.DBK_ENCRYPTION_KEY ??= Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
// Not `'x'.repeat(48)`: `config.ts` now rejects a secret with fewer than 12
// distinct characters, because length alone let `'aaaa…'` through. A fixed
// literal keeps the tests deterministic while satisfying that.
process.env.DBK_SESSION_SECRET ??= 'test-session-secret-0123456789abcdefghijklmnop';
process.env.DBK_APP_DB_PASSWORD ??= 'test';

const {
  fold,
  studentIdentifier,
  teacherIdentifier,
  withSuffix,
  allocateIdentifier,
  MAX_IDENTIFIER_BYTES,
} = await import(dist('auth/identifiers.js'));
const { FailureLimiter } = await import(dist('auth/ratelimit.js'));

// --- folding -----------------------------------------------------------------

test('fold: umlauts become their German transliteration, not bare vowels', () => {
  assert.equal(fold('Müller'), 'mueller');
  assert.equal(fold('Bär'), 'baer');
  assert.equal(fold('Öztürk'), 'oeztuerk');
  assert.equal(fold('Weiß'), 'weiss');
});

test('fold: decomposed input folds the same as composed', () => {
  // iPadOS often produces the decomposed form. Derived with normalize() rather
  // than written as a literal, because editors silently re-compose those.
  const composed = 'Müller';
  const decomposed = composed.normalize('NFD'); // u + combining diaeresis
  assert.notEqual(composed, decomposed, 'test inputs must actually differ');
  assert.equal(fold(decomposed), fold(composed));
  assert.equal(fold(decomposed), 'mueller');
});

test('fold: other accents are stripped rather than transliterated', () => {
  assert.equal(fold('Éloïse'), 'eloise');
  assert.equal(fold('Škoda'), 'skoda');
});

test('fold: everything outside [a-z0-9] disappears', () => {
  assert.equal(fold("O'Brien-Meier"), 'obrienmeier');
  assert.equal(fold('  van der Berg '), 'vanderberg');
  assert.equal(fold('K3a'), 'k3a');
  assert.equal(fold('❤️'), '');
});

// --- names -------------------------------------------------------------------

test('student identifier follows u_<class>_<surname>_<firstname>', () => {
  assert.equal(studentIdentifier('k3a', 'Muster', 'Lena'), 'u_k3a_muster_lena');
  assert.equal(studentIdentifier('K3a', 'Bühler', 'Tim'), 'u_k3a_buehler_tim');
});

test('teacher identifier is t_<surname>', () => {
  assert.equal(teacherIdentifier('Schaffner', 'Philip'), 't_schaffner');
  assert.equal(teacherIdentifier('Öztürk'), 't_oeztuerk');
});

test('a name in a non-Latin script still yields a usable identifier', () => {
  // Folding leaves nothing; refusing to enrol the student is not an option.
  const name = studentIdentifier('k3a', '李', '明');
  assert.match(name, /^u_k3a_[a-z0-9_]+$/);
});

test('identifiers never exceed the 63-byte Postgres limit', () => {
  const long = 'Schmidtberger'.repeat(8);
  for (const name of [
    studentIdentifier('abcdefghijkl', long, long),
    teacherIdentifier(long, long),
    withSuffix(studentIdentifier('abcdefghijkl', long, long), 17),
    withSuffix('u_' + 'a'.repeat(61), 123),
  ]) {
    assert.ok(
      Buffer.byteLength(name, 'utf8') <= MAX_IDENTIFIER_BYTES,
      `${name} is ${Buffer.byteLength(name, 'utf8')} bytes`,
    );
    assert.match(name, /^[a-z][a-z0-9_]*$/, `${name} must be a bare Postgres identifier`);
  }
});

test('a suffix at the length limit replaces characters instead of overflowing', () => {
  const base = 'u_' + 'a'.repeat(61); // exactly 63
  assert.equal(withSuffix(base, 1), base);
  const second = withSuffix(base, 2);
  assert.equal(second.length, 63);
  assert.ok(second.endsWith('2'));
});

// --- collisions --------------------------------------------------------------

test('collisions get the lowest free numeric suffix', () => {
  const base = 'u_k3a_muster_lena';
  assert.equal(allocateIdentifier(base, new Set()), base);
  assert.equal(allocateIdentifier(base, new Set([base])), `${base}2`);
  assert.equal(allocateIdentifier(base, new Set([base, `${base}2`])), `${base}3`);
  // A gap is reused rather than skipped.
  assert.equal(allocateIdentifier(base, new Set([base, `${base}3`])), `${base}2`);
});

test('allocation gives up rather than looping forever', () => {
  const base = 'u_x';
  const taken = new Set([base]);
  for (let n = 2; n <= 500; n++) taken.add(`${base}${n}`);
  assert.throws(() => allocateIdentifier(base, taken), /500 attempts/);
});

// --- rate limiting -----------------------------------------------------------

test('limiter blocks only after the budget is spent, and only that key', () => {
  const limiter = new FailureLimiter(3, 60_000);
  const now = 1_000_000;

  for (let i = 0; i < 3; i++) {
    assert.equal(limiter.retryAfterMs('lena', now), 0, `attempt ${i + 1} should be allowed`);
    limiter.fail('lena', now);
  }
  assert.ok(limiter.retryAfterMs('lena', now) > 0, 'fourth attempt should be blocked');
  assert.equal(limiter.retryAfterMs('tim', now), 0, 'other accounts are unaffected');
});

test('limiter forgets after the window, and on success', () => {
  const limiter = new FailureLimiter(2, 60_000);
  const now = 1_000_000;
  limiter.fail('lena', now);
  limiter.fail('lena', now);
  assert.ok(limiter.retryAfterMs('lena', now) > 0);

  assert.equal(limiter.retryAfterMs('lena', now + 60_001), 0, 'window should have lapsed');

  limiter.fail('tim', now);
  limiter.fail('tim', now);
  limiter.clear('tim');
  assert.equal(limiter.retryAfterMs('tim', now), 0, 'a successful login clears the budget');
});

test('limiter sweeps lapsed windows so it cannot grow without bound', () => {
  const limiter = new FailureLimiter(5, 1000);
  for (let i = 0; i < 100; i++) limiter.fail(`user${i}`, 1_000_000);
  assert.equal(limiter.size, 100);
  limiter.sweep(1_002_000);
  assert.equal(limiter.size, 0);
});
