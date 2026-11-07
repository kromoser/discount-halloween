// Pure backend logic from apps-script/Code.gs. Run with: node --test

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadCode } from './load-code.mjs';

const {
  CATEGORIES, COLS, sanitizeName, validateBallot, hasDevice, checkVote, buildRow, tally,
  flagGroups, stateResponse, hostResponse, normalizeSettings, parseBody, unlockedRefs,
} = loadCode();

const DEVICE = '5b0e9c1a-1111-4222-8333-444455556666';

function ballot(overrides = {}) {
  return {
    action: 'vote',
    name: 'Dana',
    picks: { best: 12, favorite: 7, most_discount: 21, runner_up: 3 },
    deviceId: DEVICE,
    fingerprint: 'a91c04d2e8b37f10',
    userAgent: 'Mozilla/5.0',
    ...overrides,
  };
}

let counter = 0;
function row({ id, name = 'Guest', picks = [1, 2, 3, 4], print, device, isVoid = '', at = '2026-10-31T21:00:00-04:00' } = {}) {
  counter += 1;
  const r = new Array(Object.keys(COLS).length).fill('');
  r[COLS.ballot_id] = id || `b_${counter}`;
  r[COLS.submitted_at] = at;
  r[COLS.name] = name;
  CATEGORIES.forEach((cat, i) => { r[COLS[cat.key]] = picks[i]; });
  r[COLS.device_id] = device || `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
  r[COLS.fingerprint] = print || `f${counter}`;
  r[COLS.user_agent] = 'UA';
  r[COLS.void] = isVoid;
  return r;
}

const OPEN = { status: 'OPEN', boardSize: 30 };
const SOON = { status: 'SOON', boardSize: 30 };
const CLOSED = { status: 'CLOSED', boardSize: 30 };

describe('constants', () => {
  test('categories are in the agreed order', () => {
    assert.deepEqual(CATEGORIES.map((c) => c.label), ['Best', 'Favorite', 'Most discount', 'Runner up']);
  });

  test('column map matches the Votes tab layout in the plan', () => {
    assert.deepEqual(Object.keys(COLS), [
      'ballot_id', 'submitted_at', 'name', 'best', 'favorite', 'most_discount',
      'runner_up', 'device_id', 'fingerprint', 'user_agent', 'void',
    ]);
    assert.deepEqual(Object.values(COLS), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

describe('sanitizeName', () => {
  test('trims and removes control characters', () => {
    assert.equal(sanitizeName('  Da\u0000na\n\t '), 'Dana');
  });

  for (const lead of ['=', '+', '-', '@']) {
    test(`prefixes a name starting with ${lead}`, () => {
      assert.equal(sanitizeName(`${lead}x`), `'${lead}x`);
    });
  }

  test('a formula-looking name becomes text', () => {
    assert.equal(sanitizeName('=HYPERLINK("x")'), `'=HYPERLINK("x")`);
  });

  test('a formula hidden behind whitespace or control characters is still caught', () => {
    assert.equal(sanitizeName(' \t=1+1'), "'=1+1");
    assert.equal(sanitizeName('\u0007=1+1'), "'=1+1");
  });

  test('leaves ordinary names alone', () => {
    assert.equal(sanitizeName('Dana R.'), 'Dana R.');
    assert.equal(sanitizeName('Zoë 🎃'), 'Zoë 🎃');
  });

  test('non-strings become empty', () => {
    for (const v of [undefined, null, 42, {}, []]) assert.equal(sanitizeName(v), '');
  });
});

