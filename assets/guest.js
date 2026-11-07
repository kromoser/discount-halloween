// Guest page. One render() picks the visible screen from two inputs: the server's
// status, and whether this browser has already voted.

import { getState, vote } from './api.js';
import { POLL_GUEST_MS } from './config.js';
import { fingerprint } from './fingerprint.js';

const CATEGORIES = [
  { key: 'best', label: 'Best' },
  { key: 'favorite', label: 'Favorite' },
  { key: 'most_discount', label: 'Most discount' },
  { key: 'runner_up', label: 'Runner up' },
];

const DEVICE_KEY = 'dh.deviceId';
const BALLOT_KEY = 'dh.ballot';
const JITTER_MS = 3000;
const RETRY_DELAY_MS = 1000;
const FAILURES_BEFORE_OFFLINE = 2;
const NAME_MAX = 40;

// Results don't poll: they only change through voids, and a reload picks those up.
const POLLING_SCREENS = new Set(['soon', 'ballot', 'voted', 'offline']);
// A failed poll must not throw a guest off these screens: the first holds their
// half-filled form, and the second is already the final answer.
const SURVIVES_FAILED_POLL = new Set(['ballot', 'results']);

const $ = (id) => document.getElementById(id);

const screens = {
  loading: $('screen-loading'),
  soon: $('screen-soon'),
  ballot: $('screen-ballot'),
  voted: $('screen-voted'),
  results: $('screen-results'),
  offline: $('screen-offline'),
};

/* ---------- Storage ---------- */

// If storage is blocked, voting still works: values last for this page load, and the
// one-per-phone check rests on the server's device ID and fingerprint alone.
const memory = new Map();

function readStored(key) {
  try {
    const value = localStorage.getItem(key);
    if (value !== null) return value;
  } catch {
    // Storage blocked.
  }
  return memory.has(key) ? memory.get(key) : null;
}

function writeStored(key, value) {
  memory.set(key, value);
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage blocked. The in-memory copy still covers this page load.
  }
}

function newUuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  // crypto.randomUUID only exists on HTTPS and localhost.
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function deviceId() {
  let id = readStored(DEVICE_KEY);
  if (!id) {
    id = newUuid();
    writeStored(DEVICE_KEY, id);
  }
  return id;
}

function readBallot() {
  try {
    const saved = JSON.parse(readStored(BALLOT_KEY));
    if (saved && (saved.alreadyVoted || (saved.ballotId && saved.picks))) return saved;
  } catch {
    // Unreadable: treat it as no saved ballot. The server still knows this device.
  }
  return null;
}

function saveBallot(ballot) {
  state.ballot = ballot;
  writeStored(BALLOT_KEY, JSON.stringify(ballot));
}

function forgetBallot() {
  state.ballot = null;
  memory.delete(BALLOT_KEY);
  try {
    localStorage.removeItem(BALLOT_KEY);
  } catch {
    // Storage blocked: the in-memory copy was all there was.
  }
}

// How a phone that has voted asks whether the host unlocked it. A receipt's ballot ID is
// exact, so a new ballot can't be mistaken for the old one. A phone told "already voted"
// has only its device ID. Every other phone asks nothing.
function unlockRef() {
  if (!state.ballot) return undefined;
  return state.ballot.ballotId || deviceId();
}

/* ---------- State ---------- */

const state = {
  status: null,
  boardSize: 30,
  results: [],
  ballotCount: 0,
  ballot: null,
  offline: false,
  casting: false,
};

function currentScreen() {
  if (state.offline) return 'offline';
  if (!state.status) return 'loading';
  if (state.status === 'CLOSED') return 'results';
  if (state.status === 'SOON') return 'soon';
  return state.ballot ? 'voted' : 'ballot';
}

/* ---------- Ballot form ---------- */

const form = $('ballot-form');
const nameInput = $('voter-name');
const nameError = $('name-error');
const formError = $('form-error');
const castButton = $('cast');

const fields = CATEGORIES.map(({ key }) => ({
  key,
  input: form.querySelector(`[data-pick="${key}"]`),
  sticker: form.querySelector(`[data-pick="${key}"]`).closest('.sticker'),
  error: $(`pick-${key}-error`),
  typedNonDigit: false,
  rejected: false,
}));

