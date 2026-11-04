// End-to-end checks of both pages against ?mock=1. Run with: npm run test:smoke

import http from 'node:http';
import { test, expect } from '@playwright/test';

const GUEST = '/index.html?mock=1';

// Each test gets a fresh browser context, so its own localStorage.
async function openGuest(page, status = 'OPEN') {
  await page.goto(GUEST);
  await setStatus(page, status);
  await page.reload();
}

async function setStatus(page, status) {
  await page.waitForFunction(() => window.dhMock);
  await page.evaluate((s) => window.dhMock.setStatus(s), status);
}

async function failNext(page, code) {
  await page.evaluate((c) => window.dhMock.failNext(c), code);
}

const screen = (page, name) => page.locator(`#screen-${name}`);

async function fillBallot(page, { name = 'Sam', picks = ['12', '7', '21', '3'] } = {}) {
  await page.fill('#voter-name', name);
  await page.fill('#pick-best', picks[0]);
  await page.fill('#pick-favorite', picks[1]);
  await page.fill('#pick-most_discount', picks[2]);
  await page.fill('#pick-runner_up', picks[3]);
}

test.beforeEach(async ({ page }) => {
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') page.errors.push(m.text()); });
});

test.afterEach(async ({ page }) => {
  expect(page.errors).toEqual([]);
});