describe('validateBallot', () => {
  test('accepts a valid ballot and returns clean values', () => {
    const r = validateBallot(ballot(), 30);
    assert.equal(r.ok, true);
    assert.deepEqual(r.clean, {
      name: 'Dana',
      picks: { best: 12, favorite: 7, most_discount: 21, runner_up: 3 },
      deviceId: DEVICE,
      fingerprint: 'a91c04d2e8b37f10',
      userAgent: 'Mozilla/5.0',
    });
  });

  test('the same number may appear in more than one category', () => {
    const picks = { best: 7, favorite: 7, most_discount: 7, runner_up: 7 };
    assert.equal(validateBallot(ballot({ picks }), 30).ok, true);
  });

  test('accepts the board edges', () => {
    const picks = { best: 1, favorite: 30, most_discount: 1, runner_up: 30 };
    assert.equal(validateBallot(ballot({ picks }), 30).ok, true);
  });

  for (const deviceId of ['nope', '', undefined, 12345, '5b0e9c1a-1111-4222-8333-44445555666']) {
    test(`rejects device ID ${JSON.stringify(deviceId)}`, () => {
      assert.equal(validateBallot(ballot({ deviceId }), 30).error, 'bad_request');
    });
  }

  for (const fingerprint of ['', 'xyz', 'a'.repeat(65), undefined, 123]) {
    test(`rejects fingerprint ${JSON.stringify(fingerprint)}`, () => {
      assert.equal(validateBallot(ballot({ fingerprint }), 30).error, 'bad_request');
    });
  }

  test('a fingerprint of 1 and of 64 hex characters is fine', () => {
    assert.equal(validateBallot(ballot({ fingerprint: 'a' }), 30).ok, true);
    assert.equal(validateBallot(ballot({ fingerprint: 'f'.repeat(64) }), 30).ok, true);
  });

  for (const name of ['', '   ', '\u0000\u0001', 'x'.repeat(41), undefined, 7]) {
    test(`rejects name ${JSON.stringify(name)}`, () => {
      assert.equal(validateBallot(ballot({ name }), 30).error, 'invalid_name');
    });
  }

  test('40 characters is allowed, and the formula prefix does not count toward it', () => {
    assert.equal(validateBallot(ballot({ name: 'x'.repeat(40) }), 30).ok, true);
    const r = validateBallot(ballot({ name: '=' + 'x'.repeat(39) }), 30);
    assert.equal(r.ok, true);
    assert.equal(r.clean.name, "'=" + 'x'.repeat(39));
  });

  for (const bad of [0, 31, -1, 1.5, '12', 'ab', null, undefined, true, [], NaN]) {
    test(`rejects pick ${JSON.stringify(bad) ?? 'undefined'} and names the field`, () => {
      const picks = { best: 12, favorite: 7, most_discount: bad, runner_up: 3 };
      const r = validateBallot(ballot({ picks }), 30);
      assert.equal(r.error, 'invalid_pick');
      assert.equal(r.field, 'most_discount');
    });
  }

  test('reports the first bad pick in category order', () => {
    const picks = { best: 12, favorite: 99, most_discount: 99, runner_up: 99 };
    assert.equal(validateBallot(ballot({ picks }), 30).field, 'favorite');
  });

  test('missing picks reports the first category', () => {
    const r = validateBallot(ballot({ picks: undefined }), 30);
    assert.equal(r.error, 'invalid_pick');
    assert.equal(r.field, 'best');
  });

  test('range follows board size', () => {
    const picks = { best: 31, favorite: 7, most_discount: 21, runner_up: 3 };
    assert.equal(validateBallot(ballot({ picks }), 40).ok, true);
    const small = { best: 12, favorite: 7, most_discount: 21, runner_up: 3 };
    assert.equal(validateBallot(ballot({ picks: small }), 10).field, 'best');
  });

  test('guards a formula in the user agent and caps its length', () => {
    assert.equal(validateBallot(ballot({ userAgent: '=IMPORTXML("x")' }), 30).clean.userAgent, `'=IMPORTXML("x")`);
    assert.equal(validateBallot(ballot({ userAgent: 'u'.repeat(1000) }), 30).clean.userAgent.length, 400);
    assert.equal(validateBallot(ballot({ userAgent: undefined }), 30).clean.userAgent, '');
  });

  test('a non-object body is a bad request', () => {
    for (const body of [null, undefined, 'x', 3]) {
      assert.equal(validateBallot(body, 30).error, 'bad_request');
    }
  });
});

