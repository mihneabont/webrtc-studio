// Mixer mode: the studio page paired with a running Studio Mixer (mixer/).
// Pairs with the code, checks that switching, graphics, sources and outputs go
// through the mixer, and that the monitors show its multiview.
// Usage: start the mixer (python3 -m studio_mixer --data DIR), python3 -m http.server 8080 &,
//        then MIXER_DATA=DIR node tests/mixer-mode.mjs
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
const require = createRequire(`${process.env.PLAYWRIGHT_DIR || '/opt/node-tools/node_modules'}/`);
const { chromium } = require('playwright');
const MIXER = process.env.MIXER_URL || 'http://127.0.0.1:8788';
const data = process.env.MIXER_DATA || '/tmp/claude-0/mixdata';
const r = []; const check = (n, ok, i = '') => { r.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${i ? `  (${i})` : ''}`); };
const until = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await fn()) return true; } catch { /* retry */ } await new Promise((res) => setTimeout(res, 250)); } return false; };
const status = async () => (await fetch(`${MIXER}/api/status`, { headers: { Authorization: `Bearer ${token}` } })).json();
let token = '';

const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await b.newPage({ viewport: { width: 1600, height: 1000 } });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
page.on('dialog', (d) => d.accept());
await page.goto('http://127.0.0.1:8080/index.html');
await page.evaluate(() => localStorage.clear());
await page.reload(); await page.waitForTimeout(1000);
// Lighter programme: this container has no GPU and few cores.
await page.evaluate(() => { const f = window.studio.store.ws.settings.format; Object.assign(f, { width: 1280, height: 720, fps: 25 }); window.studio.store.saveNow(); });
// The mixer's preview video is H.264. Playwright's Chromium has no H.264 decoder (Chrome and Edge do),
// so the monitor checks only run where the browser can decode it.
const h264 = await page.evaluate(() => (RTCRtpReceiver.getCapabilities('video')?.codecs || []).some((c) => /h264/i.test(c.mimeType)));
const skip = (n) => { console.log(`SKIP  ${n}  (this browser has no H.264 decoder)`); };
const view = (n, fn, ms) => (h264 ? until(fn, ms).then((ok) => check(n, ok)) : skip(n));

// ---- pairing
await page.evaluate(() => window.studio.ui.showTab('settings', 'mixer'));
const panel = page.locator('[data-section="mixer"]');
check('Settings has a Studio Mixer panel, not connected', /Studio Mixer: Not connected/.test(await panel.innerText()));
const code = JSON.parse(readFileSync(`${data}/mixer.json`, 'utf8')).pair_code;
await panel.locator('input').first().fill(MIXER);
await panel.locator('input[inputmode="numeric"]').fill(code);
await panel.locator('button', { hasText: 'Pair' }).click();
check('Pairing with the code connects', await until(async () => /Studio Mixer: Connected/.test(await panel.innerText())), (await panel.innerText()).slice(0, 160));
token = await page.evaluate(() => window.studio.mixer.cfg.token);
check('Top bar shows the mixer and its encoder', await until(async () => /Mixer/.test(await page.locator('#topStatus').innerText()) && /x264enc|enc/.test(await page.locator('#topStatus').innerText())));

// ---- an SRT source on the mixer, fed by ffmpeg
await page.evaluate(() => window.studio.ui.showTab('sources'));
const kinds = await page.locator('#side select').first().locator('option').allInnerTexts();
check('Source kinds include RTMP in mixer mode', kinds.includes('RTMP') && kinds.includes('SRT'), kinds.join(', '));
const srcId = await page.evaluate(() => window.studio.sources.add({ name: 'Cam SRT', kind: 'srt' }).id);
const card = page.locator(`.card[data-id="${srcId}"]`);
await until(async () => /srt:\/\//.test(await card.innerText()));
const srtUrl = (await card.locator('input').evaluateAll((els) => els.map((e) => e.value))).find((v) => v.startsWith('srt://'));
check('SRT card shows the mixer address with the key', /^srt:\/\/[\d.]+:8793\?streamid=publish:in\/\w+:src:\w+$/.test(srtUrl || ''), srtUrl);
await page.waitForTimeout(800); // workspace sync
const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '25', '-c:a', 'aac', '-f', 'mpegts', srtUrl.replace('127.0.0.1', '127.0.0.1')], { stdio: 'ignore' });
check('SRT source goes live on the card', await until(async () => (await page.evaluate((id) => window.studio.sources.get(id).state, srcId)) === 'live', 20000));

// ---- monitors from the multiview
const lit = (sel) => page.evaluate((s) => {
  const c = s.startsWith('#') ? document.querySelector(s) : document.querySelector(s);
  if (!c) return -1;
  const t = document.createElement('canvas'); t.width = 64; t.height = 36;
  const x = t.getContext('2d'); x.drawImage(c, 0, 0, 64, 36);
  const d = x.getImageData(0, 0, 64, 36).data; let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 60) n++;
  return n;
}, sel);
await view('Multiview stream reaches the page', () => page.evaluate(() => (window.studio.mixer.mv?.video?.videoWidth || 0) > 0), 20000);
await view('Source tile draws the mixer feed', async () => (await lit(`.tile canvas.mv-feed:not([hidden])`)) > 200, 15000);

// ---- switching goes through the mixer
await page.evaluate((id) => window.studio.switcher.setPreview({ kind: 'source', id }), srcId);
check('Preview on the page reaches the mixer', await until(async () => (await status()).preview === `src:${srcId}`));
await view('Preview monitor shows the source', async () => (await lit('.pvw-canvas')) > 200);
await page.keyboard.press('Space');
check('Cut takes it to Programme on the mixer', await until(async () => (await status()).programme === `src:${srcId}`));
await view('Programme monitor shows it', async () => (await lit('.pgm-canvas')) > 200);
check('Page tally follows the mixer', await until(() => page.evaluate((id) => window.studio.switcher.pgmSources().has(id), srcId)));

// ---- a key drawn by the page
const ovId = await page.evaluate(() => {
  const st = window.studio;
  const ov = { id: 'lt1', type: 'lowerthird', name: 'LT', title: 'Mixer Test', subtitle: 'Graphics from the page', x: 0.06, y: 0.76, w: 0.46, color: '#0f172a', accent: '#e11d48', textColor: '#ffffff', opacity: 1 };
  st.store.ws.overlays.push(ov); st.store.save();
  return ov.id;
});
await page.waitForTimeout(1200);
await page.evaluate((id) => window.studio.switcher.setKey(id, true, 300), ovId);
check('Key on reaches the mixer', await until(async () => (await status()).keys?.[ovId] === true), JSON.stringify((await status()).keys));
check('Page shows the key as on', await until(() => page.evaluate((id) => window.studio.switcher.keyOn(id), ovId)));

// ---- a page source forwarded to the mixer over WHIP
const fwdId = await page.evaluate(() => {
  const st = window.studio;
  const s = st.sources.add({ name: 'Page cam', kind: 'peer' });
  const c = document.createElement('canvas'); c.width = 640; c.height = 360;
  const x = c.getContext('2d'); let f = 0;
  setInterval(() => { x.fillStyle = `hsl(${(f++ * 5) % 360} 80% 50%)`; x.fillRect(0, 0, 640, 360); }, 40);
  s.stream = c.captureStream(25); s.hasVideo = true;
  st.sources._set(s, 'live', 'test');
  st.sources.emit('media', s);
  return s.id;
});
check('A page source is forwarded to the mixer (WHIP)', await until(async () => (await status()).sources?.[fwdId]?.state === 'connected', 25000),
  JSON.stringify((await status()).sources?.[fwdId] || {}));

// ---- an RTMP output from the mixer, looped back into an RTMP source
const rtmpSrc = await page.evaluate(() => window.studio.sources.add({ name: 'Loop RTMP', kind: 'rtmp' }).id);
const rcard = page.locator(`.card[data-id="${rtmpSrc}"]`);
await until(async () => /rtmp:\/\//.test(await rcard.innerText()));
const vals = await rcard.locator('input').evaluateAll((els) => els.map((e) => e.value));
const server = vals.find((v) => v.startsWith('rtmp://')), key = vals.find((v) => v.startsWith(`${rtmpSrc}?`));
check('RTMP card shows server and stream key', !!server && !!key, `${server} ${key}`);
const outId = await page.evaluate(({ server, key }) => {
  const o = window.studio.outputs.add({ kind: 'rtmp', url: server });
  o.token = key;
  return o.id;
}, { server, key });
await page.waitForTimeout(800);
await page.evaluate((id) => window.studio.outputs.start(id), outId);
check('RTMP output goes live from the mixer', await until(async () => (await page.evaluate((id) => window.studio.outputs.get(id).state, outId)) === 'live', 25000),
  await page.evaluate((id) => window.studio.outputs.get(id).detail, outId));
check('The looped-back RTMP source goes live', await until(async () => (await page.evaluate((id) => window.studio.sources.get(id).state, rtmpSrc)) === 'live', 25000));
await page.evaluate((id) => window.studio.outputs.stop(id), outId);
check('Stopping the output stops it on the mixer', await until(async () => (await status()).outputs?.[outId]?.state === 'idle'));

await page.screenshot({ path: process.env.SHOT || '/tmp/claude-0/mixer-mode.png' });

// ---- pausing returns to browser mode
await page.evaluate(() => window.studio.mixer.pause());
check('Pausing the mixer brings back browser rendering', await until(() => page.evaluate(() => !window.studio.compositor.paused && !window.studio.switcher.remote)));

ff.kill();
check('No page errors', errs.length === 0, errs.join(' | '));
await b.close();
console.log(`${r.filter(Boolean).length}/${r.length} passed`);
process.exit(r.every(Boolean) ? 0 : 1);
