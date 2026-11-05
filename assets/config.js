// Public configuration. These values ship to every guest's phone, so nothing
// secret belongs here. The host password lives only in Apps Script Script Properties.

// The Apps Script web app URL, ending in /exec. Set during deployment (see README).
export const API_URL = 'https://script.google.com/macros/s/AKfycbx0H1_ylPgHXfI3AWdOwmE3W-sK49NL-gm3IY4ZRbJyQkcAmxh3wmbgmqZz2_q3GC6J/exec';

// Optional: the Google Sheet's URL. Adds an "Open the Sheet" link to the host page.
export const SHEET_URL = '';

export const POLL_GUEST_MS = 20000;
export const POLL_HOST_MS = 10000;
