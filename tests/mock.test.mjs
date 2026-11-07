// The mock must behave like the backend, or a UI tested against it proves nothing.
// These tests send the same requests to both and compare. Times and IDs differ, so
// only the shape and the rules are compared where those are involved.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadCode } from './load-code.mjs';
import { fakeAppsScript } from './fake-apps-script.mjs';

// The mock keeps its state in localStorage. A plain stand-in is enough here.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};

const { backend, controls, ERROR_CODES, MOCK_PASSWORD } = await import('../assets/mock-api.js');

const PASSWORD = 'correct horse';

function realBackend() {
  const env = fakeAppsScript({ password: PASSWORD });
  const code = loadCode(env.globals, ['doGet', 'doPost', 'setup']);
  code.setup();
  return {
    getState: async (ref) => {
      env.cache.delete('state');
      env.cache.delete('unlocks');
      const parameter = ref ? { action: 'state', ref } : { action: 'state' };
      return JSON.parse(code.doGet({ parameter }).text);
    },
    post: async (body) => JSON.parse(code.doPost({ postData: { contents: JSON.stringify(body) } }).text),
  };
}

let real;

// Sends a request to both, swapping in each side's password.
async function both(body) {
  const withPass = (password) => (body.password === 'RIGHT' ? { ...body, password } : body);
  const [mine, theirs] = await Promise.all([
    backend.post(withPass(MOCK_PASSWORD)),
    real.post(withPass(PASSWORD)),
  ]);
  return [mine, theirs];
}

async function bothSetStatus(status) {
  return both({ action: 'setStatus', password: 'RIGHT', status });
}

beforeEach(() => {
  store.clear();
  controls.reset();
  controls.clearBallots();
  controls.setStatus('SOON');
  real = realBackend();
});

let n = 0;
function ballot(overrides = {}) {
  n += 1;
  return {
    action: 'vote',
    name: 'Dana',
    picks: { best: 12, favorite: 7, most_discount: 21, runner_up: 3 },
    deviceId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    fingerprint: 'a91c04d2e8b37f10',
    userAgent: 'Mozilla/5.0',
    ...overrides,
  };
}

// IDs and times can't match, so swap them for placeholders, keeping which ID is which.
function comparable(res) {
  const ids = new Map();
  const idFor = (id) => {
    if (!ids.has(id)) ids.set(id, `id${ids.size}`);
    return ids.get(id);
  };
  const copy = JSON.parse(JSON.stringify(res));
  if (copy.ballotId) copy.ballotId = idFor(copy.ballotId);
  if (copy.submittedAt) copy.submittedAt = 'time';
  if (copy.serverTime) copy.serverTime = 'time';
  if (copy.ballots) {
    copy.ballots.forEach((b) => {
      b.ballotId = idFor(b.ballotId);
      b.submittedAt = 'time';
    });
  }
  if (copy.flagGroups) copy.flagGroups = copy.flagGroups.map((g) => g.map(idFor));
  return copy;
}

async function assertSame(body, label) {
  const [mine, theirs] = await both(body);
  assert.deepEqual(comparable(mine), comparable(theirs), label);
  return mine;
}