describe('checkVote', () => {
  test('passes a valid ballot while OPEN', () => {
    assert.equal(checkVote(OPEN, [], ballot()).ok, true);
  });

  test('status is checked first: not_open while SOON, closed while CLOSED', () => {
    const invalid = ballot({ name: '', deviceId: 'nope' });
    assert.equal(checkVote(SOON, [], invalid).error, 'not_open');
    assert.equal(checkVote(CLOSED, [], invalid).error, 'closed');
  });

  test('checks run in contract order', () => {
    const allBad = ballot({ deviceId: 'nope', name: '', picks: {} });
    assert.equal(checkVote(OPEN, [], allBad).error, 'bad_request');
    assert.equal(checkVote(OPEN, [], ballot({ name: '', picks: {} })).error, 'invalid_name');
    assert.equal(checkVote(OPEN, [row({ device: DEVICE })], ballot({ picks: {} })).error, 'invalid_pick');
  });

  test('a duplicate device ID is rejected', () => {
    assert.equal(checkVote(OPEN, [row({ device: DEVICE })], ballot()).error, 'already_voted');
  });

  test('a void row still blocks its device from voting again', () => {
    assert.equal(checkVote(OPEN, [row({ device: DEVICE, isVoid: 'x' })], ballot()).error, 'already_voted');
  });

  test('device IDs compare without regard to case', () => {
    assert.equal(hasDevice([row({ device: DEVICE })], DEVICE.toUpperCase()), true);
    assert.equal(checkVote(OPEN, [row({ device: DEVICE })], ballot({ deviceId: DEVICE.toUpperCase() })).error, 'already_voted');
  });

  test('another device on the same fingerprint is accepted, since fingerprints only flag', () => {
    const rows = [row({ print: 'a91c04d2e8b37f10' })];
    assert.equal(checkVote(OPEN, rows, ballot()).ok, true);
  });
});

describe('unlocked ballots', () => {
  test('an unlocked row stops blocking its device, however the mark is typed', () => {
    for (const mark of ['unlocked', 'UNLOCKED', ' Unlocked ']) {
      const rows = [row({ device: DEVICE, isVoid: mark })];
      assert.equal(hasDevice(rows, DEVICE), false, mark);
      assert.equal(checkVote(OPEN, rows, ballot()).ok, true, mark);
    }
  });

  test('the same device is blocked again once its new ballot is in', () => {
    const rows = [row({ device: DEVICE, isVoid: 'unlocked' }), row({ device: DEVICE })];
    assert.equal(checkVote(OPEN, rows, ballot()).error, 'already_voted');
  });

  test('an unlocked ballot counts for nothing', () => {
    const rows = [row({ picks: [12, 1, 1, 1], isVoid: 'unlocked' }), row({ picks: [4, 1, 1, 1] })];
    assert.deepEqual(tally(rows).best, [{ number: 4, votes: 1 }]);
    assert.equal(hostResponse(OPEN, rows, 'now').ballotCount, 1);
    assert.equal(hostResponse(OPEN, rows, 'now').voidCount, 1);
  });

  test('an unlocked ballot is never flagged as a same-phone match for the new one', () => {
    const rows = [row({ print: 'same', isVoid: 'unlocked' }), row({ print: 'same' })];
    assert.deepEqual(flagGroups(rows), []);
  });

  test('the host snapshot tells unlocked from a plain void', () => {
    const rows = [row({ id: 'a' }), row({ id: 'b', isVoid: 'x' }), row({ id: 'c', isVoid: 'unlocked' })];
    const byId = Object.fromEntries(hostResponse(OPEN, rows, 'now').ballots.map((b) => [b.ballotId, b]));
    assert.deepEqual([byId.a.void, byId.a.unlocked], [false, false]);
    assert.deepEqual([byId.b.void, byId.b.unlocked], [true, false]);
    assert.deepEqual([byId.c.void, byId.c.unlocked], [true, true]);
  });

  test('unlockedRefs lists the ballot and its device', () => {
    const rows = [row({ id: 'b_old', device: DEVICE, isVoid: 'unlocked' })];
    assert.deepEqual(unlockedRefs(rows), ['b_old', DEVICE]);
  });

  test('unlockedRefs drops the device once it has a new ballot, and never lists the new ballot', () => {
    const rows = [
      row({ id: 'b_old', device: DEVICE, isVoid: 'unlocked' }),
      row({ id: 'b_new', device: DEVICE }),
    ];
    assert.deepEqual(unlockedRefs(rows), ['b_old']);
  });

  test('unlockedRefs leaves out plain voids and live ballots, whose phones stay locked', () => {
    assert.deepEqual(unlockedRefs([row({ id: 'a' }), row({ id: 'b', isVoid: 'x' })]), []);
  });
});

describe('buildRow', () => {
  test('puts each value in its named column, leaving void blank', () => {
    const { clean } = validateBallot(ballot(), 30);
    const r = buildRow(clean, 'b_1', '2026-10-31T21:41:07-04:00');
    assert.equal(r.length, 11);
    assert.equal(r[COLS.ballot_id], 'b_1');
    assert.equal(r[COLS.submitted_at], '2026-10-31T21:41:07-04:00');
    assert.equal(r[COLS.name], 'Dana');
    assert.equal(r[COLS.best], 12);
    assert.equal(r[COLS.favorite], 7);
    assert.equal(r[COLS.most_discount], 21);
    assert.equal(r[COLS.runner_up], 3);
    assert.equal(r[COLS.device_id], DEVICE);
    assert.equal(r[COLS.fingerprint], 'a91c04d2e8b37f10');
    assert.equal(r[COLS.user_agent], 'Mozilla/5.0');
    assert.equal(r[COLS.void], '');
  });
});

