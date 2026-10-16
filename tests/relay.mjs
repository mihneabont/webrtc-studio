// Tests the OPTIONAL signaling relay: reusable links and automatic reconnection.
// Usage: node signaling-server/server.mjs --static . &   then   node tests/relay.mjs
import { createRequire } from 'node:module';

const require = createRequire(process.env.PLAYWRIGHT_DIR || '/opt/node-tools/node_modules/');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:8787';
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000) { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } await sleep(250); } return null; }

const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, permissions: ['camera', 'microphone'] });
const errors = [];
const watch = (p, tag) => p.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));

const studio = await ctx.newPage(); watch(studio, 'studio');
await studio.goto(`${BASE}/index.html`);
await studio.evaluate(() => localStorage.clear());
await studio.reload();
await studio.waitForFunction(() => window.studio);
await studio.evaluate((base) => { window.studio.store.ws.settings.signalingUrl = base; window.studio.store.saveNow(); window.studio.setupRelay(); }, BASE);
await until(() => studio.evaluate(() => window.studio.relay?.state === 'open'));
const link = await studio.evaluate(() => { const s = window.studio.sources.add({ name: 'Relay cam' }); return window.studio.sources.relayLink(s.id); });

const contrib = await ctx.newPage(); watch(contrib, 'contrib');
await contrib.goto(link);
await contrib.click('#go');
check('Relay contributor connects with a reusable link', !!await until(() => studio.evaluate(() => window.studio.sources.all()[0].state === 'live')));

// Contributor reloads the page: same link, join again.
await contrib.reload();
await contrib.click('#go');
check('Contributor rejoins with the same link', !!await until(() => studio.evaluate(() => window.studio.sources.all()[0].state === 'live' && window.studio.sources.all()[0].videoFlowing)));

// Programme receiver via relay.
const outLink = await studio.evaluate(async () => { const o = window.studio.outputs.add({ kind: 'peer' }); await window.studio.outputs.start(o.id); return window.studio.outputs.relayLink(o.id); });
const rx = await ctx.newPage(); watch(rx, 'rx');
await rx.goto(outLink);
check('Relay receiver connects to a started output', !!await until(() => rx.evaluate(() => window.receiver.video.videoWidth > 0)));

// Studio reloads: everything should come back without touching the remote pages.
await studio.reload();
await studio.waitForFunction(() => window.studio);
const back = await until(() => studio.evaluate(() => window.studio.sources.all()[0]?.state === 'live'), 45000);
check('After a studio reload the contributor reconnects automatically', !!back);
await studio.evaluate(() => window.studio.outputs.start(window.studio.outputs.all()[0].id));
check('Receiver reconnects after the output is restarted', !!await until(() => studio.evaluate(() => window.studio.outputs.all()[0].state === 'live'), 45000));

console.log('Page errors:', errors.length ? errors : 'none');
await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} relay checks passed`);
process.exit(failed ? 1 : 0);
