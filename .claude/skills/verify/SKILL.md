---
name: verify
description: Build, launch and drive Time Tracer in a headless browser to verify a change end-to-end against the live GitHub API.
---

# Verifying Time Tracer changes at runtime

Angular SPA; the only surface is the browser. Unit/integration tests run in CI
(`npm test`) — verification means driving the served app.

## Launch

```bash
npx ng serve --port 4300 --no-live-reload   # background; ready when :4300 answers
```

## Drive (headless Chromium + Playwright)

Playwright is a devDependency; the browser is preinstalled at
`/opt/pw-browsers/chromium` (do NOT `playwright install`). From a script,
import it via the repo's node_modules:

```js
import { chromium } from '<repo>/node_modules/playwright/index.mjs';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  proxy: { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' },
});
```

Open `http://localhost:4300/r/<owner>/<repo>` (GitHub), `gl/…`, `bb/…` etc.,
wait for a tree entry to appear, then click through the flow under test.
`timonkrebs/Time-Tracer` itself is a good live fixture (anonymous rate limit:
60 requests/hour — budget them).

## Remote-session gotchas (Claude Code on the web)

- **Browser TLS trust**: outbound HTTPS is re-terminated by the agent proxy.
  Chromium reads `~/.pki/nssdb`, which starts empty. Fix (needs
  `apt-get install -y libnss3-tools`, after `apt-get update`): split
  `/root/.ccr/ca-bundle.crt` on `BEGIN CERTIFICATE` and `certutil -A -t "C,,"`
  each part into `sql:$HOME/.pki/nssdb`. Never use `--ignore-certificate-errors`.
- **CORS preflights**: the egress gateway answers `OPTIONS` with 405, so the
  browser's preflight to api.github.com fails even though GitHub supports CORS
  in production. Synthesize only the preflight via `page.route` (fulfill
  OPTIONS with 204 + `access-control-allow-origin: *` + the requested
  headers) and `route.continue()` everything else — real requests still hit
  the live API.
