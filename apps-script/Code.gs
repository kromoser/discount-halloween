/**
 * Discount Halloween ballot: the whole backend.
 *
 * Paste this into the Apps Script project bound to the private Google Sheet.
 * Everything under "Pure logic" has no Google API calls and is tested in Node
 * (tests/logic.test.mjs). Google API calls stay in the thin wrappers below it.
 */

/* ---------- Constants ---------- */

// Display order of the four categories.
const CATEGORIES = [
  { key: 'best', label: 'Best' },
  { key: 'favorite', label: 'Favorite' },
  { key: 'most_discount', label: 'Most discount' },
  { key: 'runner_up', label: 'Runner up' },
];

// Column positions in the Votes tab. Key order is the header order.
const COLS = {
  ballot_id: 0,
  submitted_at: 1,
  name: 2,
  best: 3,
  favorite: 4,
  most_discount: 5,
  runner_up: 6,
  device_id: 7,
  fingerprint: 8,
  user_agent: 9,
  void: 10,
};

const STATUSES = ['SOON', 'OPEN', 'CLOSED'];
const DEFAULT_BOARD_SIZE = 30;
const NAME_MAX = 40;
const USER_AGENT_MAX = 400;

const VOTES_TAB = 'Votes';
const SETTINGS_TAB = 'Settings';
const SHEET_ID_PROPERTY = 'SHEET_ID';
const PASSWORD_PROPERTY = 'HOST_PASSWORD';

// Columns stored as plain text, so Sheets can't turn a name like 007, or a
// fingerprint that happens to be all digits, into a number or a date.
const TEXT_COLUMNS = ['ballot_id', 'submitted_at', 'name', 'device_id', 'fingerprint', 'user_agent'];

const LOCK_WAIT_MS = 10000;
const STATE_CACHE_KEY = 'state';
const STATE_CACHE_SECONDS = 10;
const FAILURE_CACHE_KEY = 'host_password_failures';
const MAX_PASSWORD_FAILURES = 10;
const FAILURE_WINDOW_SECONDS = 600;

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

/* ---------- Pure logic ---------- */

function errorResponse(code, extra) {
  return Object.assign({ ok: false, error: code, message: MESSAGES[code] }, extra);
}

// Control characters removed, then trimmed.
function cleanText_(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim();
}

