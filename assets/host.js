// Host page: login, dashboard and polling. It changes the voting status and unlocks
// ballots. Everything else is fixed in the Sheet. Guest names are untrusted, so all text
// goes in through textContent, never as HTML: this page holds the host password.

import { host, setStatus, unlockBallot } from './api.js';
import { POLL_HOST_MS, SHEET_URL } from './config.js';

const CATEGORIES = [
  { key: 'best', label: 'Best' },
  { key: 'favorite', label: 'Favorite' },
  { key: 'most_discount', label: 'Most discount' },
  { key: 'runner_up', label: 'Runner up' },
];

const PASSWORD_KEY = 'dh.hostPass';
const CONFIRM_MS = 5000;
// A second tap this soon is one accidental double-tap, not a decision.
const DOUBLE_TAP_MS = 400;
const TOP_BARS = 3;

const MESSAGE = {
  wrongPassword: 'Wrong password. Try again.',
  tooMany: 'Too many tries. Wait 10 minutes.',
  offline: "Can't reach the ballot box. Check your signal.",
  retry: "Didn't go through. Try again.",
};

const $ = (id) => document.getElementById(id);

const state = {
  password: null,
  data: null,
  // What the next tap would confirm: { kind: 'status' | 'ballot', value }. One at a time.
  armed: null,
  armedAt: 0,
  busy: false,
  actionError: '',
  unlocking: null,
  unlockError: '',
  pollProblem: '',
};

/* ---------- Password storage ---------- */

// sessionStorage, so it's gone when the tab closes.
function readPassword() {
  try {
    return sessionStorage.getItem(PASSWORD_KEY);
  } catch {
    return null;
  }
}

function storePassword(password) {
  try {
    sessionStorage.setItem(PASSWORD_KEY, password);
  } catch {
    // Storage blocked: the password lasts until this page reloads.
  }
}

function forgetPassword() {
  state.password = null;
  try {
    sessionStorage.removeItem(PASSWORD_KEY);
  } catch {
    // Nothing stored, then.
  }
}

/* ---------- Helpers ---------- */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatTime(iso, withSeconds = false) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const options = { hour: 'numeric', minute: '2-digit' };
  if (withSeconds) options.second = '2-digit';
  return date.toLocaleTimeString([], options);
}

function picksText(picks) {
  return CATEGORIES.map(({ key }) => picks[key]).join(' · ');
}

/* ---------- Render ---------- */

const PILL_TEXT = { SOON: 'Voting soon', OPEN: 'Voting open', CLOSED: 'Closed' };

function renderHeader({ status, ballotCount, boardSize, flagGroups }) {
  $('status-text').textContent = PILL_TEXT[status] || status;
  $('status-pill').classList.toggle('is-open', status === 'OPEN');

  const flagged = flagGroups.reduce((total, group) => total + group.length, 0);
  $('stat-ballots').textContent = ballotCount;
  $('stat-board').textContent = boardSize;
  $('stat-flagged').textContent = flagged;
  $('stat-flagged').classList.toggle('is-flagged', flagged > 0);
}

const STATUS_LABEL = { SOON: 'Soon', OPEN: 'Open', CLOSED: 'Closed' };

// What guests see now.
const STATUS_NOW = {
  SOON: 'Guests see "Voting opens soon."',
  OPEN: 'Guests can vote.',
  CLOSED: 'Guests see "Voting is closed."',
};

// What the second tap would do.
function statusHelp(armed, status) {
  if (armed === 'CLOSED') return "Closing ends voting on every guest's phone.";
  if (armed === 'SOON') return 'Guests go back to "Voting opens soon" and can\'t vote.';
  return status === 'CLOSED' ? 'Guests can vote again.' : 'Guests can start voting.';
}