test.describe('guest page', () => {
  test('walks Soon, Ballot, Voted, Results, and a reload keeps the right screen', async ({ page }) => {
    await openGuest(page, 'SOON');
    await expect(screen(page, 'soon')).toBeVisible();
    await expect(page.getByText('Voting opens soon.')).toBeVisible();

    await page.reload();
    await expect(screen(page, 'soon')).toBeVisible();

    await setStatus(page, 'OPEN');
    await page.reload();
    await expect(screen(page, 'ballot')).toBeVisible();
    await expect(page.locator('#cast')).toBeDisabled();

    await fillBallot(page, { name: 'Dana' });
    await expect(page.locator('#cast')).toBeEnabled();
    await page.click('#cast');

    await expect(screen(page, 'voted')).toBeVisible();
    await expect(page.locator('#receipt-customer')).toHaveText('Dana');
    await expect(page.locator('#receipt-picks')).toContainText('#12');
    await expect(page.locator('#receipt-picks')).toContainText('#21');

    await page.reload();
    await expect(screen(page, 'voted')).toBeVisible();
    await expect(page.locator('#receipt-customer')).toHaveText('Dana');

    await setStatus(page, 'CLOSED');
    await page.reload();
    await expect(screen(page, 'results')).toBeVisible();
    await expect(page.locator('.winner')).toHaveCount(4);
    await expect(page.locator('.winner').nth(0)).toContainText('#12');
    await expect(page.locator('#results-footer')).toHaveText('28 ballots · Winners, find the host');
  });

  test('saves the ballot and device ID to localStorage', async ({ page }) => {
    await openGuest(page);
    await fillBallot(page);
    await page.click('#cast');
    await expect(screen(page, 'voted')).toBeVisible();

    const stored = await page.evaluate(() => ({
      ballot: JSON.parse(localStorage.getItem('dh.ballot')),
      device: localStorage.getItem('dh.deviceId'),
    }));
    expect(stored.ballot.name).toBe('Sam');
    expect(stored.ballot.picks).toEqual({ best: 12, favorite: 7, most_discount: 21, runner_up: 3 });
    expect(stored.ballot.ballotId).toBeTruthy();
    expect(stored.ballot.submittedAt).toBeTruthy();
    expect(stored.device).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('sends a hex fingerprint and the user agent with a vote', async ({ page }) => {
    await openGuest(page);
    await fillBallot(page);
    await page.click('#cast');
    await expect(screen(page, 'voted')).toBeVisible();

    const last = await page.evaluate(() => window.dhMock.state().ballots.at(-1));
    expect(last.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(last.deviceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('flips to Results by itself when the host closes, from any waiting screen', async ({ page }) => {
    test.setTimeout(90000);
    await openGuest(page, 'SOON');
    await setStatus(page, 'OPEN');
    await expect(screen(page, 'ballot')).toBeVisible({ timeout: 25000 });

    await page.fill('#voter-name', 'half typed');
    await setStatus(page, 'CLOSED');
    await expect(screen(page, 'results')).toBeVisible({ timeout: 25000 });
  });

  test('a poll while filling in the ballot leaves the form alone', async ({ page }) => {
    await openGuest(page);
    await fillBallot(page, { name: 'Half typed', picks: ['12', '', '', ''] });
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForTimeout(700);
    await expect(screen(page, 'ballot')).toBeVisible();
    await expect(page.locator('#voter-name')).toHaveValue('Half typed');
    await expect(page.locator('#pick-best')).toHaveValue('12');
  });
});

test.describe('ballot validation', () => {
  test.beforeEach(async ({ page }) => {
    await openGuest(page);
    await expect(screen(page, 'ballot')).toBeVisible();
  });

  for (const [value, message] of [
    ['0', 'No #0 on the board'],
    ['31', 'No #31 on the board'],
    ['47', 'No #47 on the board'],
  ]) {
    test(`${value} shows "${message}" and keeps the sticker dashed`, async ({ page }) => {
      await fillBallot(page, { picks: [value, '7', '21', '3'] });
      await expect(page.locator('#pick-best-error')).toHaveText(message);
      const sticker = page.locator('#pick-best').locator('xpath=..');
      await expect(sticker).toHaveClass(/is-invalid/);
      await expect(sticker).toHaveCSS('border-top-style', 'dashed');
      await expect(page.locator('#cast')).toBeDisabled();
    });
  }

  test('letters are stripped and say why', async ({ page }) => {
    await page.locator('#pick-best').pressSequentially('ab');
    await expect(page.locator('#pick-best')).toHaveValue('');
    await expect(page.locator('#pick-best-error')).toHaveText('Numbers only');
    await page.locator('#pick-best').pressSequentially('12');
    await expect(page.locator('#pick-best')).toHaveValue('12');
    await expect(page.locator('#pick-best-error')).toBeHidden();
  });

  test('mixed characters keep only the digits', async ({ page }) => {
    await page.locator('#pick-best').pressSequentially('1x2');
    await expect(page.locator('#pick-best')).toHaveValue('12');
    await expect(page.locator('#pick-best').locator('xpath=..')).toHaveClass(/is-valid/);
  });

  test('a valid number fills the sticker', async ({ page }) => {
    await page.fill('#pick-best', '12');
    const sticker = page.locator('#pick-best').locator('xpath=..');
    await expect(sticker).toHaveClass(/is-valid/);
    await expect(sticker).toHaveCSS('background-color', 'rgb(255, 214, 10)');
  });

  test('the same number can go in every category', async ({ page }) => {
    await fillBallot(page, { picks: ['7', '7', '7', '7'] });
    await expect(page.locator('#cast')).toBeEnabled();
  });

  test('a blank name keeps the button disabled', async ({ page }) => {
    await fillBallot(page, { name: '   ' });
    await expect(page.locator('#cast')).toBeDisabled();
  });

  test('Enter in the last field submits', async ({ page }) => {
    await fillBallot(page);
    await page.press('#pick-runner_up', 'Enter');
    await expect(screen(page, 'voted')).toBeVisible();
  });

  test('Enter does nothing while the ballot is incomplete', async ({ page }) => {
    await page.fill('#voter-name', 'Sam');
    await page.press('#voter-name', 'Enter');
    await page.waitForTimeout(600);
    await expect(screen(page, 'ballot')).toBeVisible();
  });

  test('the button reads Casting… and disables while sending', async ({ page }) => {
    await fillBallot(page);
    await page.click('#cast');
    // The first click starts it, so this runs during the mock's latency.
    await expect(page.locator('#cast')).toHaveText('Casting…');
    await expect(page.locator('#cast')).toBeDisabled();
    await expect(screen(page, 'voted')).toBeVisible();
  });

  test('a board size change is applied to the form live', async ({ page }) => {
    await page.fill('#pick-best', '31');
    await expect(page.locator('#pick-best-error')).toBeVisible();
    await page.evaluate(() => window.dhMock.setBoardSize(40));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.locator('#pick-best-error')).toBeHidden();
  });
});

test.describe('submit outcomes', () => {
  test.beforeEach(async ({ page }) => {
    await openGuest(page);
    await fillBallot(page);
  });

  test('already_voted shows the note in place of the receipt lines, and survives a reload', async ({ page }) => {
    await failNext(page, 'already_voted');
    await page.click('#cast');
    await expect(screen(page, 'voted')).toBeVisible();
    await expect(page.getByText('This phone already voted.')).toBeVisible();
    await expect(page.locator('#receipt-detail')).toBeHidden();

    await page.reload();
    await expect(screen(page, 'voted')).toBeVisible();
    await expect(page.getByText('This phone already voted.')).toBeVisible();
  });

  test('invalid_pick marks that field and re-enables the button', async ({ page }) => {
    await failNext(page, 'invalid_pick');
    await page.click('#cast');
    await expect(page.locator('#pick-best-error')).toHaveText('No #12 on the board');
    await expect(page.locator('#cast')).toBeEnabled();
    await expect(page.locator('#cast')).toHaveText('Cast ballot');
    await expect(screen(page, 'ballot')).toBeVisible();

    await page.fill('#pick-best', '13');
    await expect(page.locator('#pick-best-error')).toBeHidden();
  });

  test('invalid_name marks the name and re-enables the button', async ({ page }) => {
    await failNext(page, 'invalid_name');
    await page.click('#cast');
    await expect(page.locator('#name-error')).toBeVisible();
    await expect(page.locator('#cast')).toBeEnabled();
    await page.fill('#voter-name', 'Sam B.');
    await expect(page.locator('#name-error')).toBeHidden();
  });

  test('closed re-fetches state and shows Results', async ({ page }) => {
    await setStatus(page, 'CLOSED');
    await page.click('#cast');
    await expect(screen(page, 'results')).toBeVisible();
  });

  test('not_open re-fetches state and shows Soon', async ({ page }) => {
    await setStatus(page, 'SOON');
    await page.click('#cast');
    await expect(screen(page, 'soon')).toBeVisible();
  });

  test('a network failure keeps the form filled, and a retry works', async ({ page }) => {
    await failNext(page, 'network');
    await page.click('#cast');
    await expect(page.locator('#form-error')).toHaveText("Didn't go through. Try again.");
    await expect(page.locator('#voter-name')).toHaveValue('Sam');
    await expect(page.locator('#pick-most_discount')).toHaveValue('21');
    await expect(page.locator('#cast')).toBeEnabled();

    await page.click('#cast');
    await expect(screen(page, 'voted')).toBeVisible();
  });

  test('a server_error reads the same as a network failure', async ({ page }) => {
    await failNext(page, 'server_error');
    await page.click('#cast');
    await expect(page.locator('#form-error')).toHaveText("Didn't go through. Try again.");
    await expect(page.locator('#cast')).toBeEnabled();
  });

  test('a replay from this device after clearing the saved ballot is caught by the server', async ({ page }) => {
    await page.click('#cast');
    await expect(screen(page, 'voted')).toBeVisible();
    await page.evaluate(() => localStorage.removeItem('dh.ballot'));
    await page.reload();
    await fillBallot(page);
    await page.click('#cast');
    await expect(page.getByText('This phone already voted.')).toBeVisible();
  });
});

test.describe('connection trouble', () => {
  test('two failed fetches show Can\'t connect, and Try again recovers', async ({ page }) => {
    // Every state call fails until the test sets dh.test.online.
    await page.route('**/assets/mock-api.js', async (route) => {
      const res = await route.fetch();
      const body = (await res.text()).replace(
        'async getState() {',
        "async getState() { if (!localStorage.getItem('dh.test.online')) throw new TypeError('offline');",
      );
      await route.fulfill({ response: res, body });
    });
    await page.goto(GUEST);

    await expect(screen(page, 'offline')).toBeVisible();
    await expect(page.getByText("Can't reach the ballot box.")).toBeVisible();

    await page.evaluate(() => localStorage.setItem('dh.test.online', '1'));
    await page.click('#retry');
    await expect(screen(page, 'ballot')).toBeVisible();
  });

  test('one failed fetch retries quietly', async ({ page }) => {
    await page.goto(GUEST);
    await page.waitForFunction(() => window.dhMock);
    await failNext(page, 'network');
    await page.reload();
    await expect(screen(page, 'ballot')).toBeVisible();
    await expect(screen(page, 'offline')).toBeHidden();
  });

  test('a failed poll never throws a guest off a half-filled ballot', async ({ page }) => {
    await openGuest(page);
    await page.fill('#voter-name', 'Half typed');
    for (let i = 0; i < 3; i += 1) {
      await failNext(page, 'network');
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await page.waitForTimeout(500);
    }
    await expect(screen(page, 'ballot')).toBeVisible();
    await expect(page.locator('#voter-name')).toHaveValue('Half typed');
  });

  test('voting still works with storage blocked', async ({ page }) => {
    await page.addInitScript(() => {
      // The mock needs its own key to work; only the guest page's keys are blocked.
      const blocked = (key) => key === 'dh.ballot' || key === 'dh.deviceId';
      const { getItem, setItem } = Storage.prototype;
      Storage.prototype.getItem = function (key) {
        if (blocked(key)) throw new Error('blocked');
        return getItem.call(this, key);
      };
      Storage.prototype.setItem = function (key, value) {
        if (blocked(key)) throw new Error('blocked');
        return setItem.call(this, key, value);
      };
    });
    await page.goto(GUEST);
    await fillBallot(page);
    await page.click('#cast');
    await expect(screen(page, 'voted')).toBeVisible();
    await expect(page.locator('#receipt-customer')).toHaveText('Sam');
  });
});

test.describe('results', () => {
  test('a tie shows both numbers and "each"', async ({ page }) => {
    await openGuest(page, 'CLOSED');
    const tie = page.locator('.winner').nth(3);
    await expect(tie).toContainText('Runner up');
    await expect(tie).toContainText('Tie');
    await expect(tie).toContainText('#3 & #18');
    await expect(tie).toContainText('6 each');
  });

  test('a winner shows its votes', async ({ page }) => {
    await openGuest(page, 'CLOSED');
    const best = page.locator('.winner').nth(0);
    await expect(best).toContainText('Winner');
    await expect(best).toContainText('#12');
    await expect(best).toContainText('11 votes');
  });

  test('no ballots at all still renders, with singular wording right', async ({ page }) => {
    await page.goto(GUEST);
    await page.waitForFunction(() => window.dhMock);
    await page.evaluate(() => {
      window.dhMock.clearBallots();
      window.dhMock.setStatus('CLOSED');
    });
    await page.reload();
    await expect(page.locator('.winner').nth(0)).toContainText('No votes');
    await expect(page.locator('.winner').nth(0)).toContainText('0 votes');
    await expect(page.locator('#results-footer')).toHaveText('0 ballots · Winners, find the host');
  });

  test('a guest who never voted still sees Results', async ({ page }) => {
    await openGuest(page, 'CLOSED');
    await expect(screen(page, 'results')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('dh.ballot'))).toBeNull();
  });
});

test.describe('secrecy and safety', () => {
  test('a guest page shows no counts while voting is open', async ({ page }) => {
    await openGuest(page);
    await expect(screen(page, 'ballot')).toBeVisible();
    const res = await page.evaluate(async () => {
      const mock = await import('/assets/mock-api.js');
      return mock.backend.getState();
    });
    expect(res).toEqual({ ok: true, status: 'OPEN', boardSize: 30 });
  });

  test('the mock is never loaded without ?mock=1, and no page code holds it', async ({ page }) => {
    const requested = [];
    page.on('request', (r) => requested.push(r.url()));
    await page.goto('/index.html');
    await page.waitForTimeout(1200);
    expect(requested.some((u) => u.includes('mock-api'))).toBe(false);
    expect(await page.evaluate(() => typeof window.dhMock)).toBe('undefined');
    // With no API_URL set, this is the honest screen to land on.
    await expect(screen(page, 'offline')).toBeVisible();
  });

  test('a name made of HTML is shown as text on the receipt', async ({ page }) => {
    await openGuest(page);
    const name = '<img src=x onerror=boom()>';
    await fillBallot(page, { name });
    await page.click('#cast');
    await expect(page.locator('#receipt-customer')).toHaveText(name);
    await expect(page.locator('#receipt-customer img')).toHaveCount(0);
  });
});

/* ---------- Host page ---------- */

const HOST = '/host.html?mock=1';
const PASSWORD = 'boo';

const hostScreen = (page, name) => page.locator(`#screen-${name}`);

async function login(page, password = PASSWORD) {
  await page.fill('#host-password', password);
  await page.click('#unlock');
}

async function openHost(page, status = 'OPEN') {
  await page.goto(HOST);
  await setStatus(page, status);
  await login(page);
  await expect(hostScreen(page, 'dash')).toBeVisible();
}

// What the 10 s poll does, without the wait.
async function pollNow(page) {
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
}

test.describe('host login', () => {
  test('starts on Login, and the page is not linked from the guest page', async ({ page }) => {
    await page.goto(HOST);
    await expect(hostScreen(page, 'login')).toBeVisible();
    await expect(hostScreen(page, 'dash')).toBeHidden();
    await expect(page.getByText('Employees must wash hands')).toBeVisible();

    await page.goto(GUEST);
    await expect(page.locator('a[href*="host"]')).toHaveCount(0);
  });

  test('a wrong password shows the error and stays on Login', async ({ page }) => {
    await page.goto(HOST);
    await page.waitForFunction(() => window.dhMock);
    await login(page, 'nope');
    await expect(page.locator('#login-error')).toHaveText('Wrong password. Try again.');
    await expect(hostScreen(page, 'login')).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem('dh.hostPass'))).toBeNull();
  });

  test('the 11th wrong try says to wait', async ({ page }) => {
    await page.goto(HOST);
    await page.waitForFunction(() => window.dhMock);
    for (let i = 0; i < 10; i += 1) {
      await login(page, `nope${i}`);
      await expect(page.locator('#unlock')).toBeEnabled();
      await expect(page.locator('#login-error')).toHaveText('Wrong password. Try again.');
    }
    await login(page, 'nope again');
    await expect(page.locator('#login-error')).toHaveText('Too many tries. Wait 10 minutes.');
  });

  test('the right password opens the Dashboard and goes in sessionStorage only', async ({ page }) => {
    await page.goto(HOST);
    await page.waitForFunction(() => window.dhMock);
    await login(page);
    await expect(hostScreen(page, 'dash')).toBeVisible();
    const stored = await page.evaluate(() => ({
      session: sessionStorage.getItem('dh.hostPass'),
      local: Object.keys(localStorage).filter((k) => k.includes('Pass')),
    }));
    expect(stored.session).toBe(PASSWORD);
    expect(stored.local).toEqual([]);
  });

  test('a reload skips Login using the saved password', async ({ page }) => {
    await openHost(page);
    await page.reload();
    await expect(hostScreen(page, 'dash')).toBeVisible();
  });

  test('a stale saved password falls back to Login quietly', async ({ page }) => {
    await page.goto(HOST);
    await page.evaluate(() => sessionStorage.setItem('dh.hostPass', 'old password'));
    await page.reload();
    await expect(page.locator('#unlock')).toHaveText('Unlock');
    await expect(hostScreen(page, 'login')).toBeVisible();
    await expect(page.locator('#login-error')).toBeHidden();
    expect(await page.evaluate(() => sessionStorage.getItem('dh.hostPass'))).toBeNull();
  });

  test('Enter submits the form', async ({ page }) => {
    await page.goto(HOST);
    await page.waitForFunction(() => window.dhMock);
    await page.fill('#host-password', PASSWORD);
    await page.press('#host-password', 'Enter');
    await expect(hostScreen(page, 'dash')).toBeVisible();
  });

  test('no connection says so, instead of blaming the password', async ({ page }) => {
    await page.goto(HOST);
    await page.waitForFunction(() => window.dhMock);
    await failNext(page, 'network');
    await login(page);
    await expect(page.locator('#login-error')).toHaveText("Can't reach the ballot box. Check your signal.");
  });
});

test.describe('host dashboard', () => {
  test('shows the stats, with Flagged in yellow', async ({ page }) => {
    await openHost(page);
    await expect(page.locator('#stat-ballots')).toHaveText('27');
    await expect(page.locator('#stat-board')).toHaveText('30');
    await expect(page.locator('#stat-flagged')).toHaveText('2');
    await expect(page.locator('#stat-flagged')).toHaveCSS('color', 'rgb(255, 214, 10)');
  });

  test('Flagged is not yellow at zero', async ({ page }) => {
    await page.goto(HOST);
    await page.waitForFunction(() => window.dhMock);
    await page.evaluate(() => window.dhMock.clearBallots());
    await login(page);
    await expect(page.locator('#stat-flagged')).toHaveText('0');
    await expect(page.locator('#stat-flagged')).toHaveCSS('color', 'rgb(243, 239, 232)');
    await expect(page.locator('#flag-section')).toBeHidden();
    await expect(page.locator('#ballot-rows')).toContainText('No ballots yet.');
    await expect(page.locator('#live-results')).toContainText('No votes yet.');
  });

  test('live results show the top 3, sized by share of ballots', async ({ page }) => {
    await openHost(page);
    const best = page.locator('.category').nth(0);
    await expect(best.locator('.category__name')).toHaveText('Best');
    await expect(best.locator('.bar')).toHaveCount(3);
    await expect(best.locator('.bar__number')).toHaveText(['#12', '#4', '#19']);
    await expect(best.locator('.bar__votes')).toHaveText(['11', '7', '5']);
    // 11 of 27 rounds to 41%.
    expect(await best.locator('.bar__fill').first().evaluate((n) => n.style.width)).toBe('41%');
  });

  test('every number tied for first gets the orange bar and bright text', async ({ page }) => {
    await openHost(page);
    const runner = page.locator('.category').nth(3);
    await expect(runner.locator('.bar__number')).toHaveText(['#3', '#18', '#12']);
    const orange = 'rgb(255, 106, 19)';
    await expect(runner.locator('.bar__fill').nth(0)).toHaveCSS('background-color', orange);
    await expect(runner.locator('.bar__fill').nth(1)).toHaveCSS('background-color', orange);
    await expect(runner.locator('.bar__fill').nth(2)).toHaveCSS('background-color', 'rgb(107, 98, 93)');
    await expect(runner.locator('.bar__number').nth(1)).toHaveCSS('color', 'rgb(243, 239, 232)');
    await expect(runner.locator('.bar__number').nth(2)).toHaveCSS('color', 'rgb(154, 145, 138)');
  });

  test('a tie among more than 3 still shows every leader', async ({ page }) => {
    await page.goto(HOST);
    await page.waitForFunction(() => window.dhMock);
    await page.evaluate(() => {
      window.dhMock.clearBallots();
      const db = window.dhMock.state();
      db.ballots = [1, 2, 3, 4, 5].map((n) => ({
        ballotId: `b_${n}`,
        submittedAt: '2026-10-31T21:00:00-04:00',
        name: `G${n}`,
        picks: { best: n, favorite: 1, most_discount: 1, runner_up: 1 },
        deviceId: `00000000-0000-4000-8000-00000000000${n}`,
        fingerprint: `f${n}`,
        void: false,
      }));
      localStorage.setItem('dh.mock', JSON.stringify(db));
    });
    await login(page);
    await expect(page.locator('.category').nth(0).locator('.bar')).toHaveCount(5);
  });

  test('Same phone? lists each group, with the Sheet instructions and no Toss button', async ({ page }) => {
    await openHost(page);
    const section = page.locator('#flag-section');
    await expect(section).toBeVisible();
    await expect(section.locator('.row')).toHaveCount(2);
    await expect(section.locator('.row__name')).toHaveText(['Dana R.', 'Dana']);
    await expect(section.locator('.row__meta').first()).toContainText('12 · 7 · 21 · 3');
    await expect(section).toContainText('To toss one, type x in its Void cell in the Sheet.');
    await expect(page.getByRole('button', { name: /toss|undo/i })).toHaveCount(0);
  });

  test('the Open the Sheet link appears only when SHEET_URL is set', async ({ page }) => {
    await openHost(page);
    await expect(page.locator('#sheet-link')).toBeHidden();

    await page.route('**/assets/config.js', async (route) => {
      const res = await route.fetch();
      const body = (await res.text()).replace("SHEET_URL = ''", "SHEET_URL = 'https://example.com/sheet'");
      await route.fulfill({ response: res, body });
    });
    await page.reload();
    await expect(page.locator('#sheet-link')).toBeVisible();
    await expect(page.locator('#sheet-link')).toHaveAttribute('href', 'https://example.com/sheet');
  });

  test('Ballots lists all of them newest first, tagged, with void struck through', async ({ page }) => {
    await openHost(page);
    const rows = page.locator('#ballot-rows .row');
    await expect(rows).toHaveCount(28);
    await expect(rows.locator('.row__name').first()).toHaveText('Theo');
    await expect(page.locator('#ballot-rows .tag--flag')).toHaveCount(2);

    const voided = rows.filter({ hasText: 'Test ballot' });
    await expect(voided.locator('.tag--void')).toHaveText('Void');
    await expect(voided.locator('.row__name')).toHaveCSS('text-decoration-line', 'line-through');
    await expect(page.getByText('Best · Fav · Disc · Runner')).toBeVisible();
  });

  test('a void made in the Sheet drops from tallies and flags on the next poll', async ({ page }) => {
    await openHost(page);
    await page.evaluate(() => {
      const dana = window.dhMock.state().ballots.find((b) => b.name === 'Dana');
      window.dhMock.toggleVoid(dana.ballotId);
    });
    await pollNow(page);
    await expect(page.locator('#stat-ballots')).toHaveText('26');
    await expect(page.locator('#stat-flagged')).toHaveText('0');
    await expect(page.locator('#flag-section')).toBeHidden();
  });

  test('a name made of HTML is shown as text and never runs', async ({ page }) => {
    await page.goto(HOST);
    await page.waitForFunction(() => window.dhMock);
    const name = '<img src=x onerror="window.pwned=1">';
    await page.evaluate((n) => {
      const db = window.dhMock.state();
      db.ballots.push({ ...db.ballots[0], ballotId: 'b_evil', name: n, fingerprint: db.ballots.find((b) => b.name === 'Dana').fingerprint, void: false });
      localStorage.setItem('dh.mock', JSON.stringify(db));
    }, name);
    await login(page);
    await expect(page.locator('#ballot-rows .row__name').first()).toHaveText(name);
    await expect(page.locator('#screen-dash img')).toHaveCount(0);
    expect(await page.evaluate(() => window.pwned)).toBeUndefined();
  });

  test('the footer shows the update time with seconds', async ({ page }) => {
    await openHost(page);
    await expect(page.locator('#updated')).toHaveText(/^Updated \d{1,2}:\d{2}:\d{2}\s?[AP]M$/);
  });
});

test.describe('host status actions', () => {
  test('SOON: one tap opens voting', async ({ page }) => {
    await openHost(page, 'SOON');
    await expect(page.locator('#status-text')).toHaveText('Voting soon');
    await expect(page.locator('#close-voting')).toBeHidden();
    await page.click('#open-voting');
    await expect(page.locator('#status-text')).toHaveText('Voting open');
    await expect(page.locator('#status-pill .pill__dot')).toHaveCSS('background-color', 'rgb(255, 106, 19)');
    expect(await page.evaluate(() => window.dhMock.state().status)).toBe('OPEN');
  });

  test('OPEN: the first tap asks, the second closes', async ({ page }) => {
    await openHost(page);
    await expect(page.getByText("Closing shows results on every guest's phone.")).toBeVisible();

    await page.click('#close-voting');
    await expect(page.locator('#confirm-close')).toHaveText('Tap again to close');
    await expect(page.locator('#confirm-close')).toHaveCSS('background-color', 'rgb(255, 214, 10)');
    await expect(page.locator('#cancel-close')).toBeVisible();
    expect(await page.evaluate(() => window.dhMock.state().status)).toBe('OPEN');

    await page.waitForTimeout(450);
    await page.click('#confirm-close');
    await expect(page.locator('#status-text')).toHaveText('Closed');
    expect(await page.evaluate(() => window.dhMock.state().status)).toBe('CLOSED');
  });

  test('an accidental double-tap does not close', async ({ page }) => {
    await openHost(page);
    await page.locator('#close-voting').click();
    await page.evaluate(() => document.getElementById('confirm-close').click());
    await page.waitForTimeout(500);
    await expect(page.locator('#confirm-close')).toBeVisible();
    expect(await page.evaluate(() => window.dhMock.state().status)).toBe('OPEN');
  });

  test('Cancel goes back without closing', async ({ page }) => {
    await openHost(page);
    await page.click('#close-voting');
    await page.click('#cancel-close');
    await expect(page.locator('#close-voting')).toBeVisible();
    await expect(page.locator('#confirm-close')).toBeHidden();
    expect(await page.evaluate(() => window.dhMock.state().status)).toBe('OPEN');
  });

  test('the ask reverts by itself after 5 s', async ({ page }) => {
    await openHost(page);
    await page.click('#close-voting');
    await expect(page.locator('#confirm-close')).toBeVisible();
    await expect(page.locator('#close-voting')).toBeVisible({ timeout: 6000 });
    await expect(page.locator('#confirm-close')).toBeHidden();
  });

  test('a poll during the ask leaves it in place', async ({ page }) => {
    await openHost(page);
    await page.click('#close-voting');
    await pollNow(page);
    await page.waitForTimeout(600);
    await expect(page.locator('#confirm-close')).toBeVisible();
  });

  test('CLOSED: a ghost Reopen button, one tap', async ({ page }) => {
    await openHost(page, 'CLOSED');
    await expect(page.locator('#status-text')).toHaveText('Closed');
    await expect(page.getByText('Guests now see results.')).toBeVisible();
    await expect(page.locator('#reopen-voting')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await page.click('#reopen-voting');
    await expect(page.locator('#status-text')).toHaveText('Voting open');
  });

  test('a failed status change says so, and leaves things as they were', async ({ page }) => {
    await openHost(page, 'SOON');
    await failNext(page, 'network');
    await page.click('#open-voting');
    await expect(page.locator('#action-error')).toHaveText("Didn't go through. Try again.");
    await expect(page.locator('#open-voting')).toBeEnabled();
    await expect(page.locator('#status-text')).toHaveText('Voting soon');

    await page.click('#open-voting');
    await expect(page.locator('#status-text')).toHaveText('Voting open');
    await expect(page.locator('#action-error')).toBeHidden();
  });
});

test.describe('host polling', () => {
  test('a changed password returns to Login and drops the saved one', async ({ page }) => {
    await openHost(page);
    await failNext(page, 'bad_password');
    await pollNow(page);
    await expect(hostScreen(page, 'login')).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem('dh.hostPass'))).toBeNull();
  });

  test('a lost connection keeps the numbers and says so, then recovers', async ({ page }) => {
    await openHost(page);
    await failNext(page, 'network');
    await pollNow(page);
    await expect(page.locator('#updated')).toContainText("Can't reach the ballot box");
    await expect(page.locator('#stat-ballots')).toHaveText('27');

    await pollNow(page);
    await expect(page.locator('#updated')).not.toContainText("Can't reach");
  });

  test('a lockout started elsewhere keeps the dashboard up and says so', async ({ page }) => {
    await openHost(page);
    await failNext(page, 'too_many_attempts');
    await pollNow(page);
    await expect(page.locator('#updated')).toContainText('Too many tries');
    await expect(hostScreen(page, 'dash')).toBeVisible();
  });

  test('a new ballot appears within one 10 s poll', async ({ page }) => {
    test.setTimeout(30000);
    await openHost(page);
    await page.evaluate(async () => {
      const mock = await import('/assets/mock-api.js');
      await mock.backend.post({
        action: 'vote',
        name: 'Latecomer',
        picks: { best: 1, favorite: 2, most_discount: 3, runner_up: 4 },
        deviceId: '11111111-1111-4111-8111-111111111111',
        fingerprint: 'abcd',
      });
    });
    await expect(page.locator('#ballot-rows .row__name').first()).toHaveText('Latecomer', { timeout: 12000 });
    await expect(page.locator('#stat-ballots')).toHaveText('28');
  });
});

test.describe('host and guest together', () => {
  // The check for build step 6: closing on the host tab flips an open guest tab to
  // Results within one poll. Tabs in one context share localStorage, like the real mock.
  for (const start of ['ballot', 'voted']) {
    test(`closing flips a guest tab on the ${start} screen to Results within one poll`, async ({ context }) => {
      test.setTimeout(60000);
      const guest = await context.newPage();
      await guest.goto(GUEST);
      await expect(screen(guest, 'ballot')).toBeVisible();
      if (start === 'voted') {
        await fillBallot(guest);
        await guest.click('#cast');
        await expect(screen(guest, 'voted')).toBeVisible();
      }

      const hostTab = await context.newPage();
      await hostTab.goto(HOST);
      await hostTab.waitForFunction(() => window.dhMock);
      await login(hostTab);
      await hostTab.click('#close-voting');
      await hostTab.waitForTimeout(450);
      await hostTab.click('#confirm-close');
      await expect(hostTab.locator('#status-text')).toHaveText('Closed');

      // One poll is 20 s plus up to 3 s of jitter.
      await expect(screen(guest, 'results')).toBeVisible({ timeout: 24000 });
      await expect(guest.locator('.winner').nth(3)).toContainText('Runner up');

      await hostTab.click('#reopen-voting');
      await expect(hostTab.locator('#status-text')).toHaveText('Voting open');
    });
  }

  test('a guest tab shows no counts while voting is open, with votes in', async ({ context }) => {
    const guest = await context.newPage();
    await guest.goto(GUEST);
    await expect(screen(guest, 'ballot')).toBeVisible();
    await expect(guest.locator('.winner')).toHaveCount(0);
    expect(await guest.locator('body').innerText()).not.toMatch(/\bballots ·|\bvotes\b/i);
  });
});

/* ---------- Live transport ---------- */

// Runs the real api.js path, not the mock, against a local stand-in for Apps Script
// on other origins. Like the real thing, /exec does the work and answers with a 302
// to a second host holding the JSON, and it can't answer a CORS preflight. So if the
// page ever sends one, the call fails here the same way it would in production.
test.describe('live transport', () => {
  const EXEC_PORT = 4174;
  const ECHO_PORT = 4175;
  const EXEC = `http://localhost:${EXEC_PORT}/macros/s/TEST/exec`;

  let execServer;
  let echoServer;
  let seen;
  let echoIsBroken;

  const listen = (server, port) => new Promise((resolve) => { server.listen(port, resolve); });
  const close = (server) => new Promise((resolve) => { server.close(resolve); });

  test.beforeAll(async () => {
    const answers = new Map();

    execServer = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });

        if (req.method === 'OPTIONS') {
          res.writeHead(405);
          res.end();
          return;
        }

        const key = String(answers.size);
        let answer = { ok: true, status: 'OPEN', boardSize: 30 };
        if (req.method === 'POST') {
          answer = JSON.parse(body).action === 'vote'
            ? { ok: true, ballotId: 'b_live', submittedAt: '2026-10-31T21:41:07-04:00' }
            : { ok: false, error: 'bad_password', message: 'Wrong password.' };
        }
        answers.set(key, answer);
        res.writeHead(302, {
          location: `http://localhost:${ECHO_PORT}/macros/echo?user_content_key=${key}`,
          'access-control-allow-origin': '*',
        });
        res.end();
      });
    });

    echoServer = http.createServer((req, res) => {
      const key = new URL(req.url, 'http://localhost').searchParams.get('user_content_key');
      const headers = { 'access-control-allow-origin': '*' };
      if (echoIsBroken) {
        res.writeHead(200, { ...headers, 'content-type': 'text/html' });
        res.end('<html>Service unavailable</html>');
        return;
      }
      res.writeHead(200, { ...headers, 'content-type': 'application/json' });
      res.end(JSON.stringify(answers.get(key)));
    });

    await listen(execServer, EXEC_PORT);
    await listen(echoServer, ECHO_PORT);
  });

  test.afterAll(async () => {
    await close(execServer);
    await close(echoServer);
  });

  test.beforeEach(async ({ page }) => {
    seen = [];
    echoIsBroken = false;
    await page.route('**/assets/config.js', async (route) => {
      const res = await route.fetch();
      const body = (await res.text()).replace('PASTE_APPS_SCRIPT_EXEC_URL_HERE', EXEC);
      await route.fulfill({ response: res, body });
    });
  });

  test('GET state and POST vote go out as simple requests and survive the redirect', async ({ page }) => {
    const requested = [];
    page.on('request', (r) => requested.push(r.url()));

    await page.goto('/index.html');
    await expect(screen(page, 'ballot')).toBeVisible();
    expect(seen[0].method).toBe('GET');
    expect(seen[0].url).toBe('/macros/s/TEST/exec?action=state');

    await fillBallot(page);
    await page.click('#cast');
    await expect(screen(page, 'voted')).toBeVisible();

    const post = seen.find((r) => r.method === 'POST');
    expect(post.url).toBe('/macros/s/TEST/exec');
    expect(seen.filter((r) => r.method === 'OPTIONS')).toEqual([]);

    // These are what keep the browser from sending a preflight.
    expect(post.headers['content-type']).toMatch(/^text\/plain/);
    const expected = /^(host|connection|content-length|content-type|accept|accept-encoding|accept-language|origin|referer|user-agent|pragma|cache-control|priority|sec-.*)$/;
    expect(Object.keys(post.headers).filter((h) => !expected.test(h))).toEqual([]);

    const body = JSON.parse(post.body);
    expect(body.action).toBe('vote');
    expect(body.name).toBe('Sam');
    expect(body.picks).toEqual({ best: 12, favorite: 7, most_discount: 21, runner_up: 3 });
    expect(body.deviceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(body.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(body.userAgent).toContain('Mozilla');

    await expect(page.locator('#receipt-customer')).toHaveText('Sam');

    // The mock never loads in live mode.
    expect(requested.some((u) => u.includes('mock-api'))).toBe(false);
    expect(await page.evaluate(() => typeof window.dhMock)).toBe('undefined');
    await expect(page.locator('.mock-panel')).toHaveCount(0);
  });

  test('host calls carry the password in the body only, never the URL', async ({ page }) => {
    await page.goto('/host.html');
    await page.fill('#host-password', 'letmein');
    await page.click('#unlock');

    await expect.poll(() => seen.length).toBeGreaterThan(0);
    expect(seen[0].method).toBe('POST');
    expect(seen[0].url).toBe('/macros/s/TEST/exec');
    expect(JSON.parse(seen[0].body)).toEqual({ action: 'host', password: 'letmein' });
    expect(seen[0].headers['content-type']).toMatch(/^text\/plain/);
    expect(seen.filter((r) => r.method === 'OPTIONS')).toEqual([]);
    await expect(page.locator('#login-error')).toHaveText('Wrong password. Try again.');
  });

  test('an HTML error page from Google counts as a failed call, not a crash', async ({ page }) => {
    echoIsBroken = true;
    await page.goto('/index.html');
    await expect(screen(page, 'offline')).toBeVisible();
  });
});

