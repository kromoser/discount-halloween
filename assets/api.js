// The only module that talks to the backend. With ?mock=1 on the URL it uses
// mock-api.js instead and never touches the network.
//
// Transport rules, which keep browsers from blocking the calls:
// - POST sends the JSON as the raw body with no custom headers, so it goes out as
//   text/plain and needs no CORS preflight, which Apps Script can't answer.
// - Never set Content-Type: application/json.
// - fetch follows Apps Script's 302 redirect by itself.

import { API_URL } from './config.js';

export const IS_MOCK = new URLSearchParams(location.search).get('mock') === '1';

const TIMEOUT_MS = 30000;

async function request(url, init) {
  if (!/^https?:\/\//.test(API_URL)) throw new Error('API_URL is not set in assets/config.js');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

const live = {
  getState: () => request(`${API_URL}?action=state`),
  post: (payload) => request(API_URL, { method: 'POST', body: JSON.stringify(payload) }),
};

const backend = IS_MOCK
  ? import('./mock-api.js').then((mock) => {
    mock.installDevTools();
    return mock.backend;
  })
  : Promise.resolve(live);

// Each call resolves to the backend's JSON, including { ok: false, ... } errors.
// It rejects only when no usable response came back.

export async function getState() {
  return (await backend).getState();
}

export async function vote({ name, picks, deviceId, fingerprint, userAgent }) {
  return (await backend).post({ action: 'vote', name, picks, deviceId, fingerprint, userAgent });
}

export async function host(password) {
  return (await backend).post({ action: 'host', password });
}

export async function setStatus(password, status) {
  return (await backend).post({ action: 'setStatus', password, status });
}
