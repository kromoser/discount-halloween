# Discount Halloween Ballot

A phone-first costume ballot for a 30-guest party. Guests type their name and four Polaroid numbers. The host watches live tallies on a password-protected page and closes voting, which flips every phone to the results.

Two static pages on GitHub Pages talk to one Google Apps Script web app, which is the only thing that can read the private Google Sheet. The full spec is [docs/PLAN.md](docs/PLAN.md).

| Page | URL |
| --- | --- |
| Guest | `https://kromoser.github.io/discount-halloween/` |
| Host (not linked from the guest page) | `https://kromoser.github.io/discount-halloween/host.html` |

## Setup and deployment

These steps need someone signed into Google and GitHub.

1. **Create the Sheet.** Make a new blank Google Sheet named "Discount Halloween Votes" and keep it private. Never "Publish to web", and never share it by link.
2. **Add the script.** In the Sheet, open Extensions → Apps Script. Replace the contents of `Code.gs` with this repo's [`apps-script/Code.gs`](apps-script/Code.gs). Under Project Settings, tick "Show appsscript.json manifest file in editor", then replace that file with this repo's [`apps-script/appsscript.json`](apps-script/appsscript.json). Save.
3. **Set the password.** Under Project Settings → Script Properties, add a property named `HOST_PASSWORD` with any value. Share it only with co-hosts. It never goes in this repo.
4. **Run `setup()` once.** In the editor, pick `setup` in the function menu, click Run, and approve the permissions prompt. On "Google hasn't verified this app", choose Advanced → Go to project. The `Votes` and `Settings` tabs appear in the Sheet. The blank `Sheet1` isn't used, so you can delete it.
5. **Deploy.** Choose Deploy → New deployment → type Web app, with Execute as: **Me** and Who has access: **Anyone**. Copy the URL ending in `/exec`.
6. **Wire the pages.** Paste the URL into [`assets/config.js`](assets/config.js) as `API_URL`, and optionally the Sheet's URL as `SHEET_URL`. Commit and push.
7. **Turn on Pages.** In the GitHub repo, go to Settings → Pages, choose "Deploy from a branch", then `main` / root. The site appears within a minute or two.
8. **Make the QR code** for the guest URL and print it for the board.

### Updating the script later

Paste the new code, then go to Deploy → Manage deployments → pencil icon → Version: **New version** → Deploy.

Never create a second deployment, because that changes the URL and breaks both pages. The `/dev` test URL only works while signed in as the owner, so don't put it in the config.

## Running the night

Fix anything by editing the Sheet. Changes reach guests within about 30 seconds, and the host page within 10.

| To do this | Edit this |
| --- | --- |
| Toss a ballot | Type `x` in its `void` cell (any non-blank value counts) |
| Change what guests see | `status` in `Settings`: `SOON`, `OPEN` or `CLOSED` |
| Change the highest Polaroid number | `board_size` in `Settings` |

A voided ballot's phone still can't vote again, so it stays tossed.

Before the party: run a full test, delete the test rows in `Votes` (keep the header), set `status` to `SOON` and `board_size` to the real count, then print the QR code and the numbers for the Polaroids. The full checklist is in the [plan](docs/PLAN.md#acceptance-tests-and-party-night).

## Local development

The site is plain HTML, CSS and ES modules with no build step. npm is only for local tooling.

```sh
npm install
npm start          # http://localhost:4173
```

Add `?mock=1` to run either page with no Google deployment:

- Guest: http://localhost:4173/index.html?mock=1
- Host: http://localhost:4173/host.html?mock=1 (password: `boo`)

Mock mode fakes the whole API. Its state lives in `localStorage`, so a guest tab and a host tab share it. The **Mock** panel in the corner switches the status, forces the next response to be any error, and resets everything. The same controls are on `window.dhMock` in the console.

## Tests

```sh
npm test               # Backend logic, backend wiring, and the mock checked against the backend
npm run test:smoke     # Both pages in Chrome, against mock mode and a local stand-in for Apps Script
```

`Code.gs` can't run outside Google, so the wiring tests run it against in-memory fakes of the Google services. They catch mistakes in the code but can't prove how Google behaves. That's what the [acceptance tests](docs/PLAN.md#acceptance-tests-and-party-night) on the live deployment are for.