/* ---------- Small phones ---------- */

test.describe('at 320 px wide', () => {
  test.use({ viewport: { width: 320, height: 568 } });

  const fitsWidth = (page) => page.evaluate(() => {
    const { scrollWidth, clientWidth } = document.documentElement;
    return scrollWidth <= clientWidth;
  });

  for (const [status, name] of [['SOON', 'soon'], ['OPEN', 'ballot'], ['CLOSED', 'results']]) {
    test(`the ${name} screen does not scroll sideways`, async ({ page }) => {
      await openGuest(page, status);
      await expect(screen(page, name)).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      expect(await fitsWidth(page)).toBe(true);
    });
  }

  test('the voted screen does not scroll sideways, even with a long name', async ({ page }) => {
    await openGuest(page);
    await fillBallot(page, { name: 'W'.repeat(40) });
    await page.click('#cast');
    await expect(screen(page, 'voted')).toBeVisible();
    expect(await fitsWidth(page)).toBe(true);
  });

  test('a tie of four does not run off the card', async ({ page }) => {
    await page.goto(GUEST);
    await page.waitForFunction(() => window.dhMock);
    await page.evaluate(() => {
      const db = window.dhMock.state();
      db.status = 'CLOSED';
      db.ballots = [11, 22, 23, 24].map((n, i) => ({
        ...db.ballots[0],
        ballotId: `b_${i}`,
        deviceId: `00000000-0000-4000-8000-00000000000${i}`,
        fingerprint: `f${i}`,
        void: false,
        picks: { best: n, favorite: n, most_discount: n, runner_up: n },
      }));
      localStorage.setItem('dh.mock', JSON.stringify(db));
    });
    await page.reload();
    await expect(page.locator('.winner').first()).toContainText('#11 & #22 & #23 & #24');
    await page.evaluate(() => document.fonts.ready);
    expect(await fitsWidth(page)).toBe(true);
  });

  test('both host screens do not scroll sideways', async ({ page }) => {
    await page.goto(HOST);
    await page.waitForFunction(() => window.dhMock);
    expect(await fitsWidth(page)).toBe(true);
    await login(page);
    await expect(hostScreen(page, 'dash')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    expect(await fitsWidth(page)).toBe(true);
  });
});
