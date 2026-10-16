// OBS / WHIP encoder ingest through the optional helper. A browser page plays
// the encoder: it POSTs a real WHIP offer exactly as OBS would (Bearer token,
// application/sdp, all candidates in the offer) and sends camera + mic.
import { createRequire } from 'node:module';
const require = createRequire(process.env.PLAYWRIGHT_DIR || '/opt/node-tools/node_modules/');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:8787';
const results = [];
const check = (n, ok, info = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000) { const t = Date.now(); while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } await sleep(250); } return null; }

const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, permissions: ['camera', 'microphone'] });
const errors = [];
const studio = await ctx.newPage();
studio.on('pageerror', (e) => errors.push(e.message));
await studio.goto(`${BASE}/index.html`);
await studio.evaluate(() => localStorage.clear());
await studio.reload();
await studio.waitForFunction(() => window.studio?.helperOrigin);
check('Studio detects the helper it is served from', true);

// Add the source through the UI, then use the "Use the helper" button.
await studio.fill('input[placeholder^="Source name"]', 'OBS');
await studio.selectOption('.tab-body:not(.hidden) select', 'obs');
await studio.click('button:has-text("Add")');
await studio.click('button:has-text("Use the helper at")');
await until(() => studio.evaluate(() => window.studio.relay?.state === 'open'));
await studio.click('.card button:has-text("Accept encoder")').catch(() => {});
const { url, token } = await studio.evaluate(() => { const s = window.studio.sources.all()[0]; return { url: window.studio.sources.obsUrl(s.id), token: s.cfg.token }; });
const shownUrl = await studio.locator('.card .linkbox input').first().inputValue();
check('Source card shows the Server URL and Bearer Token for OBS', shownUrl === url && !!token, url);
await studio.screenshot({ path: `${process.env.SHOTS || '.'}/07-obs-source.png` });

const enc = await ctx.newPage();
await enc.goto(`${BASE}/receive.html`); // any page on the origin, just to import the module
async function publish(tok) {
  return enc.evaluate(async ([url, tok]) => {
    const { whipPublish, waitForIceGathering } = await import('./js/rtc.js');
    const media = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: true });
    const pc = new RTCPeerConnection();
    for (const t of media.getTracks()) pc.addTransceiver(t, { direction: 'sendonly' });
    await pc.setLocalDescription(await pc.createOffer());
    await waitForIceGathering(pc);
    try {
      const r = await whipPublish({ url, token: tok, sdp: pc.localDescription.sdp });
      await pc.setRemoteDescription({ type: 'answer', sdp: r.answer });
      window.enc = { pc, resource: r.resourceUrl };
      return { ok: true, resource: r.resourceUrl };
    } catch (e) { pc.close(); return { ok: false, status: e.status, message: e.message }; }
  }, [url, tok]);
}
const bad = await publish('wrong-token');
check('Wrong token is rejected with 401', !bad.ok && bad.status === 401, bad.message);
const good = await publish(token);
check('Encoder WHIP POST gets 201 + Location', good.ok && !!good.resource, good.resource);
const live = await until(() => studio.evaluate(() => { const s = window.studio.sources.all()[0]; return s.state === 'live' && s.videoFlowing && s.hasAudio; }));
check('Encoder video and audio arrive in the studio', !!live);
const stats = await until(() => studio.evaluate(() => { const v = window.studio.sources.all()[0].stats?.in.video; return v?.width ? `${v.width}x${v.height} ${v.codec}` : null; }));
check('Studio shows stats for the encoder feed', !!stats, stats);
await studio.evaluate(() => { const s = window.studio.sources.all()[0]; window.studio.switcher.setPreview({ kind: 'source', id: s.id }); window.studio.switcher.cut(); });
await sleep(1500);
await studio.screenshot({ path: `${process.env.SHOTS || '.'}/08-obs-live.png` });
await enc.evaluate(async () => { await fetch(window.enc.resource, { method: 'DELETE' }); window.enc.pc.close(); });
const ended = await until(() => studio.evaluate(() => window.studio.sources.all()[0].state === 'ended'), 10000);
check('Stopping the encoder (DELETE) ends the source cleanly', !!ended);
const again = await publish(token);
check('Encoder can start again with the same URL and token', again.ok && !!await until(() => studio.evaluate(() => window.studio.sources.all()[0].state === 'live')));
console.log('Page errors:', errors.length ? errors : 'none');
await browser.close();
console.log(`${results.filter(Boolean).length}/${results.length} OBS ingest checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