describe('tally', () => {
  test('sorts by votes descending, then number ascending', () => {
    const rows = [
      row({ picks: [12, 1, 1, 1] }),
      row({ picks: [12, 1, 1, 1] }),
      row({ picks: [4, 1, 1, 1] }),
      row({ picks: [9, 1, 1, 1] }),
    ];
    assert.deepEqual(tally(rows).best, [
      { number: 12, votes: 2 },
      { number: 4, votes: 1 },
      { number: 9, votes: 1 },
    ]);
  });

  test('sorts numerically, not as strings', () => {
    const rows = [row({ picks: [10, 1, 1, 1] }), row({ picks: [9, 1, 1, 1] }), row({ picks: [100, 1, 1, 1] })];
    assert.deepEqual(tally(rows).best.map((t) => t.number), [9, 10, 100]);
  });

  test('void rows are excluded, whatever the host typed', () => {
    const rows = [
      row({ picks: [12, 1, 1, 1] }),
      row({ picks: [12, 1, 1, 1], isVoid: 'x' }),
      row({ picks: [12, 1, 1, 1], isVoid: 'nope' }),
      row({ picks: [12, 1, 1, 1], isVoid: 'X' }),
    ];
    assert.deepEqual(tally(rows).best, [{ number: 12, votes: 1 }]);
  });

  test('a whitespace-only void cell does not void the row', () => {
    assert.equal(tally([row({ picks: [12, 1, 1, 1], isVoid: '  ' })]).best[0].votes, 1);
  });

  test('a pick the host blanked in the Sheet is skipped', () => {
    assert.deepEqual(tally([row({ picks: ['', 1, 1, 1] })]).best, []);
  });

  test('every category is present even with no rows', () => {
    assert.deepEqual(tally([]), { best: [], favorite: [], most_discount: [], runner_up: [] });
  });
});

describe('flagGroups', () => {
  test('groups ballots that share a fingerprint, in row order', () => {
    const rows = [
      row({ id: 'b_1', print: 'aaa' }), row({ id: 'b_2', print: 'bbb' }),
      row({ id: 'b_3', print: 'aaa' }), row({ id: 'b_4', print: 'ccc' }),
      row({ id: 'b_5', print: 'ccc' }),
    ];
    assert.deepEqual(flagGroups(rows), [['b_1', 'b_3'], ['b_4', 'b_5']]);
  });

  test('a void ballot does not count, so a pair with one voided is no longer a group', () => {
    const rows = [row({ id: 'b_1', print: 'aaa' }), row({ id: 'b_2', print: 'aaa', isVoid: 'x' })];
    assert.deepEqual(flagGroups(rows), []);
  });

  test('blank fingerprints never group together', () => {
    const a = row({ id: 'b_1' });
    const b = row({ id: 'b_2' });
    a[COLS.fingerprint] = '';
    b[COLS.fingerprint] = '';
    assert.deepEqual(flagGroups([a, b]), []);
  });

  test('no rows, no groups', () => {
    assert.deepEqual(flagGroups([]), []);
  });
});

describe('stateResponse', () => {
  for (const [name, settings] of [['SOON', SOON], ['OPEN', OPEN], ['CLOSED', CLOSED]]) {
    test(`contains no counts or results while ${name}, in the raw JSON`, () => {
      const res = stateResponse(settings);
      assert.deepEqual(res, { ok: true, status: name, boardSize: 30 });
      const json = JSON.stringify(res);
      for (const word of ['ballotCount', 'results', 'votes', 'winners', 'tallies', 'voidCount']) {
        assert.equal(json.includes(word), false, `${word} leaked while ${name}`);
      }
    });
  }
});

