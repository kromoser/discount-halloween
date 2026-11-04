// Host page: login, dashboard and polling. It changes only the voting status.
// Everything else is fixed in the Sheet. Guest names are untrusted, so all text goes
// in through textContent, never as HTML: this page holds the host password.

import { host, setStatus } from './api.js';
import { POLL_HOST_MS, SHEET_URL } from './config.js';

const CATEGORIES = [
  { key: 'best', label: 'Best' },
  { key: 'favorite', label: 'Favorite' },
  { key: 'most_discount', label: 'Most discount' },
  { key: 'runner_up', label: 'Runner up' },
];

const PASSWORD_KEY = 'dh.hostPass';
const CONFIRM_MS = 5000;
// A second tap this soon is one accidental double-tap, not a decision to close.
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
  confirming: false,
  confirmStarted: 0,
  busy: false,
  actionError: '',
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

function renderActions() {
  const status = state.data.status;
  const confirming = status === 'OPEN' && state.confirming;

  $('open-voting').hidden = status !== 'SOON';
  $('close-voting').hidden = status !== 'OPEN' || confirming;
  $('confirm-close').hidden = !confirming;
  $('cancel-close').hidden = !confirming;
  $('reopen-voting').hidden = status !== 'CLOSED';

  let helper = '';
  if (status === 'OPEN' && !confirming) helper = "Closing shows results on every guest's phone.";
  if (status === 'CLOSED') helper = 'Guests now see results.';
  $('action-helper').textContent = helper;
  $('action-helper').hidden = !helper;

  ['open-voting', 'close-voting', 'confirm-close', 'reopen-voting'].forEach((id) => {
    $(id).disabled = state.busy;
  });

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

function ballotRow(ballot, { showTags }) {
  const row = el('div', 'row');
  row.classList.toggle('is-void', ballot.void);

  const top = el('span', 'row__top');
  top.append(el('span', 'row__name', ballot.name));
  if (showTags && ballot.void) top.append(el('span', 'tag tag--void', 'Void'));
  if (showTags && ballot.flagGroup !== null) top.append(el('span', 'tag tag--flag', 'Flag'));

  const time = formatTime(ballot.submittedAt);
  const meta = time ? `${time} · ${picksText(ballot.picks)}` : picksText(ballot.picks);
  row.append(top, el('span', 'row__meta', meta));
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

function renderBallots({ ballots }) {
  $('ballot-rows').replaceChildren(
    ...(ballots.length
      ? ballots.map((ballot) => ballotRow(ballot, { showTags: true }))
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
  renderBallots(data);
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
  cancelConfirm();
  state.data = null;
  state.busy = false;
  state.actionError = '';
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
    if (res.status !== 'OPEN') cancelConfirm();
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

/* ---------- Status actions ---------- */

let confirmTimer = null;

function cancelConfirm() {
  clearTimeout(confirmTimer);
  confirmTimer = null;
  state.confirming = false;
}

async function changeStatus(status) {
  cancelConfirm();
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

$('open-voting').addEventListener('click', () => changeStatus('OPEN'));
$('reopen-voting').addEventListener('click', () => changeStatus('OPEN'));

$('close-voting').addEventListener('click', () => {
  state.confirming = true;
  state.confirmStarted = Date.now();
  state.actionError = '';
  confirmTimer = setTimeout(() => {
    cancelConfirm();
    renderActions();
  }, CONFIRM_MS);
  renderActions();
  $('confirm-close').focus();
});

$('confirm-close').addEventListener('click', () => {
  if (Date.now() - state.confirmStarted < DOUBLE_TAP_MS) return;
  changeStatus('CLOSED');
});

$('cancel-close').addEventListener('click', () => {
  cancelConfirm();
  renderActions();
  $('close-voting').focus();
});

/* ---------- Start ---------- */

const savedPassword = readPassword();
if (savedPassword) unlock(savedPassword, { silent: true });
