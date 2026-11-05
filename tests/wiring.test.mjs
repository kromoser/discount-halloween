// Runs the real doGet, doPost and setup from Code.gs against fake Google services.
// It can't prove the real services behave, which is what the live acceptance tests
// are for, but it catches wiring mistakes before anything is pasted into Apps Script.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadCode, source } from './load-code.mjs';
import { fakeAppsScript } from './fake-apps-script.mjs';

const PASSWORD = 'correct horse';
const VOTES_HEADER = [
  'ballot_id', 'submitted_at', 'name', 'best', 'favorite', 'most_discount',
  'runner_up', 'device_id', 'fingerprint', 'user_agent', 'void',
];

let env;
let code;

function start(options) {
  env = fakeAppsScript(options);
  code = loadCode(env.globals, ['doGet', 'doPost', 'setup']);
  code.setup();
}

const parse = (output) => {
  assert.equal(output.mime, 'application/json');
  return JSON.parse(output.text);
};
const post = (body) => parse(code.doPost({ postData: { contents: JSON.stringify(body) } }));
const postRaw = (contents) => parse(code.doPost({ postData: { contents } }));
const getState = () => parse(code.doGet({ parameter: { action: 'state' } }));
const votes = () => env.sheets.get('Votes');
const settings = () => env.sheets.get('Settings');
const clearStateCache = () => env.cache.delete('state');

function open() {
  assert.equal(post({ action: 'setStatus', password: PASSWORD, status: 'OPEN' }).ok, true);
}

let device = 0;
function ballot(overrides = {}) {
  device += 1;
  return {
    action: 'vote',
    name: 'Dana',
    picks: { best: 12, favorite: 7, most_discount: 21, runner_up: 3 },
    deviceId: `00000000-0000-4000-8000-${String(device).padStart(12, '0')}`,
    fingerprint: 'a91c04d2e8b37f10',
    userAgent: 'Mozilla/5.0',
    ...overrides,
  };
}

beforeEach(() => start());

describe('setup', () => {
  test('creates both tabs with headers and defaults', () => {
    assert.deepEqual(votes().rows, [VOTES_HEADER]);
    assert.equal(votes().frozenRows, 1);
    assert.deepEqual(settings().rows, [['status', 'SOON'], ['board_size', 30]]);
  });

  test('stores text columns as plain text, and hints at x in the void column', () => {
    const textCols = votes().formats.filter((f) => f.format === '@').map((f) => f.col);
    assert.deepEqual(textCols, [1, 2, 3, 8, 9, 10]);
    assert.equal(votes().validations.length, 1);
    assert.equal(votes().validations[0].col, 11);
    assert.deepEqual(votes().validations[0].rule.list, ['x']);
    assert.equal(votes().validations[0].rule.allowInvalid, true, 'any non-blank value must still be allowed');
  });

  test('running it again keeps votes and settings', () => {
    open();
    post(ballot());
    code.setup();
    assert.equal(votes().rows.length, 2);
    assert.equal(settings().rows[0][1], 'OPEN');
  });
});

describe('GET state', () => {
  test('returns status and board size, and no counts, before CLOSED', () => {
    assert.deepEqual(getState(), { ok: true, status: 'SOON', boardSize: 30 });
    open();
    post(ballot());
    clearStateCache();
    const raw = code.doGet({ parameter: { action: 'state' } }).text;
    assert.deepEqual(JSON.parse(raw), { ok: true, status: 'OPEN', boardSize: 30 });
  });

  test('returns results when CLOSED', () => {
    open();
    post(ballot());
    post({ action: 'setStatus', password: PASSWORD, status: 'CLOSED' });
    const res = getState();
    assert.equal(res.ballotCount, 1);
    assert.deepEqual(res.results[0], { key: 'best', label: 'Best', winners: [12], votes: 1 });
  });

  test('is cached for 10 s, and setStatus clears the cache', () => {
    getState();
    assert.deepEqual(env.spy.cachePuts.at(-1), { key: 'state', seconds: 10 });

    settings().rows[0][1] = 'OPEN'; // the host edits the cell by hand
    assert.equal(getState().status, 'SOON', 'served from cache');
    clearStateCache();
    assert.equal(getState().status, 'OPEN', 'fresh once the cache entry expires');

    post({ action: 'setStatus', password: PASSWORD, status: 'CLOSED' });
    assert.equal(getState().status, 'CLOSED', 'setStatus takes effect right away');
  });

  test('any other action is a bad request', () => {
    assert.equal(parse(code.doGet({ parameter: {} })).error, 'bad_request');
    assert.equal(parse(code.doGet({})).error, 'bad_request');
    assert.equal(parse(code.doGet(undefined)).error, 'bad_request');
  });
});

