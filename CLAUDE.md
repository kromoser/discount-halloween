# Discount Halloween Ballot

A phone-first costume ballot for a 30-guest party: two static pages on GitHub Pages, one Google Apps Script web app, one private Google Sheet.

- **The spec is `docs/PLAN.md`.** Read it in full before writing code, and follow its "Build order (agent)" section step by step. Each step ends with a check that must pass before the next.
- **Visual reference: `docs/mockups/`.** One file per screen (Ballot, Voted, Results, Host login, Host dashboard). The markup and inline styles are the reference for layout, type, color and copy. Ignore the `support.js` line and the `<script type="text/x-dc">` block, which belong to the design tool. Two intended differences from the mockups are listed in the plan: the host page has no Toss button, and there is a "Voting opens soon" state.
- `docs/architecture.png` shows how the pieces connect.

Rules that matter most:
- Vanilla HTML, CSS and ES modules. No framework, bundler or runtime npm dependencies.
- Nothing secret goes in the repo or page code. The host password lives only in Apps Script Script Properties.
- While voting is not `CLOSED`, the public `state` response contains no counts of any kind.
- POST to Apps Script as a plain-text body with no custom headers (avoids the CORS preflight).
- Build and test the UI against `?mock=1` first. Stop and ask Kevin when you reach the deployment hand-off (step 7).
