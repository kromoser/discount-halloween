// A fake of the whole API contract, for building and testing the UI with no Google
// deployment. It mirrors apps-script/Code.gs: same responses, same errors, same order
// of checks. tests/mock.test.mjs runs both side by side to keep them in step.
//
// State lives in localStorage['dh.mock'], so a guest tab and a host tab share it.
// Only loaded with ?mock=1, and it never touches the network.

const STORE_KEY = 'dh.mock';

// Fake data, not a secret: the real password is only ever in Script Properties.
export const MOCK_PASSWORD = 'boo';

const CATEGORIES = [
  { key: 'best', label: 'Best' },
  { key: 'favorite', label: 'Favorite' },
  { key: 'most_discount', label: 'Most discount' },
  { key: 'runner_up', label: 'Runner up' },
];

const STATUSES = ['SOON', 'OPEN', 'CLOSED'];
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;

const MESSAGES = {
  not_open: 'Voting has not opened yet.',
  closed: 'Voting is closed.',
  bad_request: 'That request could not be read.',
  invalid_name: 'Enter a name of 1 to 40 characters.',
  invalid_pick: 'That number is not on the board.',
  already_voted: 'This phone already voted.',
  bad_password: 'Wrong password.',
  too_many_attempts: 'Too many tries. Wait 10 minutes.',
  server_error: 'Something went wrong on the server.',
};

export const ERROR_CODES = Object.keys(MESSAGES);

const error = (code, extra) => ({ ok: false, error: code, message: MESSAGES[code], ...extra });

/* ---------- Seed data ---------- */

// Oldest first. Tallies match the mockups: Best #12 (11), Favorite #7 (9),
// Most discount #21 (13), Runner up #3 and #18 tied (6 each). "Dana R." and "Dana"
// are the two flagged ballots. "Test ballot" is void, so 27 of the 28 rows count.
const SEED = [
  ['Ana', 12, 7, 21, 3],
  ['Ben', 4, 12, 9, 18],
  ['Cleo', 19, 25, 21, 5],
  ['Dev', 12, 1, 2, 12],
  ['Eli', 6, 7, 21, 18],
  ['Fran', 4, 12, 11, 7],
  ['Gus', 12, 5, 9, 3],
  ['Hana', 19, 7, 21, 9],
  ['Ivan', 8, 25, 17, 18],
  ['Kira', 4, 12, 21, 10],
  ['Leo', 12, 14, 9, 12],
  ['Mina', 15, 7, 23, 14],
  ['Nico', 19, 16, 21, 20],
  ['Omar', 4, 12, 2, 18],
  ['Pia', 12, 7, 9, 24],
  ['Quinn', 22, 25, 21, 3],
  ['Rosa', 4, 20, 26, 27],
  ['Sam', 19, 12, 21, 12],
  ['Tess', 12, 7, 30, 29],
  ['Uma', 4, 28, 9, 6],
  ['Wes', 12, 12, 21, 8],
  ['Marcus', 4, 12, 21, 18],
  ['Priya', 12, 7, 9, 3],
  ['Dana R.', 12, 7, 21, 3],
  ['Jules', 19, 25, 21, 12],
  ['Dana', 12, 7, 21, 3],
  ['Theo', 12, 12, 2, 18],
];

function seedBallots() {
  const ballots = SEED.map(([name, best, favorite, most_discount, runner_up], i) => {
    const n = String(i + 1).padStart(2, '0');
    // Spread across 9:05 PM to 9:45 PM on party night.
    const minute = 5 + Math.round((i * 40) / (SEED.length - 1));
    return {
      ballotId: `b_mock_${n}`,
      submittedAt: `2026-10-31T21:${String(minute).padStart(2, '0')}:07-04:00`,
      name,
      picks: { best, favorite, most_discount, runner_up },
      deviceId: `00000000-0000-4000-8000-0000000000${n}`,
      fingerprint: name.startsWith('Dana') ? 'a91c04d2e8b37f10' : `00000000000000${n}`,
      void: false,
    };
  });
  ballots.splice(1, 0, {
    ballotId: 'b_mock_void',
    submittedAt: '2026-10-31T21:05:30-04:00',
    name: 'Test ballot',
    picks: { best: 1, favorite: 1, most_discount: 1, runner_up: 1 },
    deviceId: '00000000-0000-4000-8000-000000000099',
    fingerprint: '0000000000000099',
    void: true,
  });
  return ballots;
}

function freshDb() {
  return {
    status: 'OPEN',
    boardSize: 30,
    ballots: seedBallots(),
    failures: 0,
    failuresExpire: 0,
    forceNext: null,
  };
}

/* ---------- Storage ---------- */

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    if (saved && Array.isArray(saved.ballots)) return saved;
  } catch {
    // Storage blocked or corrupted: start again from the seed.
  }
  return freshDb();
}

function save(db) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(db));
  } catch {
    // Storage blocked: changes last only for this call.
  }
}

/* ---------- Contract logic ---------- */