describe('POST vote', () => {
  test('appends one row and returns the ballot ID and time', () => {
    open();
    const body = ballot();
    const res = post(body);
    assert.equal(res.ok, true);
    assert.match(res.ballotId, /^b_/);
    assert.ok(res.submittedAt);

    assert.equal(votes().rows.length, 2);
    const row = votes().rows[1];
    assert.equal(row[0], res.ballotId);
    assert.equal(row[1], res.submittedAt);
    assert.deepEqual(row.slice(2, 7), ['Dana', 12, 7, 21, 3]);
    assert.equal(row[7], body.deviceId);
    assert.equal(row[8], body.fingerprint);
    assert.equal(row[9], 'Mozilla/5.0');
    assert.equal(row[10], '');
  });

  test('replaying a device ID returns already_voted and adds no row', () => {
    open();
    const body = ballot();
    assert.equal(post(body).ok, true);
    assert.equal(post(body).error, 'already_voted');
    assert.equal(votes().rows.length, 2);
  });

  test('a device whose ballot was voided still cannot vote again', () => {
    open();
    const body = ballot();
    post(body);
    votes().rows[1][10] = 'x';
    assert.equal(post(body).error, 'already_voted');
  });

  test('a new device with the same fingerprint is accepted, then flagged', () => {
    open();
    post(ballot({ name: 'Dana' }));
    assert.equal(post(ballot({ name: 'Dana R.' })).ok, true);
    const res = post({ action: 'host', password: PASSWORD });
    assert.equal(res.flagGroups.length, 1);
    assert.equal(res.flagGroups[0].length, 2);
  });

  test('returns not_open while SOON and closed while CLOSED, adding no row', () => {
    assert.equal(post(ballot()).error, 'not_open');
    post({ action: 'setStatus', password: PASSWORD, status: 'CLOSED' });
    assert.equal(post(ballot()).error, 'closed');
    assert.equal(votes().rows.length, 1);
  });

  test('reads status fresh, so a hand edit stops votes straight away despite the state cache', () => {
    open();
    getState();
    settings().rows[0][1] = 'CLOSED';
    assert.equal(post(ballot()).error, 'closed');
  });

  test('invalid_pick names the field, for the values in the acceptance test', () => {
    open();
    for (const bad of [0, 31, 'ab']) {
      const res = post(ballot({ picks: { best: 12, favorite: bad, most_discount: 21, runner_up: 3 } }));
      assert.equal(res.error, 'invalid_pick');
      assert.equal(res.field, 'favorite');
      assert.ok(res.message);
    }
    assert.equal(votes().rows.length, 1);
  });

  test('a formula-looking name and user agent are stored as text and never run', () => {
    open();
    post(ballot({ name: '=HYPERLINK("x")', userAgent: '=IMPORTXML("evil","//a")' }));
    assert.deepEqual(votes().formulasRun, []);
    assert.equal(votes().rows[1][2], '=HYPERLINK("x")');
    assert.equal(post({ action: 'host', password: PASSWORD }).ballots[0].name, '=HYPERLINK("x")');
  });

  test('tries for the lock in 1 s attempts, flushes before releasing, and always releases', () => {
    open();
    const flushesBefore = env.spy.flushes;
    post(ballot());
    assert.deepEqual(env.spy.lockTries, [1000]);
    assert.equal(env.spy.flushes, flushesBefore + 1);
    assert.equal(env.spy.lockHeld, false);

    post(ballot({ name: '' }));
    assert.equal(env.spy.lockHeld, false, 'released after a rejected ballot');

    votes().appendRow = () => { throw new Error('quota'); };
    assert.equal(post(ballot()).error, 'server_error');
    assert.equal(env.spy.lockHeld, false, 'released after an exception');
  });

  test('keeps trying while the lock is busy, then saves the vote', () => {
    open();
    env.spy.lockBusyTries = 5;
    assert.equal(post(ballot()).ok, true);
    assert.equal(env.spy.lockTries.length, 6);
    assert.equal(votes().rows.length, 2);
    assert.equal(env.spy.lockHeld, false);
  });

  test('gives up after 75 s as a server_error, and adds no row', () => {
    open();
    env.spy.lockTimesOut = true;
    assert.equal(post(ballot()).error, 'server_error');
    assert.equal(env.spy.clockMs, 75000);
    assert.equal(votes().rows.length, 1);
    assert.equal(env.spy.lockReleases, 0, 'a lock never held is not released');
  });
});