function pickValue(field) {
  return field.input.value === '' ? null : Number(field.input.value);
}

function isOnBoard(n) {
  return Number.isInteger(n) && n >= 1 && n <= state.boardSize;
}

function fieldError(field) {
  const raw = field.input.value;
  if (raw === '') return field.typedNonDigit ? 'Numbers only' : '';
  if (field.rejected || !isOnBoard(pickValue(field))) return `No #${raw} on the board`;
  return '';
}

function isNameValid() {
  const length = nameInput.value.trim().length;
  return length >= 1 && length <= NAME_MAX;
}

function isReady() {
  return isNameValid() && fields.every((field) => isOnBoard(pickValue(field)));
}

function setError(el, input, message) {
  el.textContent = message;
  el.hidden = !message;
  if (message) {
    input.setAttribute('aria-invalid', 'true');
  } else {
    input.removeAttribute('aria-invalid');
  }
}

function updateForm() {
  fields.forEach((field) => {
    const message = fieldError(field);
    const filled = field.input.value !== '';
    field.sticker.classList.toggle('is-valid', filled && !message);
    field.sticker.classList.toggle('is-invalid', Boolean(message));
    setError(field.error, field.input, message);
  });
  castButton.disabled = state.casting || !isReady();
  castButton.textContent = state.casting ? 'Casting…' : 'Cast ballot';
}

function onPickInput(field) {
  const raw = field.input.value;
  const digits = raw.replace(/[^0-9]/g, '').slice(0, 2);
  field.typedNonDigit = digits !== raw;
  if (field.typedNonDigit) field.input.value = digits;
  field.rejected = false;
  formError.hidden = true;
  updateForm();
}

fields.forEach((field) => {
  field.input.addEventListener('input', () => onPickInput(field));
});

nameInput.addEventListener('input', () => {
  setError(nameError, nameInput, '');
  formError.hidden = true;
  updateForm();
});

/* ---------- Submit ---------- */

const printPromise = fingerprint();

function currentPicks() {
  const picks = {};
  fields.forEach((field) => { picks[field.key] = pickValue(field); });
  return picks;
}

function showRetry() {
  formError.textContent = "Didn't go through. Try again.";
  formError.hidden = false;
}

async function handleVoteResult(res, name, picks) {
  if (res && res.ok) {
    saveBallot({ ballotId: res.ballotId, name, picks, submittedAt: res.submittedAt });
    return;
  }

  switch (res && res.error) {
    case 'already_voted':
      saveBallot({ alreadyVoted: true });
      break;
    case 'invalid_pick': {
      const field = fields.find((f) => f.key === res.field);
      if (field) {
        field.rejected = true;
      } else {
        showRetry();
      }
      break;
    }
    case 'invalid_name':
      setError(nameError, nameInput, "That name won't work. Try another.");
      break;
    case 'closed':
    case 'not_open':
      await refresh();
      break;
    default:
      // No response, or a server_error: the form stays filled. Retrying is safe,
      // because a second success is impossible for the same device ID.
      showRetry();
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.casting || !isReady()) return;

  const name = nameInput.value.trim();
  const picks = currentPicks();

  state.casting = true;
  formError.hidden = true;
  updateForm();

  let res = null;
  try {
    res = await vote({
      name,
      picks,
      deviceId: deviceId(),
      fingerprint: await printPromise,
      userAgent: navigator.userAgent,
    });
  } catch {
    // Handled below as a failure to send.
  }

  await handleVoteResult(res, name, picks);
  state.casting = false;
  updateForm();
  render();
});

/* ---------- Render ---------- */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function receiptLine(label, value) {
  const line = el('div', 'receipt__line');
  line.append(el('span', '', label), el('span', '', value));
  return line;
}

function renderReceipt() {
  const { ballot } = state;
  const already = Boolean(ballot.alreadyVoted);
  $('receipt-detail').hidden = already;
  $('receipt-already').hidden = !already;
  if (already) return;

  $('receipt-customer').textContent = ballot.name;
  $('receipt-picks').replaceChildren(
    ...CATEGORIES.map(({ key, label }) => receiptLine(label, `#${ballot.picks[key]}`)),
  );
}