function tally(ballots) {
  const out = {};
  CATEGORIES.forEach(({ key }) => {
    const counts = new Map();
    ballots.filter((b) => !b.void).forEach((b) => {
      const n = b.picks[key];
      counts.set(n, (counts.get(n) || 0) + 1);
    });
    out[key] = [...counts]
      .map(([number, votes]) => ({ number, votes }))
      .sort((a, b) => b.votes - a.votes || a.number - b.number);
  });
  return out;
}

function flagGroups(ballots) {
  const byPrint = new Map();
  ballots.filter((b) => !b.void).forEach((b) => {
    if (!byPrint.has(b.fingerprint)) byPrint.set(b.fingerprint, []);
    byPrint.get(b.fingerprint).push(b.ballotId);
  });
  return [...byPrint.values()].filter((ids) => ids.length >= 2);
}

function stateResponse(db) {
  const res = { ok: true, status: db.status, boardSize: db.boardSize };
  if (db.status === 'CLOSED') {
    const tallies = tally(db.ballots);
    res.ballotCount = db.ballots.filter((b) => !b.void).length;
    res.results = CATEGORIES.map(({ key, label }) => {
      const list = tallies[key];
      const top = list.length ? list[0].votes : 0;
      return { key, label, winners: list.filter((t) => t.votes === top).map((t) => t.number), votes: top };
    });
  }
  return res;
}

function vote(db, body) {
  if (db.status === 'SOON') return error('not_open');
  if (db.status !== 'OPEN') return error('closed');

  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const print = /^[0-9a-f]{1,64}$/i;
  if (typeof body.deviceId !== 'string' || !uuid.test(body.deviceId)
    || typeof body.fingerprint !== 'string' || !print.test(body.fingerprint)) {
    return error('bad_request');
  }

  const name = typeof body.name === 'string'
    // eslint-disable-next-line no-control-regex
    ? body.name.replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim()
    : '';
  if (name.length < 1 || name.length > 40) return error('invalid_name');

  const raw = body.picks && typeof body.picks === 'object' ? body.picks : {};
  const picks = {};
  for (const { key } of CATEGORIES) {
    const n = raw[key];
    if (!Number.isInteger(n) || n < 1 || n > db.boardSize) return error('invalid_pick', { field: key });
    picks[key] = n;
  }

  const deviceId = body.deviceId.toLowerCase();
  if (db.ballots.some((b) => b.deviceId === deviceId)) return error('already_voted');

  const ballotId = `b_mock_${crypto.randomUUID ? crypto.randomUUID() : Date.now()}`;
  const submittedAt = new Date().toISOString();
  db.ballots.push({
    ballotId,
    submittedAt,
    name,
    picks,
    deviceId,
    fingerprint: body.fingerprint.toLowerCase(),
    void: false,
  });
  return { ok: true, ballotId, submittedAt };
}

function checkPassword(db, password) {
  const now = Date.now();
  if (now >= db.failuresExpire) db.failures = 0;
  if (db.failures >= MAX_FAILURES) return 'too_many_attempts';
  if (password === MOCK_PASSWORD) return null;
  db.failures += 1;
  db.failuresExpire = now + FAILURE_WINDOW_MS;
  return 'bad_password';
}

function hostSnapshot(db) {
  const groups = flagGroups(db.ballots);
  const groupOf = new Map();
  groups.forEach((ids, i) => ids.forEach((id) => groupOf.set(id, i)));
  return {
    ok: true,
    status: db.status,
    boardSize: db.boardSize,
    ballotCount: db.ballots.filter((b) => !b.void).length,
    voidCount: db.ballots.filter((b) => b.void).length,
    tallies: tally(db.ballots),
    flagGroups: groups,
    ballots: db.ballots.map((b) => ({
      ballotId: b.ballotId,
      submittedAt: b.submittedAt,
      name: b.name,
      picks: b.picks,
      void: b.void,
      flagGroup: groupOf.has(b.ballotId) ? groupOf.get(b.ballotId) : null,
    })).reverse(),
    serverTime: new Date().toISOString(),
  };
}

function route(db, body) {
  if (!body || typeof body !== 'object') return error('bad_request');
  if (body.action === 'vote') return vote(db, body);
  if (body.action === 'host') {
    const problem = checkPassword(db, body.password);
    return problem ? error(problem) : hostSnapshot(db);
  }
  if (body.action === 'setStatus') {
    const problem = checkPassword(db, body.password);
    if (problem) return error(problem);
    if (!STATUSES.includes(body.status)) return error('bad_request');
    db.status = body.status;
    return { ok: true, status: db.status };
  }
  return error('bad_request');
}

/* ---------- The backend api.js calls ---------- */

// 'network' makes the call reject, like a dropped connection. Anything else is
// returned as that error code.
function consumeForced(db) {
  const forced = db.forceNext;
  if (!forced) return null;
  db.forceNext = null;
  save(db);
  if (forced === 'network') throw new TypeError('Mock network failure');
  const extra = forced === 'invalid_pick' ? { field: 'best' } : undefined;
  return error(forced, extra);
}