function renderActions() {
  const { status } = state.data;
  const armed = armedValue('status');

  $('status-control').querySelectorAll('button').forEach((button) => {
    const { value } = button.dataset;
    button.classList.toggle('is-current', value === status);
    button.classList.toggle('is-armed', value === armed);
    button.setAttribute('aria-pressed', String(value === status));
    button.textContent = value === armed ? 'Tap again' : STATUS_LABEL[value];
    button.disabled = state.busy;
  });

  $('status-cancel').hidden = !armed;
  $('action-helper').textContent = armed ? statusHelp(armed, status) : STATUS_NOW[status];

  $('action-error').textContent = state.actionError;
  $('action-error').hidden = !state.actionError;
}

function bar(tallyEntry, top, ballotCount) {
  const row = el('div', 'bar');
  row.classList.toggle('is-leading', tallyEntry.votes === top);

  const track = el('span', 'bar__track');
  const fill = el('span', 'bar__fill');
  const share = ballotCount ? Math.round((tallyEntry.votes / ballotCount) * 100) : 0;
  fill.style.width = `${share}%`;
  track.append(fill);

  row.append(
    el('span', 'bar__number', `#${tallyEntry.number}`),
    track,
    el('span', 'bar__votes', tallyEntry.votes),
  );
  return row;
}

function renderLiveResults({ tallies, ballotCount }) {
  $('live-results').replaceChildren(...CATEGORIES.map(({ key, label }) => {
    const list = tallies[key] || [];
    const top = list.length ? list[0].votes : 0;
    const block = el('div', 'category');
    block.append(el('span', 'category__name', label));
    if (!list.length) {
      block.append(el('p', 'muted-note', 'No votes yet.'));
      return block;
    }
    // The top 3, plus anyone else tied for first: a leader must never be hidden.
    list
      .filter((entry, i) => i < TOP_BARS || entry.votes === top)
      .forEach((entry) => block.append(bar(entry, top, ballotCount)));
    return block;
  }));
}

function unlockButton(ballot) {
  const armed = armedValue('ballot') === ballot.ballotId;
  const unlocking = state.unlocking === ballot.ballotId;

  let text = 'Unlock';
  if (armed) text = 'Tap again';
  if (unlocking) text = 'Unlocking…';

  const button = el('button', armed ? 'row__unlock is-armed' : 'row__unlock', text);
  button.type = 'button';
  button.dataset.ballot = ballot.ballotId;
  button.disabled = Boolean(state.unlocking);
  button.setAttribute('aria-label', armed ? `Tap again to unlock ${ballot.name}` : `Unlock ${ballot.name}`);
  return button;
}

function ballotRow(ballot, { showTags, canUnlock = false }) {
  const row = el('div', 'row');
  row.classList.toggle('is-void', ballot.void);

  const top = el('span', 'row__top');
  top.append(el('span', 'row__name', ballot.name));
  if (showTags && ballot.void) top.append(el('span', 'tag tag--void', ballot.unlocked ? 'Unlocked' : 'Void'));
  if (showTags && ballot.flagGroup !== null) top.append(el('span', 'tag tag--flag', 'Flag'));

  const time = formatTime(ballot.submittedAt);
  const meta = time ? `${time} · ${picksText(ballot.picks)}` : picksText(ballot.picks);
  row.append(top, el('span', 'row__meta', meta));

  if (canUnlock && !ballot.unlocked) {
    row.classList.add('row--unlockable');
    row.append(unlockButton(ballot));
  }
  return row;
}

function renderFlags({ flagGroups, ballots }) {
  $('flag-section').hidden = flagGroups.length === 0;
  const byId = new Map(ballots.map((b) => [b.ballotId, b]));
  $('flag-groups').replaceChildren(...flagGroups.map((ids) => {
    const group = el('div', 'rows');
    ids
      .map((id) => byId.get(id))
      .filter(Boolean)
      .forEach((ballot) => group.append(ballotRow(ballot, { showTags: false })));
    return group;
  }));
  $('sheet-link').hidden = !SHEET_URL;
  if (SHEET_URL) $('sheet-link').href = SHEET_URL;
}

