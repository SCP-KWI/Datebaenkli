/**
 * The watchdog's bookkeeping, against a recording fake.
 *
 * What is provable without a server: that the deadline fires once, that the
 * escalation to `pg_terminate_backend` only happens when the cancel did not end
 * the query, that disarming reports accurately enough for the runner to decide
 * whether the connection can go back to the pool, and that a cancel reaches
 * exactly the caller's own queries.
 *
 * What is NOT provable here, and lives in query.live.test.mjs instead: that the
 * SQL this file records actually cancels anything. It does not, if issued the
 * obvious way — `dbk_app` holds student roles NOINHERIT, so a bare
 * `pg_cancel_backend` is refused with 42501. That is why the assertions below
 * check for the `set_config('role', …)` that precedes the signal, and not just
 * for the signal.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { dist } from './support/meta-db.mjs';

const { makeWatchdog } = await import(dist('services/watchdog.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A `Db` that records statements instead of running them. */
function recordingDb({ signalReturns = true } = {}) {
  const calls = [];
  const query = async (text, values) => {
    calls.push({ text, values });
    return { rows: [{ ok: signalReturns }], rowCount: 1 };
  };
  return { calls, query, tx: (fn) => fn({ query }) };
}

const silent = { warn() {}, error() {} };

/** The signal statements only, as `['pg_cancel_backend', …]`. */
const signals = (db) =>
  db.calls
    .filter((c) => c.text.includes('_backend('))
    .map((c) => ({ fn: c.text.match(/pg_\w+_backend/)[0], pid: c.values[0] }));

const ROLE_SETS = (db) =>
  db.calls.filter((c) => c.text.includes('set_config')).map((c) => c.values);

test('a query that finishes in time is never signalled', async () => {
  const db = recordingDb();
  const wd = makeWatchdog(db, silent, 20);

  const armed = wd.arm({ userId: 1, pgRole: 'u_a', pid: 111, timeoutMs: 10_000 });
  assert.equal(wd.active().length, 1);
  const disposition = armed.disarm();

  assert.deepEqual(disposition, { signalled: false });
  assert.deepEqual(signals(db), []);
  assert.equal(wd.active().length, 0, 'disarm must drop the entry');
});

test('the deadline cancels, stepping into the role first', async () => {
  const db = recordingDb();
  const wd = makeWatchdog(db, silent, 10_000);

  const armed = wd.arm({ userId: 1, pgRole: 'u_muster_lena', pid: 4242, timeoutMs: 20 });
  await sleep(60);

  assert.deepEqual(signals(db), [{ fn: 'pg_cancel_backend', pid: 4242 }]);
  // The whole reason the watchdog works: SET LOCAL ROLE, by bind parameter,
  // because dbk_app has no privileges on the student role it holds NOINHERIT.
  assert.deepEqual(ROLE_SETS(db), [['role', 'u_muster_lena']]);

  assert.deepEqual(armed.disarm(), {
    signalled: true,
    reason: 'timeout',
    terminated: false,
  });
});

test('a backend that ignores the cancel is terminated after the grace', async () => {
  const db = recordingDb();
  const wd = makeWatchdog(db, silent, 30);

  const armed = wd.arm({ userId: 1, pgRole: 'u_a', pid: 77, timeoutMs: 10 });
  await sleep(120);

  assert.deepEqual(signals(db), [
    { fn: 'pg_cancel_backend', pid: 77 },
    { fn: 'pg_terminate_backend', pid: 77 },
  ]);
  const disposition = armed.disarm();
  assert.equal(disposition.terminated, true, 'the runner must destroy this connection');
});

test('a query that ends during the grace is not terminated', async () => {
  const db = recordingDb();
  const wd = makeWatchdog(db, silent, 200);

  const armed = wd.arm({ userId: 1, pgRole: 'u_a', pid: 88, timeoutMs: 10 });
  await sleep(60); // cancel has gone out; the escalation has not
  const disposition = armed.disarm();
  await sleep(250); // long enough that a surviving escalation timer would fire

  assert.deepEqual(signals(db), [{ fn: 'pg_cancel_backend', pid: 88 }]);
  assert.equal(disposition.terminated, false, 'the connection is still usable');
});

