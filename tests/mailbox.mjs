// Mailbox: WHIP input and reusable guest links, through a locally running copy
// of mailbox/worker.js. A browser page plays the encoder: it POSTs a real WHIP
// offer exactly as OBS would and sends camera + mic.
// Usage:
//   node tests/serve.mjs --port 8787 &
//   (cd mailbox && npx wrangler dev --port 8790) &
//   node tests/mailbox.mjs
import { createRequire } from 'node:module';
const require = createRequire(process.env.PLAYWRIGHT_DIR || '/opt/node-tools/node_modules/');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:8787';
const MAILBOX = process.env.MAILBOX || 'http://127.0.0.1:8790';
const SHOTS = process.env.SHOTS || './test-shots';
const results = [];
const check = (n, ok, info = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000) { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } await sleep(250); } return null; }

const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, permissions: ['camera', 'microphone'] });
const errors = [];
const watch = (p, tag) => p.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
const studio = await ctx.newPage();
watch(studio, 'studio');
await studio.goto(`${BASE}/index.html`);
await studio.evaluate(() => localStorage.clear());
await studio.reload();
await studio.waitForFunction(() => window.studio);
const src = (i) => studio.evaluate((i) => { const s = window.studio.sources.all()[i]; return { state: s.state, detail: s.detail, video: s.videoFlowing, audio: s.hasAudio, mb: s.mb?.state }; }, i);

// Settings: enter the mailbox address.
await studio.click('.tabs button:has-text("Settings")');
const mbInput = studio.locator('.field:has-text("Mailbox") input').first();
await mbInput.fill(MAILBOX);
await mbInput.press('Enter');
await mbInput.blur();
const ice = await until(() => studio.evaluate(() => window.studio.mailboxIce.state === 'ok' && window.studio.mailboxIce));
check('Studio reaches the mailbox and gets its ICE servers', !!ice, JSON.stringify(ice));

// --- WHIP ---------------------------------------------------------------------
await studio.click('.tabs button:has-text("Sources")');
await studio.click('.kind-btn[data-kind="whip"]');
await studio.fill('input[placeholder^="Source name"]', 'OBS');
await studio.click('button:has-text("Add")');
const waiting = await until(async () => (await src(0)).state === 'waiting');
check('WHIP source connects to its box and waits for the encoder', !!waiting, (await src(0)).detail);
const url = await studio.evaluate(() => window.studio.sources.whipUrl(window.studio.sources.all()[0].id));
const shown = await studio.locator('.card .linkbox input').first().inputValue();
check('Source card shows the WHIP link', shown === url && url.startsWith(`${MAILBOX}/whip/`), url);

const enc = await ctx.newPage();
watch(enc, 'encoder');
await enc.goto(`${BASE}/receive.html`); // any page on the origin, just to import the modules
async function publish(u) {
  return enc.evaluate(async (u) => {
    const { waitForIceGathering } = await import('./js/rtc.js');
    const media = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: true });
    const pc = new RTCPeerConnection();
    for (const t of media.getTracks()) pc.addTransceiver(t, { direction: 'sendonly' });
    await pc.setLocalDescription(await pc.createOffer());
    await waitForIceGathering(pc);
    const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: pc.localDescription.sdp });
    const out = { status: r.status, location: r.headers.get('Location'), link: r.headers.get('Link'), text: '' };
    if (r.status !== 201) { out.text = await r.text(); pc.close(); return out; }
    await pc.setRemoteDescription({ type: 'answer', sdp: await r.text() });
    window.enc = { pc, resource: out.location };
    return out;
  }, u);
}
const good = await publish(url);
check('Encoder WHIP POST gets 201, Location and ICE servers in Link', good.status === 201 && !!good.location && /rel="ice-server"/.test(good.link || ''), `${good.status} ${good.location}`);
const live = await until(async () => { const s = await src(0); return s.state === 'live' && s.video && s.audio; });
check('Encoder video and audio arrive in the studio', !!live, (await src(0)).detail);
await studio.screenshot({ path: `${SHOTS}/06-whip-mailbox.png` });
await enc.evaluate(async () => { await fetch(window.enc.resource, { method: 'DELETE' }); window.enc.pc.close(); });
check('Stopping the encoder (DELETE) puts the source back to waiting', !!await until(async () => (await src(0)).state === 'waiting', 10000));
const again = await publish(url);
check('Encoder can start again with the same link', again.status === 201 && !!await until(async () => (await src(0)).state === 'live'));