function renderBallots() {
  const { ballots, status } = state.data;
  // Closed is final until reopened: unlocking then would change the count being announced.
  const canUnlock = status !== 'CLOSED';
  $('unlock-helper').hidden = !canUnlock;
  $('unlock-error').textContent = state.unlockError;
  $('unlock-error').hidden = !state.unlockError;
  $('ballot-rows').replaceChildren(
    ...(ballots.length
      ? ballots.map((ballot) => ballotRow(ballot, { showTags: true, canUnlock }))
      : [el('p', 'muted-note empty-row', 'No ballots yet.')]),
  );
}

function renderFooter() {
  const updated = `Updated ${formatTime(state.data.serverTime, true)}`;
  $('updated').textContent = state.pollProblem ? `${updated} · ${state.pollProblem}` : updated;
}

function renderDashboard() {
  const { data } = state;
  renderHeader(data);
  renderActions();
  renderLiveResults(data);
  renderFlags(data);
  // Rebuilding the rows under an armed button could swallow its second tap.
  if (!armedValue('ballot')) renderBallots();
  renderFooter();
}

function showScreen(name) {
  $('screen-login').hidden = name !== 'login';
  $('screen-dash').hidden = name !== 'dash';
  window.scrollTo(0, 0);
}

/* ---------- Login ---------- */

function setLoginBusy(busy) {
  $('unlock').disabled = busy;
  $('unlock').textContent = busy ? 'Unlocking…' : 'Unlock';
}

function showLoginError(message) {
  $('login-error').textContent = message;
  $('login-error').hidden = !message;
}

function enterDashboard(password, data) {
  state.password = password;
  state.data = data;
  state.pollProblem = '';
  storePassword(password);
  $('host-password').value = '';
  showLoginError('');
  showScreen('dash');
  renderDashboard();
  schedulePoll();
}

function returnToLogin(message = '') {
  stopPolling();
  disarm();
  state.data = null;
  state.busy = false;
  state.actionError = '';
  state.unlocking = null;
  state.unlockError = '';
  forgetPassword();
  showLoginError(message);
  showScreen('login');
}

// silent: trying the saved password on load, so a stale one shows no error.
async function unlock(password, { silent = false } = {}) {
  setLoginBusy(true);
  showLoginError('');

  let res = null;
  try {
    res = await host(password);
  } catch {
    // Handled below as no response.
  }
  setLoginBusy(false);

  if (res && res.ok) {
    enterDashboard(password, res);
  } else if (res && res.error === 'bad_password') {
    forgetPassword();
    showLoginError(silent ? '' : MESSAGE.wrongPassword);
  } else if (res && res.error === 'too_many_attempts') {
    showLoginError(MESSAGE.tooMany);
  } else {
    showLoginError(MESSAGE.offline);
  }
}

$('login-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const password = $('host-password').value;
  if (password && !$('unlock').disabled) unlock(password);
});

/* ---------- Polling ---------- */

let pollTimer = null;
let latestPoll = 0;

function stopPolling() {
  clearTimeout(pollTimer);
  pollTimer = null;
  latestPoll += 1; // Anything still in flight is now out of date.
}

function schedulePoll() {
  clearTimeout(pollTimer);
  pollTimer = null;
  if (document.hidden || !state.password) return;
  pollTimer = setTimeout(poll, POLL_HOST_MS);
}

async function poll() {
  clearTimeout(pollTimer);
  latestPoll += 1;
  const request = latestPoll;

  let res = null;
  try {
    res = await host(state.password);
  } catch {
    // Handled below as no response.
  }

  if (request !== latestPoll || !state.password) return;

  if (res && res.ok) {
    state.data = res;
    state.pollProblem = '';
    // The status moved on without this device, so the ask no longer applies.
    if (armedValue('status') === res.status || (armedValue('ballot') && res.status === 'CLOSED')) disarm();
    renderDashboard();
  } else if (res && res.error === 'bad_password') {
    // The password was changed.
    returnToLogin();
    return;
  } else {
    // Keep showing the last good numbers, and say they may be old.
    state.pollProblem = res && res.error === 'too_many_attempts' ? MESSAGE.tooMany : MESSAGE.offline;
    renderFooter();
  }
  schedulePoll();
}

