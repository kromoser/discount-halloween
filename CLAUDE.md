# Discount Halloween Ballot

A phone-first costume ballot for a 30-guest party: two static pages on GitHub Pages, one Google Apps Script web app, one private Google Sheet.

- **The spec is `docs/PLAN.md`.** Read it in full before writing code, and follow its "Build order (agent)" section step by step. Each step ends with a check that must pass before the next.
- **Visual reference: `docs/mockups/`.** One file per screen (Ballot, Voted, Results, Host login, Host dashboard; the Results mockup is no longer used). The markup and inline styles are the reference for layout, type, color and copy. Ignore the `support.js` line and the `<script type="text/x-dc">` block, which belong to the design tool. Intended differences from the mockups are listed in the plan: the host page has a three-way status control and an Unlock button on each ballot but no Toss button, there are "Voting opens soon" and "Voting is closed" states, guests never see results, and the logo is a bouncing wordmark rather than a price tag.
- `docs/architecture.png` shows how the pieces connect.

Rules that matter most:
- Vanilla HTML, CSS and ES modules. No framework, bundler or runtime npm dependencies.
- Nothing secret goes in the repo or page code. The host password lives only in Apps Script Script Properties.
- The public `state` response never contains counts or results of any kind, even once voting is `CLOSED`. The winners are announced in person, from the host page.
- POST to Apps Script as a plain-text body with no custom headers (avoids the CORS preflight).
- Build and test the UI against `?mock=1` first. Stop and ask Kevin when you reach the deployment hand-off (step 7).