// A little latency in the browser, so "Casting…" and friends are visible.
function pause() {
  const ms = typeof document === 'undefined' ? 0 : 150 + Math.random() * 250;
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

export const backend = {
  async getState() {
    await pause();
    const db = load();
    return consumeForced(db) || stateResponse(db);
  },

  async post(payload) {
    await pause();
    const db = load();
    const forced = consumeForced(db);
    if (forced) return forced;
    // JSON round trip, the same as a real POST: undefined drops out, NaN becomes null.
    const res = route(db, JSON.parse(JSON.stringify(payload)));
    save(db);
    return res;
  },
};

/* ---------- Dev tools ---------- */

// Controls, for the console or the panel below. Each change is seen on the next poll.
export const controls = {
  setStatus(status) {
    if (!STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(', ')}`);
    const db = load();
    db.status = status;
    save(db);
  },
  setBoardSize(size) {
    const db = load();
    db.boardSize = size;
    save(db);
  },
  // Stands in for typing x in the Void cell of the Sheet.
  toggleVoid(ballotId) {
    const db = load();
    const ballot = db.ballots.find((b) => b.ballotId === ballotId);
    if (ballot) ballot.void = !ballot.void;
    save(db);
  },
  // Empties the board, for testing no votes and ties.
  clearBallots() {
    const db = load();
    db.ballots = [];
    save(db);
  },
  failNext(code) {
    const db = load();
    db.forceNext = code || null;
    save(db);
  },
  // Clears the failed password count.
  clearLockout() {
    const db = load();
    db.failures = 0;
    db.failuresExpire = 0;
    save(db);
  },
  state: load,
  reset() {
    save(freshDb());
  },
  // Lets this browser vote again.
  forgetMe() {
    try {
      localStorage.removeItem('dh.ballot');
      localStorage.removeItem('dh.deviceId');
    } catch {
      // Nothing stored, then.
    }
  },
};

export function installDevTools() {
  if (typeof document === 'undefined') return;
  window.dhMock = controls;

  const style = document.createElement('style');
  style.textContent = `
    .mock-panel { position: fixed; top: 8px; right: 8px; z-index: 10; max-width: 240px;
      background: #000; border: 2px solid #ffd60a; color: #f3efe8;
      font: 500 11px/1.4 'IBM Plex Mono', ui-monospace, monospace; }
    .mock-panel summary { padding: 4px 8px; cursor: pointer; color: #ffd60a; text-transform: uppercase;
      letter-spacing: 0.08em; }
    .mock-panel__body { display: flex; flex-direction: column; gap: 8px; padding: 8px; }
    .mock-panel__row { display: flex; flex-wrap: wrap; gap: 4px; }
    .mock-panel button, .mock-panel select { font: inherit; padding: 4px 6px; background: #2c2725;
      color: #f3efe8; border: 1px solid #6b625d; }
    .mock-panel button.is-on { background: #ffd60a; color: #141212; }
  `;
  document.head.append(style);

  const panel = document.createElement('details');
  panel.className = 'mock-panel';
  panel.setAttribute('aria-label', 'Mock mode controls');

  const summary = document.createElement('summary');
  summary.textContent = 'Mock';

  const body = document.createElement('div');
  body.className = 'mock-panel__body';

  const row = () => {
    const el = document.createElement('div');
    el.className = 'mock-panel__row';
    body.append(el);
    return el;
  };

  const button = (parent, label, onClick) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.textContent = label;
    el.addEventListener('click', onClick);
    parent.append(el);
    return el;
  };

  const statusRow = row();
  const statusButtons = STATUSES.map((status) => {
    const el = button(statusRow, status, () => {
      controls.setStatus(status);
      location.reload();
    });
    el.dataset.status = status;
    return el;
  });

  const errorRow = row();
  const select = document.createElement('select');
  select.setAttribute('aria-label', 'Force the next response');
  [['', 'Next call: normal'], ['network', 'network failure'], ...ERROR_CODES.map((c) => [c, c])]
    .forEach(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.append(option);
    });
  select.addEventListener('change', () => controls.failNext(select.value));
  errorRow.append(select);

  const dataRow = row();
  button(dataRow, 'Forget my ballot', () => {
    controls.forgetMe();
    location.reload();
  });
  button(dataRow, 'Clear lockout', () => controls.clearLockout());
  button(dataRow, 'Reset all', () => {
    controls.forgetMe();
    controls.reset();
    location.reload();
  });

  const note = document.createElement('div');
  note.textContent = `Host password: ${MOCK_PASSWORD}. Console: dhMock`;
  body.append(note);

  panel.addEventListener('toggle', () => {
    const { status, forceNext } = load();
    statusButtons.forEach((el) => el.classList.toggle('is-on', el.dataset.status === status));
    select.value = forceNext || '';
  });

  panel.append(summary, body);
  document.body.append(panel);
}
