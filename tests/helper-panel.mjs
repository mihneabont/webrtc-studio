// Helper status panel: shows the helper running or not, turns it off from the
// page, notices it coming back, and flags an older helper as updatable.
// Usage: python3 -m http.server 8080 &   then   node tests/helper-panel.mjs
// (the test starts and stops its own helper on port 8788)
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(`${process.env.PLAYWRIGHT_DIR || '/opt/node-tools/node_modules'}/`);
const { chromium } = require('playwright');
const r = []; const check = (n, ok, i = '') => { r.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${i ? `  (${i})` : ''}`); };
const startHelper = () => spawn('node', ['signaling-server/server.mjs', '--port', '8788'], { stdio: 'ignore' });
const until = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise((res) => setTimeout(res, 250)); } return false; };

const b = await chromium.launch();
const page = await b.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.goto('http://127.0.0.1:8080/index.html'); await page.waitForTimeout(1500);
const pill = page.locator('.pill-btn');
check('Top bar shows Helper off', (await pill.innerText()).includes('Helper off'));
await pill.dispatchEvent('pointerdown');
const panel = page.locator('[data-section="helper"]');
check('Clicking the pill opens the helper panel in Settings', await panel.isVisible());
check('Panel says not running and offers Turn on + Install', /Not running/.test(await panel.innerText())
  && await panel.locator('button', { hasText: 'Turn on' }).count() === 1 && await panel.locator('button', { hasText: 'Install helper (Windows)' }).count() === 1);

let h = startHelper();
check('Panel notices the helper starting (polling)', await until(async () => /Helper: Running/.test(await panel.innerText())));
const txt = await panel.innerText();
check('Panel shows address, version and features', /localhost:8788/.test(txt) && /version\s*6/.test(txt) && /OBS \/ WHIP input/.test(txt), txt.replace(/\s+/g, ' ').slice(0, 200));
check('Top bar shows Helper on', await until(async () => (await pill.innerText()).includes('Helper on'), 3000));
check('Running panel offers Turn off and Reinstall', await panel.locator('button', { hasText: 'Turn off' }).count() === 1 && await panel.locator('button', { hasText: 'Reinstall helper' }).count() === 1);

await panel.locator('button', { hasText: 'Turn off' }).click();
const exited = await until(() => h.exitCode !== null, 5000);
check('Turn off stops the helper process', exited);
check('Panel shows Not running after Turn off', await until(async () => /Not running/.test(await panel.innerText())));

// An older helper (no version) is flagged as updatable.
await page.route('http://localhost:8788/helper', (route) => route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ app: 'webrtc-studio-helper', features: ['relay', 'forward', 'whip-in'], lan: [], port: 8788 }) }));
await page.evaluate(() => window.studio.detectHelper());
check('Older helper shows Update available', await until(async () => /update is available/.test(await panel.innerText()) && (await pill.innerText()).includes('update available')));
check('Older helper panel offers Update helper', await panel.locator('button', { hasText: 'Update helper (Windows)' }).count() === 1);
await page.unroute('http://localhost:8788/helper');

// Turn on when no helper is registered: it waits, then explains.
await page.evaluate(() => window.studio.detectHelper());
await until(async () => /Not running/.test(await panel.innerText()));
await panel.locator('button', { hasText: 'Turn on' }).click();
check('Turn on without a registered helper explains what to do', await until(async () => /did not start/.test(await panel.innerText()), 15000));
check('No page errors', errs.length === 0, errs.join(' | '));
console.log(`${r.filter(Boolean).length}/${r.length} helper panel checks passed`);
await b.close(); if (h.exitCode === null) h.kill();