describe('hostResponse', () => {
  const NOW = '2026-10-31T21:45:00-04:00';

  test('matches the contract shape', () => {
    const rows = [
      row({ id: 'b_1', name: 'Dana R.', picks: [12, 7, 21, 3], print: 'aaa' }),
      row({ id: 'b_2', name: 'Priya', picks: [4, 7, 9, 3], print: 'bbb' }),
      row({ id: 'b_3', name: 'Dana', picks: [12, 7, 21, 3], print: 'aaa' }),
      row({ id: 'b_4', name: 'Tossed', picks: [4, 4, 4, 4], print: 'ccc', isVoid: 'x' }),
    ];
    const res = hostResponse(OPEN, rows, NOW);

    assert.equal(res.ok, true);
    assert.equal(res.status, 'OPEN');
    assert.equal(res.boardSize, 30);
    assert.equal(res.ballotCount, 3);
    assert.equal(res.voidCount, 1);
    assert.equal(res.serverTime, NOW);
    assert.deepEqual(res.tallies.best, [{ number: 12, votes: 2 }, { number: 4, votes: 1 }]);
    assert.deepEqual(res.flagGroups, [['b_1', 'b_3']]);

    assert.deepEqual(res.ballots.map((b) => b.ballotId), ['b_4', 'b_3', 'b_2', 'b_1'], 'newest first');
    assert.deepEqual(res.ballots[1], {
      ballotId: 'b_3',
      submittedAt: '2026-10-31T21:00:00-04:00',
      name: 'Dana',
      picks: { best: 12, favorite: 7, most_discount: 21, runner_up: 3 },
      void: false,
      unlocked: false,
      flagGroup: 0,
    });
    assert.equal(res.ballots[0].void, true);
    assert.equal(res.ballots[0].flagGroup, null);
    assert.equal(res.ballots[2].flagGroup, null);
  });

  test('never sends device IDs, fingerprints or user agents to the page', () => {
    const json = JSON.stringify(hostResponse(OPEN, [row({ print: 'beefbeef', device: DEVICE })], NOW));
    assert.equal(json.includes('beefbeef'), false);
    assert.equal(json.includes(DEVICE), false);
    assert.equal(json.includes('UA'), false);
  });

  test('shows a guarded name as typed, with or without the apostrophe Sheets may keep', () => {
    const rows = [row({ id: 'b_1', name: '=HYPERLINK("x")' }), row({ id: 'b_2', name: "'@dana" })];
    const res = hostResponse(OPEN, rows, NOW);
    assert.equal(res.ballots[1].name, '=HYPERLINK("x")');
    assert.equal(res.ballots[0].name, '@dana');
  });

  test('a name Sheets turned into a number or date still comes back as text', () => {
    const rows = [row({ id: 'b_1', name: 7 }), row({ id: 'b_2', name: new Date('2026-10-31T00:00:00Z') })];
    const res = hostResponse(OPEN, rows, NOW);
    assert.equal(res.ballots[1].name, '7');
    assert.equal(res.ballots[0].name, '2026-10-31T00:00:00.000Z');
  });

  test('empty sheet', () => {
    const res = hostResponse(SOON, [], NOW);
    assert.equal(res.ballotCount, 0);
    assert.deepEqual(res.ballots, []);
    assert.deepEqual(res.flagGroups, []);
  });
});

describe('normalizeSettings', () => {
  test('reads the two keys', () => {
    assert.deepEqual(normalizeSettings([['status', 'OPEN'], ['board_size', 24]]), { status: 'OPEN', boardSize: 24 });
  });

  test('forgives hand-edited case and spaces', () => {
    assert.equal(normalizeSettings([[' status ', ' closed ']]).status, 'CLOSED');
  });

  test('accepts a board size typed as text', () => {
    assert.equal(normalizeSettings([['board_size', '24']]).boardSize, 24);
  });

  test('an unknown status behaves as SOON, so a typo cannot reveal results', () => {
    for (const v of ['CLOSEDD', '', 'x', 5]) {
      assert.equal(normalizeSettings([['status', v]]).status, 'SOON');
    }
    assert.equal(normalizeSettings([]).status, 'SOON');
  });

  test('a bad board size falls back to 30', () => {
    for (const v of ['', 'lots', 0, -3, 2.5]) {
      assert.equal(normalizeSettings([['board_size', v]]).boardSize, 30);
    }
  });
});

describe('parseBody', () => {
  test('parses a JSON object', () => {
    assert.deepEqual(parseBody('{"action":"vote"}'), { action: 'vote' });
  });

  test('anything else is null', () => {
    for (const v of ['', 'not json', '[1]', '3', 'null', undefined]) {
      assert.equal(parseBody(v), null);
    }
  });
});