await studio.evaluate(() => window.studio.sources.disconnect(window.studio.sources.all()[0].id));
await enc.evaluate(() => window.enc.pc.close());
const refused = await publish(url);
check('After Disconnect the encoder is refused (403)', refused.status === 403, refused.text);
await studio.click('.card button:has-text("Accept encoder")');
const accepted = await publish(url);
check('Accept encoder lets it in again', accepted.status === 201 && !!await until(async () => (await src(0)).state === 'live'));
await enc.evaluate(async () => { await fetch(window.enc.resource, { method: 'DELETE' }); window.enc.pc.close(); });

const box = url.split('/').pop();
const stolen = await enc.evaluate(([m, box]) => new Promise((res) => {
  const ws = new WebSocket(`${m.replace(/^http/, 'ws')}/studio/${box}?key=not-the-right-key-123`);
  ws.onopen = () => { ws.close(); res('opened'); };
  ws.onerror = () => res('refused');
}), [MAILBOX, box]);
check('Another studio with the wrong key cannot take the box', stolen === 'refused', stolen);

const notOpen = await studio.evaluate(async (m) => (await fetch(`${m}/whip/aaaaaaaaaaaaaaaaaaaaaaaa`, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: 'v=0\r\n' })).status, MAILBOX);
check('A link whose studio is not open answers 503', notOpen === 503, String(notOpen));

// --- reusable guest link ------------------------------------------------------------
await studio.click('.kind-btn[data-kind="peer"]');
await studio.fill('input[placeholder^="Source name"]', 'Guest');
await studio.click('button:has-text("Add")');
check('New invite-link sources use a reusable link', await studio.evaluate(() => window.studio.sources.all()[1].cfg.mode === 'mailbox'));
const link = await studio.evaluate(() => window.studio.sources.guestLink(window.studio.sources.all()[1].id));
const guest = await ctx.newPage();
watch(guest, 'guest');
await guest.goto(link);
await guest.click('#go');
check('Guest joins with the reusable link', !!await until(async () => { const s = await src(1); return s.state === 'live' && s.video; }), (await src(1)).detail);
await guest.reload();
check('After the guest refreshes, they reconnect by themselves', !!await until(async () => {
  const g = await guest.evaluate(() => document.querySelector('#state')?.textContent);
  const s = await src(1);
  return /Connected/.test(g) && s.state === 'live' && s.video;
}, 25000), await guest.evaluate(() => document.querySelector('#state')?.textContent));

await studio.reload();
await studio.waitForFunction(() => window.studio);
await studio.mouse.click(5, 300);
check('After the studio reloads, the guest reconnects by themselves', !!await until(async () => { const s = await src(1); return s.state === 'live' && s.video; }, 30000), (await src(1)).detail);
check('The WHIP source is waiting again after the studio reload', (await src(0)).state === 'waiting', (await src(0)).detail);

// The same workspace in a second tab takes the boxes over; "Use it here" takes them back.
const studio2 = await ctx.newPage();
await studio2.goto(`${BASE}/index.html`);
await studio2.waitForFunction(() => window.studio);
check('A second studio tab takes over; the first one says so', !!await until(async () => (await src(0)).mb === 'replaced'), (await src(0)).detail);
await studio2.close();
await studio.locator('.card', { hasText: 'OBS' }).locator('button:has-text("Use it here")').click();
check('Use it here takes the source back', !!await until(async () => (await src(0)).state === 'waiting'));

console.log('Page errors:', errors.length ? errors : 'none');
await browser.close();
console.log(`${results.filter(Boolean).length}/${results.length} mailbox checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