// A leading ' makes Sheets store the value as text instead of running it as a formula.
function guardFormula_(s) {
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function sanitizeName(s) {
  return guardFormula_(cleanText_(s));
}

function isUuid_(s) {
  return typeof s === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function isFingerprint_(s) {
  return typeof s === 'string' && /^[0-9a-f]{1,64}$/i.test(s);
}

// Checks steps 2 to 4 of the vote contract, in order.
function validateBallot(body, boardSize) {
  const b = body && typeof body === 'object' ? body : {};

  if (!isUuid_(b.deviceId) || !isFingerprint_(b.fingerprint)) {
    return { ok: false, error: 'bad_request' };
  }

  // Length is measured before the formula prefix, which isn't the guest's character.
  const bareName = cleanText_(b.name);
  if (bareName.length < 1 || bareName.length > NAME_MAX) {
    return { ok: false, error: 'invalid_name' };
  }

  const rawPicks = b.picks && typeof b.picks === 'object' ? b.picks : {};
  const picks = {};
  for (const cat of CATEGORIES) {
    const n = rawPicks[cat.key];
    if (!Number.isInteger(n) || n < 1 || n > boardSize) {
      return { ok: false, error: 'invalid_pick', field: cat.key };
    }
    picks[cat.key] = n;
  }

  return {
    ok: true,
    clean: {
      name: guardFormula_(bareName),
      picks: picks,
      deviceId: b.deviceId.toLowerCase(),
      fingerprint: b.fingerprint.toLowerCase(),
      // The page sends this, so a scripted POST controls it: guard it like the name.
      userAgent: guardFormula_(cleanText_(b.userAgent).slice(0, USER_AGENT_MAX)),
    },
  };
}

function hasDevice(rows, deviceId) {
  const wanted = String(deviceId).toLowerCase();
  return rows.some((row) => String(row[COLS.device_id]).toLowerCase() === wanted);
}

// Runs steps 1 to 5 of the vote contract, in order.
function checkVote(settings, rows, body) {
  if (settings.status === 'SOON') return { ok: false, error: 'not_open' };
  if (settings.status !== 'OPEN') return { ok: false, error: 'closed' };
  const result = validateBallot(body, settings.boardSize);
  if (!result.ok) return result;
  if (hasDevice(rows, result.clean.deviceId)) return { ok: false, error: 'already_voted' };
  return result;
}

function buildRow(clean, ballotId, submittedAt) {
  const row = new Array(Object.keys(COLS).length).fill('');
  row[COLS.ballot_id] = ballotId;
  row[COLS.submitted_at] = submittedAt;
  row[COLS.name] = clean.name;
  CATEGORIES.forEach((cat) => { row[COLS[cat.key]] = clean.picks[cat.key]; });
  row[COLS.device_id] = clean.deviceId;
  row[COLS.fingerprint] = clean.fingerprint;
  row[COLS.user_agent] = clean.userAgent;
  return row;
}

// Any non-blank value in the void column counts as void.
function isVoid_(row) {
  return String(row[COLS.void]).trim() !== '';
}

// Per-category vote counts, most votes first, then lowest number. Excludes void rows.
function tally(rows) {
  const out = {};
  CATEGORIES.forEach((cat) => {
    const counts = {};
    rows.forEach((row) => {
      if (isVoid_(row)) return;
      const n = Number(row[COLS[cat.key]]);
      if (!Number.isInteger(n) || n < 1) return;
      counts[n] = (counts[n] || 0) + 1;
    });
    out[cat.key] = Object.keys(counts)
      .map((k) => ({ number: Number(k), votes: counts[k] }))
      .sort((a, b) => b.votes - a.votes || a.number - b.number);
  });
  return out;
}

// Each category's top numbers. More than one number means a tie.
function winners(tallies) {
  return CATEGORIES.map((cat) => {
    const list = tallies[cat.key] || [];
    const top = list.length ? list[0].votes : 0;
    return {
      key: cat.key,
      label: cat.label,
      winners: list.filter((t) => t.votes === top).map((t) => t.number),
      votes: top,
    };
  });
}

// Sets of two or more non-void ballots sharing a fingerprint, as ballot IDs.
function flagGroups(rows) {
  const byPrint = new Map();
  rows.forEach((row) => {
    if (isVoid_(row)) return;
    const print = String(row[COLS.fingerprint]).trim();
    if (!print) return;
    if (!byPrint.has(print)) byPrint.set(print, []);
    byPrint.get(print).push(String(row[COLS.ballot_id]));
  });
  return Array.from(byPrint.values()).filter((ids) => ids.length >= 2);
}

function countValid_(rows) {
  return rows.filter((row) => !isVoid_(row)).length;
}

// Public response. Must never include counts of any kind unless CLOSED.
function stateResponse(settings, rows) {
  const res = { ok: true, status: settings.status, boardSize: settings.boardSize };
  if (settings.status === 'CLOSED') {
    res.ballotCount = countValid_(rows);
    res.results = winners(tally(rows));
  }
  return res;
}

function textOf_(v) {
  return Object.prototype.toString.call(v) === '[object Date]' ? v.toISOString() : String(v);
}

function rowToBallot_(row, flagGroup) {
  const picks = {};
  CATEGORIES.forEach((cat) => { picks[cat.key] = Number(row[COLS[cat.key]]); });
  return {
    ballotId: textOf_(row[COLS.ballot_id]),
    submittedAt: textOf_(row[COLS.submitted_at]),
    // Plain-text cells keep the formula guard's apostrophe; the host shouldn't see it.
    name: textOf_(row[COLS.name]).replace(/^'(?=[=+\-@])/, ''),
    picks: picks,
    void: isVoid_(row),
    flagGroup: flagGroup,
  };
}

// Host dashboard snapshot. Void ballots are listed but excluded from counts and tallies.
function hostResponse(settings, rows, serverTime) {
  const groups = flagGroups(rows);
  const groupOf = {};
  groups.forEach((ids, i) => ids.forEach((id) => { groupOf[id] = i; }));

  const ballots = rows.map((row) => {
    const id = textOf_(row[COLS.ballot_id]);
    return rowToBallot_(row, id in groupOf ? groupOf[id] : null);
  });
  ballots.reverse();

  return {
    ok: true,
    status: settings.status,
    boardSize: settings.boardSize,
    ballotCount: countValid_(rows),
    voidCount: rows.filter(isVoid_).length,
    tallies: tally(rows),
    flagGroups: groups,
    ballots: ballots,
    serverTime: serverTime,
  };
}

// Settings tab rows as [key, value]. Anything unreadable falls back to the safe default:
// an unknown status behaves as SOON, so a typo in the cell can't reveal results.
function normalizeSettings(pairs) {
  const raw = {};
  (pairs || []).forEach((pair) => { raw[String(pair[0]).trim()] = pair[1]; });

  const status = String(raw.status === undefined ? '' : raw.status).trim().toUpperCase();
  const size = Number(raw.board_size);

  return {
    status: STATUSES.indexOf(status) === -1 ? 'SOON' : status,
    boardSize: Number.isInteger(size) && size >= 1 ? size : DEFAULT_BOARD_SIZE,
  };
}

// The request body as an object, or null if it isn't a JSON object.
function parseBody(contents) {
  try {
    const body = JSON.parse(contents);
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch (err) {
    return null;
  }
}

/* ---------- Entry points ---------- */

function doGet(e) {
  return respond_(() => {
    const action = e && e.parameter && e.parameter.action;
    return action === 'state' ? handleState_() : errorResponse('bad_request');
  });
}

function doPost(e) {
  return respond_(() => {
    const body = parseBody(e && e.postData && e.postData.contents);
    if (!body) return errorResponse('bad_request');
    if (body.action === 'vote') return handleVote_(body);
    if (body.action === 'host') return handleHost_(body);
    if (body.action === 'setStatus') return handleSetStatus_(body);
    return errorResponse('bad_request');
  });
}

// Every response is JSON with HTTP 200, since Apps Script can't set status codes.
// A handler returns an object, or a string that is already JSON (the cached state).
function respond_(handler) {
  let result;
  try {
    result = handler();
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    result = errorResponse('server_error');
  }
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
}

/* ---------- Handlers ---------- */

function handleState_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(STATE_CACHE_KEY);
  if (cached) return cached;

  const settings = readSettings_();
  const rows = settings.status === 'CLOSED' ? readVotes_() : [];
  const json = JSON.stringify(stateResponse(settings, rows));
  cache.put(STATE_CACHE_KEY, json, STATE_CACHE_SECONDS);
  return json;
}

function handleVote_(body) {
  const lock = LockService.getScriptLock();
  lock.waitLock(LOCK_WAIT_MS);
  try {
    const result = checkVote(readSettings_(), readVotes_(), body);
    if (!result.ok) {
      return errorResponse(result.error, result.field ? { field: result.field } : undefined);
    }
    const ballotId = 'b_' + Utilities.getUuid();
    const submittedAt = isoNow_();
    appendVote_(buildRow(result.clean, ballotId, submittedAt));
    return { ok: true, ballotId: ballotId, submittedAt: submittedAt };
  } finally {
    lock.releaseLock();
  }
}

function handleHost_(body) {
  const passwordError = checkPassword_(body.password);
  if (passwordError) return errorResponse(passwordError);
  return hostResponse(readSettings_(), readVotes_(), isoNow_());
}

function handleSetStatus_(body) {
  const passwordError = checkPassword_(body.password);
  if (passwordError) return errorResponse(passwordError);
  if (STATUSES.indexOf(body.status) === -1) return errorResponse('bad_request');
  writeStatus_(body.status);
  CacheService.getScriptCache().remove(STATE_CACHE_KEY);
  return { ok: true, status: body.status };
}

// Returns an error code, or null if the password is right. The lockout is checked
// first, so the right password doesn't work during it. A success doesn't clear the
// count: the host page polls every 10 s, which would otherwise keep resetting it.
// The window isn't extended during a lockout, so it always ends.
function checkPassword_(password) {
  const cache = CacheService.getScriptCache();
  const failures = Number(cache.get(FAILURE_CACHE_KEY)) || 0;
  if (failures >= MAX_PASSWORD_FAILURES) return 'too_many_attempts';

  // With no password set, nothing matches: the page stays locked rather than open.
  const expected = PropertiesService.getScriptProperties().getProperty(PASSWORD_PROPERTY);
  if (expected && password === expected) return null;

  cache.put(FAILURE_CACHE_KEY, String(failures + 1), FAILURE_WINDOW_SECONDS);
  return 'bad_password';
}

/* ---------- Sheet wrappers ---------- */

function spreadsheet_() {
  return SpreadsheetApp.getActiveSpreadsheet() ||
    SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty(SHEET_ID_PROPERTY));
}

function tab_(name) {
  const sheet = spreadsheet_().getSheetByName(name);
  if (!sheet) throw new Error('Missing tab "' + name + '". Run setup() from the editor.');
  return sheet;
}

function readSettings_() {
  return normalizeSettings(tab_(SETTINGS_TAB).getDataRange().getValues());
}

function writeStatus_(status) {
  const sheet = tab_(SETTINGS_TAB);
  const values = sheet.getDataRange().getValues();
  const index = values.findIndex((row) => String(row[0]).trim() === 'status');
  if (index === -1) {
    sheet.appendRow(['status', status]);
  } else {
    sheet.getRange(index + 1, 2).setValue(status);
  }
  SpreadsheetApp.flush();
}

// Rows without a ballot ID are ones the host cleared by hand.
function readVotes_() {
  return tab_(VOTES_TAB).getDataRange().getValues().slice(1)
    .filter((row) => String(row[COLS.ballot_id]).trim() !== '');
}

// Flushed before the caller releases the lock, so the next voter's duplicate check sees this row.
function appendVote_(row) {
  tab_(VOTES_TAB).appendRow(row);
  SpreadsheetApp.flush();
}

function isoNow_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ssXXX");
}

/* ---------- One-time setup ---------- */

// Run once by hand from the editor. Safe to run again: it never overwrites existing
// headers, votes or settings.
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  PropertiesService.getScriptProperties().setProperty(SHEET_ID_PROPERTY, ss.getId());

  const votes = ss.getSheetByName(VOTES_TAB) || ss.insertSheet(VOTES_TAB);
  if (votes.getLastRow() === 0) {
    const headers = Object.keys(COLS);
    votes.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  votes.setFrozenRows(1);

  const dataRows = votes.getMaxRows() - 1;
  TEXT_COLUMNS.forEach((key) => {
    votes.getRange(2, COLS[key] + 1, dataRows, 1).setNumberFormat('@');
  });

  // A hint, not a rule: any non-blank value still counts as void.
  const voidHint = SpreadsheetApp.newDataValidation()
    .requireValueInList(['x'], false)
    .setAllowInvalid(true)
    .setHelpText('Type x to void this ballot.')
    .build();
  votes.getRange(2, COLS.void + 1, dataRows, 1).setDataValidation(voidHint);

  const settings = ss.getSheetByName(SETTINGS_TAB) || ss.insertSheet(SETTINGS_TAB);
  if (settings.getLastRow() === 0) {
    settings.getRange(1, 1, 2, 2).setValues([
      ['status', 'SOON'],
      ['board_size', DEFAULT_BOARD_SIZE],
    ]);
  }
}