describe('parity with Code.gs', () => {
  test('state in each status, including with votes and voids', async () => {
    assert.deepEqual(await backend.getState(), await real.getState());
    await bothSetStatus('OPEN');
    assert.deepEqual(await backend.getState(), await real.getState());
    await assertSame(ballot());
    await assertSame(ballot({ picks: { best: 12, favorite: 8, most_discount: 21, runner_up: 3 } }));
    await assertSame(ballot({ picks: { best: 4, favorite: 8, most_discount: 2, runner_up: 18 } }));
    await assertSame(ballot({ picks: { best: 4, favorite: 9, most_discount: 2, runner_up: 18 } }));
    assert.deepEqual(await backend.getState(), await real.getState());
    await bothSetStatus('CLOSED');
    const state = await backend.getState();
    assert.deepEqual(state, await real.getState());
    assert.deepEqual(state, { ok: true, status: 'CLOSED', boardSize: 30 });
  });

  test('every vote outcome, in the same order of checks', async () => {
    await assertSame(ballot(), 'not_open');
    await bothSetStatus('OPEN');

    const cases = {
      'valid ballot': ballot(),
      'bad device': ballot({ deviceId: 'nope' }),
      'bad fingerprint': ballot({ fingerprint: 'xyz' }),
      'missing name': ballot({ name: '' }),
      'blank name': ballot({ name: '   ' }),
      'long name': ballot({ name: 'x'.repeat(41) }),
      'number name': ballot({ name: 7 }),
      'pick 0': ballot({ picks: { best: 0, favorite: 7, most_discount: 21, runner_up: 3 } }),
      'pick 31': ballot({ picks: { best: 12, favorite: 31, most_discount: 21, runner_up: 3 } }),
      'pick ab': ballot({ picks: { best: 12, favorite: 7, most_discount: 'ab', runner_up: 3 } }),
      'pick 1.5': ballot({ picks: { best: 12, favorite: 7, most_discount: 21, runner_up: 1.5 } }),
      'pick as text': ballot({ picks: { best: '12', favorite: 7, most_discount: 21, runner_up: 3 } }),
      'no picks': ballot({ picks: undefined }),
      'all bad': ballot({ deviceId: 'nope', name: '', picks: {} }),
    };
    for (const [label, body] of Object.entries(cases)) {
      await assertSame(body, label);
    }

    const replay = ballot();
    await assertSame(replay, 'first of a pair');
    const again = await assertSame(replay, 'replay');
    assert.equal(again.error, 'already_voted');

    await bothSetStatus('CLOSED');
    const closed = await assertSame(ballot(), 'closed');
    assert.equal(closed.error, 'closed');
  });

  test('host snapshot, with a flag group and a void', async () => {
    await bothSetStatus('OPEN');
    await assertSame(ballot({ name: 'Dana' }));
    await assertSame(ballot({ name: 'Priya', fingerprint: 'bbbb' }));
    await assertSame(ballot({ name: 'Dana R.' }));
    const res = await assertSame({ action: 'host', password: 'RIGHT' });
    assert.equal(res.ballotCount, 3);
    assert.equal(res.flagGroups.length, 1);
  });

  test('setStatus outcomes', async () => {
    for (const status of ['OPEN', 'CLOSED', 'SOON', 'nope', undefined]) {
      await assertSame({ action: 'setStatus', password: 'RIGHT', status }, String(status));
    }
    await assertSame({ action: 'setStatus', password: 'wrong', status: 'OPEN' });
  });

  describe('unlock', () => {
    // Ballot IDs differ between the two, so each side is told its own.
    async function unlockBoth(ids, password = 'RIGHT') {
      const send = (ballotId, right) => ({
        action: 'unlock',
        ballotId,
        password: password === 'RIGHT' ? right : password,
      });
      return [
        await backend.post(send(ids[0], MOCK_PASSWORD)),
        await real.post(send(ids[1], PASSWORD)),
      ];
    }
    const idsOf = ([mine, theirs]) => [mine.ballotId, theirs.ballotId];

    test('a ballot, its state answer and the next vote all match', async () => {
      await bothSetStatus('OPEN');
      const body = ballot();
      const first = idsOf(await both(body));

      const [mine, theirs] = await unlockBoth(first);
      assert.deepEqual(comparable(mine), comparable(theirs));
      assert.equal(mine.ok, true);

      assert.deepEqual(await backend.getState(first[0]), await real.getState(first[1]));
      assert.equal((await backend.getState(first[0])).unlocked, true);
      assert.deepEqual(await backend.getState(body.deviceId), await real.getState(body.deviceId));
      assert.equal((await backend.getState(body.deviceId)).unlocked, true);
      assert.deepEqual(await backend.getState('junk'), await real.getState('junk'));
      assert.deepEqual(await backend.getState(), await real.getState());

      await assertSame({ action: 'host', password: 'RIGHT' }, 'host snapshot');

      const second = idsOf(await both(body));
      assert.deepEqual(await backend.getState(second[0]), await real.getState(second[1]));
      assert.equal((await backend.getState(second[0])).unlocked, undefined);
      assert.deepEqual(await backend.getState(body.deviceId), await real.getState(body.deviceId));
      assert.equal((await backend.getState(body.deviceId)).unlocked, undefined);
      assert.equal((await assertSame(body, 'locked again')).error, 'already_voted');
    });

    test('refusals match', async () => {
      await bothSetStatus('OPEN');
      const ids = idsOf(await both(ballot()));

      for (const id of ['b_nope', '', undefined, 7]) {
        const [mine, theirs] = await unlockBoth([id, id]);
        assert.deepEqual(mine, theirs, String(id));
        assert.equal(mine.error, 'bad_request');
      }

      const [wrongMine, wrongTheirs] = await unlockBoth(ids, 'wrong');
      assert.deepEqual(wrongMine, wrongTheirs);
      assert.equal(wrongMine.error, 'bad_password');

      await bothSetStatus('CLOSED');
      const [closedMine, closedTheirs] = await unlockBoth(ids);
      assert.deepEqual(closedMine, closedTheirs);
      assert.equal(closedMine.error, 'closed');
    });
  });

  test('password failures lock out on the same try', async () => {
    for (let i = 1; i <= 12; i += 1) {
      await assertSame({ action: 'host', password: 'wrong' }, `try ${i}`);
    }
    const res = await assertSame({ action: 'host', password: 'RIGHT' }, 'right password during lockout');
    assert.equal(res.error, 'too_many_attempts');
  });

  test('unknown action', async () => {
    await assertSame({ action: 'nope' });
  });
});