describe('POST host', () => {
  test('returns the dashboard snapshot', () => {
    open();
    post(ballot({ picks: { best: 12, favorite: 7, most_discount: 21, runner_up: 3 } }));
    post(ballot({ picks: { best: 4, favorite: 7, most_discount: 21, runner_up: 3 }, fingerprint: 'bb' }));
    votes().rows[2][10] = 'x';

    const res = post({ action: 'host', password: PASSWORD });
    assert.equal(res.ok, true);
    assert.equal(res.status, 'OPEN');
    assert.equal(res.ballotCount, 1);
    assert.equal(res.voidCount, 1);
    assert.deepEqual(res.tallies.best, [{ number: 12, votes: 1 }]);
    assert.equal(res.ballots.length, 2);
    assert.equal(res.ballots[0].void, true);
    assert.ok(res.serverTime);
  });

  test('sees rows without the state cache, so a void shows at once', () => {
    open();
    post(ballot());
    votes().rows[1][10] = 'x';
    assert.equal(post({ action: 'host', password: PASSWORD }).ballotCount, 0);
  });

  test('skips rows the host cleared by hand', () => {
    open();
    post(ballot());
    votes().rows[1] = new Array(11).fill('');
    const res = post({ action: 'host', password: PASSWORD });
    assert.equal(res.ballotCount, 0);
    assert.deepEqual(res.ballots, []);
  });
});

describe('POST setStatus', () => {
  test('writes each status to the Settings cell', () => {
    for (const status of ['OPEN', 'CLOSED', 'SOON']) {
      assert.deepEqual(post({ action: 'setStatus', password: PASSWORD, status }), { ok: true, status });
      assert.equal(settings().rows[0][1], status);
    }
  });

  test('an unknown status is a bad request and changes nothing', () => {
    for (const status of ['closed', 'NOPE', undefined, 1]) {
      assert.equal(post({ action: 'setStatus', password: PASSWORD, status }).error, 'bad_request');
    }
    assert.equal(settings().rows[0][1], 'SOON');
  });

  test('a wrong password changes nothing', () => {
    assert.equal(post({ action: 'setStatus', password: 'nope', status: 'OPEN' }).error, 'bad_password');
    assert.equal(settings().rows[0][1], 'SOON');
  });
});

describe('password handling', () => {
  test('the 11th wrong try returns too_many_attempts', () => {
    for (let i = 1; i <= 10; i += 1) {
      assert.equal(post({ action: 'host', password: 'nope' }).error, 'bad_password', `try ${i}`);
    }
    assert.equal(post({ action: 'host', password: 'nope' }).error, 'too_many_attempts');
  });

  test('failures are remembered for 10 minutes', () => {
    post({ action: 'host', password: 'nope' });
    assert.deepEqual(env.spy.cachePuts.at(-1), { key: 'host_password_failures', seconds: 600 });
  });

  test('during a lockout even the right password is refused, and the window is not extended', () => {
    for (let i = 0; i < 10; i += 1) post({ action: 'host', password: 'nope' });
    const putsBefore = env.spy.cachePuts.length;
    assert.equal(post({ action: 'host', password: PASSWORD }).error, 'too_many_attempts');
    assert.equal(post({ action: 'setStatus', password: PASSWORD, status: 'OPEN' }).error, 'too_many_attempts');
    assert.equal(post({ action: 'host', password: 'nope' }).error, 'too_many_attempts');
    assert.equal(env.spy.cachePuts.length, putsBefore);
    assert.equal(settings().rows[0][1], 'SOON');
  });

  test('the lockout lifts when the cache entry expires', () => {
    for (let i = 0; i < 10; i += 1) post({ action: 'host', password: 'nope' });
    env.cache.delete('host_password_failures');
    assert.equal(post({ action: 'host', password: PASSWORD }).ok, true);
  });

  test('a right password does not reset the failure count', () => {
    for (let i = 0; i < 9; i += 1) post({ action: 'host', password: 'nope' });
    assert.equal(post({ action: 'host', password: PASSWORD }).ok, true);
    assert.equal(post({ action: 'host', password: 'nope' }).error, 'bad_password');
    assert.equal(post({ action: 'host', password: 'nope' }).error, 'too_many_attempts');
  });

  test('with no password set, nothing unlocks: not blank, null or missing', () => {
    start({ password: null });
    for (const password of ['', null, undefined, 'null', 'anything']) {
      assert.equal(post({ action: 'host', password }).error, 'bad_password');
    }
  });

  test('non-string passwords do not match', () => {
    for (const password of [true, 0, [PASSWORD], { a: 1 }]) {
      assert.equal(post({ action: 'host', password }).error, 'bad_password');
    }
  });
});