test('cancel reaches only the caller’s own queries', async () => {
  const db = recordingDb();
  const wd = makeWatchdog(db, silent, 10_000);

  const lena = wd.arm({ userId: 1, pgRole: 'u_lena', pid: 11, timeoutMs: 10_000 });
  const alsoLena = wd.arm({ userId: 1, pgRole: 'u_lena', pid: 12, timeoutMs: 10_000 });
  const tim = wd.arm({ userId: 2, pgRole: 'u_tim', pid: 21, timeoutMs: 10_000 });

  assert.equal(await wd.cancelUser(1), 2);
  assert.deepEqual(
    signals(db).map((s) => s.pid).sort(),
    [11, 12],
    'Tim’s query must be untouched',
  );
  assert.equal(lena.disarm().reason, 'user');
  assert.equal(alsoLena.disarm().reason, 'user');
  assert.deepEqual(tim.disarm(), { signalled: false });
});

test('cancelling twice signals once, and cancelling nothing is not an error', async () => {
  const db = recordingDb();
  const wd = makeWatchdog(db, silent, 10_000);

  const armed = wd.arm({ userId: 1, pgRole: 'u_a', pid: 11, timeoutMs: 10_000 });
  assert.equal(await wd.cancelUser(1), 1);
  assert.equal(await wd.cancelUser(1), 0, 'already stopping — do not signal a second time');
  assert.equal(signals(db).length, 1);

  armed.disarm();
  assert.equal(await wd.cancelUser(1), 0, 'nothing running');
  assert.equal(await wd.cancelUser(999), 0, 'no such user');
});

test('disarming while the cancel is in flight cancels the escalation too', async () => {
  // The regression this pins: the cancel is usually what ends the query, so the
  // runner disarms while `fire()` is still awaiting the round trip — before the
  // escalation timer exists. Arming it afterwards leaves a timer nothing holds
  // a handle to, which fires later and terminates whatever that pid has become:
  // in a pool, the same student's *next* query. Found by the live suite, as an
  // "Error: Connection terminated unexpectedly" on an idle pooled connection.
  let releaseSignal;
  const gate = new Promise((r) => (releaseSignal = r));
  const calls = [];
  const query = async (text, values) => {
    calls.push({ text, values });
    if (text.includes('_backend(')) await gate;
    return { rows: [{ ok: true }], rowCount: 1 };
  };
  const db = { calls, query, tx: (fn) => fn({ query }) };
  const wd = makeWatchdog(db, silent, 20);

  const armed = wd.arm({ userId: 1, pgRole: 'u_a', pid: 99, timeoutMs: 10 });
  await sleep(40); // the deadline has fired and is blocked inside the cancel

  const disposition = armed.disarm(); // the query ended on its own, right now
  releaseSignal();
  await sleep(120); // well past the 20ms escalation grace

  assert.deepEqual(
    signals(db),
    [{ fn: 'pg_cancel_backend', pid: 99 }],
    'must not terminate a pid the runner has already released',
  );
  assert.equal(disposition.terminated, false);
});

test('a signal that throws does not escape the timer', async () => {
  const db = {
    calls: [],
    query: async () => {
      throw new Error('teach database is down');
    },
    tx: async () => {
      throw new Error('teach database is down');
    },
  };
  const wd = makeWatchdog(db, silent, 10_000);

  const armed = wd.arm({ userId: 1, pgRole: 'u_a', pid: 11, timeoutMs: 10 });
  await sleep(50);

  // Nothing rejected, and the entry still reports as signalled so the runner
  // does not mistake a failed cancel for a query that finished on its own.
  assert.equal(armed.disarm().signalled, true);
  assert.equal(await wd.cancelUser(1), 0);
});