describe('mock mode', () => {
  beforeEach(() => {
    store.clear();
    controls.reset();
  });

  test('is seeded with 27 ballots, two flagged, and the mockup tallies', async () => {
    const res = await backend.post({ action: 'host', password: MOCK_PASSWORD });
    assert.equal(res.ballotCount, 27);
    assert.equal(res.voidCount, 1);
    assert.equal(res.flagGroups.length, 1);
    assert.equal(res.flagGroups[0].length, 2);

    const top = (key, count) => res.tallies[key].slice(0, count).map((t) => [t.number, t.votes]);
    assert.deepEqual(top('best', 3), [[12, 11], [4, 7], [19, 5]]);
    assert.deepEqual(top('favorite', 3), [[7, 9], [12, 8], [25, 4]]);
    assert.deepEqual(top('most_discount', 3), [[21, 13], [9, 6], [2, 3]]);
    assert.deepEqual(top('runner_up', 3), [[3, 6], [18, 6], [12, 4]]);
  });

  test('the newest seeded ballots match the mockup', async () => {
    const res = await backend.post({ action: 'host', password: MOCK_PASSWORD });
    const newest = res.ballots.slice(0, 6).map((b) => b.name);
    assert.deepEqual(newest, ['Theo', 'Dana', 'Jules', 'Dana R.', 'Priya', 'Marcus']);
  });

  test('state stays free of counts in every status', async () => {
    assert.deepEqual(await backend.getState(), { ok: true, status: 'OPEN', boardSize: 30 });
    controls.setStatus('SOON');
    assert.deepEqual(await backend.getState(), { ok: true, status: 'SOON', boardSize: 30 });
    controls.setStatus('CLOSED');
    assert.deepEqual(await backend.getState(), { ok: true, status: 'CLOSED', boardSize: 30 });
  });

  test('state persists in localStorage, so tabs share it', async () => {
    controls.setStatus('CLOSED');
    assert.equal(JSON.parse(store.get('dh.mock')).status, 'CLOSED');
  });

  for (const code of ERROR_CODES) {
    test(`can force ${code}, for one call only`, async () => {
      controls.failNext(code);
      const res = await backend.post({ action: 'host', password: MOCK_PASSWORD });
      assert.equal(res.ok, false);
      assert.equal(res.error, code);
      assert.ok(res.message);
      assert.equal((await backend.post({ action: 'host', password: MOCK_PASSWORD })).ok, true);
    });
  }

  test('a forced invalid_pick names a field', async () => {
    controls.failNext('invalid_pick');
    assert.equal((await backend.post(ballot())).field, 'best');
  });

  test('can force a network failure on any call', async () => {
    controls.failNext('network');
    await assert.rejects(backend.getState());
    assert.equal((await backend.getState()).ok, true);
    controls.failNext('network');
    await assert.rejects(backend.post(ballot()));
  });

  test('voiding a ballot drops it from tallies and counts', async () => {
    const before = await backend.post({ action: 'host', password: MOCK_PASSWORD });
    controls.toggleVoid(before.ballots[0].ballotId);
    const after = await backend.post({ action: 'host', password: MOCK_PASSWORD });
    assert.equal(after.ballotCount, 26);
    assert.equal(after.voidCount, 2);
    assert.equal(after.ballots[0].void, true);
  });

  test('a lockout can be cleared', async () => {
    for (let i = 0; i < 10; i += 1) await backend.post({ action: 'host', password: 'wrong' });
    assert.equal((await backend.post({ action: 'host', password: MOCK_PASSWORD })).error, 'too_many_attempts');
    controls.clearLockout();
    assert.equal((await backend.post({ action: 'host', password: MOCK_PASSWORD })).ok, true);
  });
});