// Back to the form, filled in with what they sent, so fixing one pick doesn't mean a
// walk back to the board for the other three.
function reopenBallot() {
  const { name = '', picks = {} } = state.ballot;
  forgetBallot();
  nameInput.value = name;
  fields.forEach((field) => {
    const pick = picks[field.key];
    field.input.value = pick === undefined ? '' : String(pick);
    field.typedNonDigit = false;
    field.rejected = false;
  });
  $('reopened-note').hidden = false;
  updateForm();
}

function winnerCard(result) {
  const count = result.winners.length;
  const tie = count > 1;

  let tag = 'Winner';
  if (count === 0) tag = 'No votes';
  if (tie) tag = 'Tie';

  let votes = `${result.votes} ${result.votes === 1 ? 'vote' : 'votes'}`;
  if (tie) votes = `${result.votes} each`;

  const card = el('div', 'winner');
  const band = el('div', 'winner__band');
  band.append(el('span', '', result.label), el('span', '', tag));

  const body = el('div', 'winner__body');
  const number = count ? result.winners.map((n) => `#${n}`).join(' & ') : '–';
  body.append(el('span', 'winner__number', number), el('span', 'winner__pill', votes));

  card.append(band, body);
  return card;
}

function renderResults() {
  $('winners').replaceChildren(...state.results.map(winnerCard));
  const noun = state.ballotCount === 1 ? 'ballot' : 'ballots';
  $('results-footer').textContent = `${state.ballotCount} ${noun} · Winners, find the host`;
}

let shownScreen = 'loading';

function render() {
  const screen = currentScreen();
  Object.entries(screens).forEach(([name, node]) => { node.hidden = name !== screen; });
  if (screen === 'voted') renderReceipt();
  if (screen === 'results') renderResults();
  if (screen !== shownScreen) {
    shownScreen = screen;
    window.scrollTo(0, 0);
  }
  schedulePoll();
}

/* ---------- Polling ---------- */

let pollTimer = null;
let latestRequest = 0;
let failures = 0;

function schedulePoll() {
  clearTimeout(pollTimer);
  pollTimer = null;
  if (document.hidden || !POLLING_SCREENS.has(currentScreen())) return;
  // Jitter, so 30 phones don't hit the script in step.
  pollTimer = setTimeout(refresh, POLL_GUEST_MS + Math.random() * JITTER_MS);
}

function applyState(res) {
  const boardChanged = res.boardSize !== state.boardSize;
  state.status = res.status;
  state.boardSize = res.boardSize;
  state.results = res.results || [];
  state.ballotCount = res.ballotCount || 0;
  state.offline = false;
  if (boardChanged) updateForm();
}

async function refresh() {
  latestRequest += 1;
  const request = latestRequest;
  const ref = unlockRef();

  let res = null;
  try {
    res = await getState(ref);
  } catch {
    // Counted as a failure below.
  }

  // A newer request is on its way and will have the last word.
  if (request !== latestRequest) return;

  if (res && res.ok) {
    failures = 0;
    // The ref must still match: by now this answer may be about an older ballot.
    if (res.unlocked && ref && ref === unlockRef()) reopenBallot();
    applyState(res);
    render();
    return;
  }

  failures += 1;
  if (!state.status && failures < FAILURES_BEFORE_OFFLINE) {
    pollTimer = setTimeout(refresh, RETRY_DELAY_MS);
    return;
  }
  if (failures >= FAILURES_BEFORE_OFFLINE && !SURVIVES_FAILED_POLL.has(currentScreen())) {
    state.offline = true;
  }
  render();
}

$('retry').addEventListener('click', () => {
  state.offline = false;
  state.status = null;
  failures = 0;
  render();
  refresh();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearTimeout(pollTimer);
    pollTimer = null;
  } else {
    refresh();
  }
});

/* ---------- Start ---------- */

deviceId();
state.ballot = readBallot();
updateForm();
refresh();