describe('request handling', () => {
  test('malformed bodies are bad requests, not server errors', () => {
    assert.equal(postRaw('not json').error, 'bad_request');
    assert.equal(postRaw('[1,2]').error, 'bad_request');
    assert.equal(parse(code.doPost({})).error, 'bad_request');
    assert.equal(parse(code.doPost(undefined)).error, 'bad_request');
  });

  test('an unknown action is a bad request', () => {
    assert.equal(post({ action: 'nope' }).error, 'bad_request');
  });

  test('any exception becomes server_error with a message, and is logged', () => {
    env.sheets.delete('Settings');
    const res = post(ballot());
    assert.equal(res.ok, false);
    assert.equal(res.error, 'server_error');
    assert.ok(res.message);
    assert.equal(env.spy.errors.length, 1);
    assert.equal(getState().error, 'server_error');
  });

  test('errors always carry ok, error and message', () => {
    const res = post({ action: 'host', password: 'nope' });
    assert.deepEqual(Object.keys(res).sort(), ['error', 'message', 'ok']);
  });

  test('finds the Sheet by its stored ID if there is no active spreadsheet', () => {
    env.spy.active = false;
    assert.equal(getState().status, 'SOON');
  });
});

describe('Apps Script compatibility', () => {
  const code_only = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  for (const [what, pattern] of [
    ['require', /\brequire\s*\(/],
    ['import', /^\s*import\s/m],
    ['export', /^\s*export\s/m],
    ['process', /\bprocess\./],
    ['Buffer', /\bBuffer\b/],
    ['setTimeout', /\bsetTimeout\b/],
    ['fetch', /\bfetch\s*\(/],
    ['window or document', /\b(window|document)\./],
    ['globalThis', /\bglobalThis\b/],
    ['async code', /\b(async|await)\b/],
  ]) {
    test(`uses no ${what}`, () => {
      assert.equal(pattern.test(code_only), false);
    });
  }

  test('only touches the Google services the fake models', () => {
    const used = new Set(code_only.match(/\b[A-Z][a-zA-Z]+(?:App|Service)\b/g));
    assert.deepEqual([...used].sort(), [
      'CacheService', 'ContentService', 'LockService', 'PropertiesService', 'SpreadsheetApp',
    ]);
  });

  test('never contains a password', () => {
    // A literal assigned to anything named password. The word boundary skips the
    // error code key bad_password in MESSAGES.
    assert.equal(/\bpassword\s*[:=]\s*['"]/i.test(code_only), false);
    assert.match(source, /const PASSWORD_PROPERTY = 'HOST_PASSWORD';/);
    assert.match(source, /getProperty\(PASSWORD_PROPERTY\)/);
  });

  // Otherwise a phone gives up on a vote the server then accepts, and the guest's
  // retry gets already_voted instead of a receipt.
  // Live, a vote answered 12 s after its lock wait should have ended, so a bare "longer" isn't enough.
  test('a phone waits at least 20 s longer for a vote than the server waits for the lock', () => {
    const api = readFileSync(new URL('../assets/api.js', import.meta.url), 'utf8');
    const lockMs = Number(source.match(/const LOCK_WAIT_MS = (\d+);/)[1]);
    const voteMs = Number(api.match(/const VOTE_TIMEOUT_MS = (\d+);/)[1]);
    assert.ok(voteMs - lockMs >= 20000, `VOTE_TIMEOUT_MS ${voteMs} must be 20 s past LOCK_WAIT_MS ${lockMs}`);
  });
});