document.addEventListener('visibilitychange', () => {
  if (!state.password || !state.data) return;
  if (document.hidden) {
    clearTimeout(pollTimer);
    pollTimer = null;
  } else {
    poll();
  }
});

/* ---------- Two taps ---------- */

// Everything this page changes reaches guests' phones, so each change takes two taps.

let armTimer = null;

function armedValue(kind) {
  return state.armed && state.armed.kind === kind ? state.armed.value : null;
}

function disarm() {
  clearTimeout(armTimer);
  armTimer = null;
  state.armed = null;
}

function renderTaps() {
  renderActions();
  renderBallots();
  const armedRow = $('ballot-rows').querySelector('.row__unlock.is-armed');
  if (armedRow) armedRow.focus();
}

function arm(kind, value) {
  disarm();
  state.armed = { kind, value };
  state.armedAt = Date.now();
  armTimer = setTimeout(() => {
    disarm();
    renderTaps();
  }, CONFIRM_MS);
  renderTaps();
}

// True if this tap is the one that confirms. The first tap arms, a tap on something
// else moves the ask there, and an accidental double-tap leaves the ask as it is.
function isSecondTap(kind, value) {
  if (armedValue(kind) !== value) {
    arm(kind, value);
    return false;
  }
  return Date.now() - state.armedAt >= DOUBLE_TAP_MS;
}

/* ---------- Status control ---------- */

async function changeStatus(status) {
  disarm();
  state.busy = true;
  state.actionError = '';
  renderActions();

  let res = null;
  try {
    res = await setStatus(state.password, status);
  } catch {
    // Handled below as no response.
  }
  state.busy = false;

  if (res && res.ok) {
    state.data.status = res.status;
    renderDashboard();
    poll();
  } else if (res && res.error === 'bad_password') {
    returnToLogin();
  } else {
    state.actionError = res && res.error === 'too_many_attempts' ? MESSAGE.tooMany : MESSAGE.retry;
    renderActions();
  }
}

$('status-control').addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button || !state.data) return;
  const { value } = button.dataset;
  state.actionError = '';
  if (value === state.data.status) {
    // Tapping where things already stand backs out of any ask.
    disarm();
    renderTaps();
    return;
  }
  if (isSecondTap('status', value)) changeStatus(value);
});

$('status-cancel').addEventListener('click', () => {
  disarm();
  renderTaps();
  const current = $('status-control').querySelector('.is-current');
  if (current) current.focus();
});

/* ---------- Unlocking a ballot ---------- */

async function unlockRow(ballotId) {
  disarm();
  state.unlocking = ballotId;
  state.unlockError = '';
  renderBallots();

  let res = null;
  try {
    res = await unlockBallot(state.password, ballotId);
  } catch {
    // Handled below as no response.
  }
  state.unlocking = null;
  if (!state.password) return; // A poll sent us back to Login while this was in flight.

  if (res && res.ok) {
    // Show it right away. The poll brings the new counts.
    const ballot = state.data.ballots.find((b) => b.ballotId === ballotId);
    if (ballot) Object.assign(ballot, { void: true, unlocked: true });
    renderBallots();
    poll();
  } else if (res && res.error === 'bad_password') {
    returnToLogin();
  } else {
    state.unlockError = res && res.error === 'too_many_attempts' ? MESSAGE.tooMany : MESSAGE.retry;
    renderBallots();
  }
}

$('ballot-rows').addEventListener('click', (event) => {
  const button = event.target.closest('.row__unlock');
  if (!button) return;
  const ballotId = button.dataset.ballot;
  state.unlockError = '';
  if (isSecondTap('ballot', ballotId)) unlockRow(ballotId);
});

/* ---------- Start ---------- */

const savedPassword = readPassword();
if (savedPassword) unlock(savedPassword, { silent: true });
