/**
 * Password hashing and secret encryption.
 * Run against the compiled output: `npm run build && npm test`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = (p) => pathToFileURL(join(import.meta.dirname, '..', 'dist', p)).href;

// config.ts validates eagerly at import time, so give it a valid environment.
process.env.DBK_ENCRYPTION_KEY ??= Buffer.from(
  '0123456789abcdef0123456789abcdef',
).toString('base64');
// Not `'x'.repeat(48)`: `config.ts` now rejects a secret with fewer than 12
// distinct characters, because length alone let `'aaaa…'` through. A fixed
// literal keeps the tests deterministic while satisfying that.
process.env.DBK_SESSION_SECRET ??= 'test-session-secret-0123456789abcdefghijklmnop';
process.env.DBK_APP_DB_PASSWORD ??= 'test';

const { hashPassword, verifyPassword, generateSlipPassword, generateDbPassword } =
  await import(dist('auth/password.js'));
const { encryptSecret, decryptSecret } = await import(dist('crypto/secretbox.js'));

test('password: hash/verify round-trip', async () => {
  const h = await hashPassword('hafer-blau-71');
  assert.ok(h.startsWith('scrypt$16384$8$1$'));
  assert.equal(await verifyPassword('hafer-blau-71', h), true);
});

test('password: wrong password rejected', async () => {
  const h = await hashPassword('correct horse');
  assert.equal(await verifyPassword('correct horsE', h), false);
  assert.equal(await verifyPassword('', h), false);
});

test('password: salt differs per hash', async () => {
  const a = await hashPassword('same');
  const b = await hashPassword('same');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('same', a), true);
  assert.equal(await verifyPassword('same', b), true);
});

test('password: NFKC normalisation makes composed/decomposed umlauts match', async () => {
  // A student typing "Bühler" on iPadOS may produce the decomposed form.
  const composed = 'Bühler';
  const decomposed = 'Bühler';
  assert.notEqual(composed, decomposed);
  assert.equal(await verifyPassword(decomposed, await hashPassword(composed)), true);
});

test('password: malformed stored hash returns false rather than throwing', async () => {
  for (const bad of [
    '', 'nonsense', 'scrypt$1$2$3', 'bcrypt$1$2$3$4$5',
    'scrypt$x$8$1$AAAA$BBBB', 'scrypt$16384$8$1$$',
  ]) {
    assert.equal(await verifyPassword('x', bad), false, `should reject: ${bad}`);
  }
});

test('password: refuses to hash an empty password', async () => {
  await assert.rejects(() => hashPassword(''), /empty password/);
});

test('password: slip passwords are word-colour-word-digits', () => {
  for (let i = 0; i < 500; i++) {
    assert.match(generateSlipPassword(), /^[a-z]+-[a-z]+-[a-z]+-\d{4}$/);
  }
});

/**
 * The shape assertion above passed for the generator that produced 14.1 bits
 * while its docblock claimed 22, and `ratelimit.ts` sized the per-account
 * budget by reasoning from the claim. A format regex cannot catch that; only
 * counting can.
 *
 * Sampling, not the real count — 590 million draws is not a unit test.
 *
 * The two word lists are asserted *exactly*, which sampling can do: 20 000
 * draws is 40 000 words over 64 entries, and coupon-collector wants only
 * 64·ln(64) ≈ 266. A list an editor trimmed fails here.
 *
 * The digit range is asserted by **bounds and spread, not by exhaustion** —
 * collecting all 9000 needs ~82 000 draws (9000·ln 9000), and the first version
 * of this test asserted the full set from 20 000 and failed at 8004. The bounds
 * are what actually pin the factor of 9000; the spread catches a range quietly
 * narrowed to two digits, which is the regression that mattered.
 */
test('password: the slip alphabet is the size the entropy claim assumes', () => {
  const words = new Set();
  const colours = new Set();
  const digits = new Set();
  for (let i = 0; i < 20_000; i++) {
    const [first, colour, second, number] = generateSlipPassword().split('-');
    words.add(first);
    words.add(second);
    colours.add(colour);
    digits.add(Number(number));
    assert.match(number, /^\d{4}$/);
  }
  assert.equal(words.size, 64, 'WORDS in auth/password.ts');
  assert.equal(colours.size, 16, 'COLOURS in auth/password.ts');
  assert.ok(Math.min(...digits) >= 1000, 'digits below the 1000 floor');
  assert.ok(Math.max(...digits) <= 9999, 'digits above the 9999 ceiling');
  assert.ok(digits.size > 7500, `only ${digits.size} distinct digit groups in 20 000 draws`);

  // 64 * 16 * 64 * 9000 = 589 824 000 = 29.13 bits. Both the docblock on
  // generateSlipPassword and the one on accountLimiter quote that figure.
  const bits = Math.log2(words.size * colours.size * words.size * 9000);
  assert.ok(bits > 29, `slip entropy fell to ${bits.toFixed(2)} bits`);
});

test('password: db passwords are URL-safe and long', () => {
  const p = generateDbPassword();
  assert.match(p, /^[A-Za-z0-9_-]+$/);
  assert.ok(p.length >= 32, `length ${p.length}`);
});

test('secretbox: encrypt/decrypt round-trip', () => {
  const secret = generateDbPassword();
  assert.equal(decryptSecret(encryptSecret(secret)), secret);
});

test('secretbox: non-ASCII survives the round-trip', () => {
  const s = 'Zürich-Bühler-grün-😀';
  assert.equal(decryptSecret(encryptSecret(s)), s);
});

test('secretbox: nonce is fresh per encryption', () => {
  const a = encryptSecret('same');
  const b = encryptSecret('same');
  assert.notEqual(a, b);
  assert.equal(decryptSecret(a), 'same');
  assert.equal(decryptSecret(b), 'same');
});

test('secretbox: tampered ciphertext fails authentication', () => {
  const parts = encryptSecret('sensitive').split('.');
  const ct = Buffer.from(parts[3], 'base64url');
  ct[0] ^= 0xff;
  parts[3] = ct.toString('base64url');
  assert.throws(() => decryptSecret(parts.join('.')));
});

test('secretbox: tampered auth tag fails', () => {
  const parts = encryptSecret('sensitive').split('.');
  const tag = Buffer.from(parts[2], 'base64url');
  tag[0] ^= 0xff;
  parts[2] = tag.toString('base64url');
  assert.throws(() => decryptSecret(parts.join('.')));
});

test('secretbox: malformed envelopes rejected', () => {
  for (const bad of ['', 'v1.a.b', 'v2.a.b.c', 'v1...', 'v1.AAAA.BBBB.CCCC']) {
    assert.throws(() => decryptSecret(bad), undefined, `should throw: ${bad}`);
  }
});
