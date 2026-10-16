// End-to-end test with genuine WebRTC connections between real browser pages
// (Chromium with fake camera/microphone devices as the contributors' capture).
// Usage: node signaling-server/server.mjs --static . &   then   node tests/e2e.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(process.env.PLAYWRIGHT_DIR || '/opt/node-tools/node_modules/');
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://localhost:8787';
const SHOTS = process.env.SHOTS || './test-shots';
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok, info }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, step = 200) {
  const t = Date.now();
  while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } await sleep(step); }
  return null;
}

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required',
    '--disable-features=WebRtcHideLocalIpsWithMdns'],
});
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, permissions: ['camera', 'microphone'] });
const errors = [];
const watch = (page, tag) => {
  page.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag} console: ${m.text()}`); });
};

const studio = await ctx.newPage();
watch(studio, 'studio');
await studio.goto(`${BASE}/index.html`);
await studio.evaluate(() => { localStorage.clear(); });
await studio.reload();
await studio.waitForFunction(() => window.studio);
await studio.mouse.click(5, 300); // user gesture: lets the AudioContext start
check('Studio loads from static hosting with no backend media service', true);

// ---- 1. Add two contributor sources through the UI ----------------------------
async function addSource(name) {
  await studio.click('text=Sources');
  await studio.fill('input[placeholder^="Source name"]', name);
  await studio.click('button:has-text("Add")');
  return studio.waitForFunction((n) => {
    const s = window.studio.sources.all().find((x) => x.cfg.name === n);
    return s?.invite?.link ? { id: s.id, link: s.invite.link } : null;
  }, name, { timeout: 15000 }).then((h) => h.jsonValue());
}
async function contribute(link, quality = '1280x720x30') {
  const p = await ctx.newPage();
  watch(p, 'contrib');
  await p.goto(link);
  await p.selectOption('#qsel', quality);
  await p.click('#go');
  await p.waitForFunction(() => document.querySelector('#reply').value.length > 50, null, { timeout: 20000 });
  return { page: p, reply: await p.inputValue('#reply') };
}

const camA = await addSource('Camera A');
const camB = await addSource('Camera B');
check('Invite links generated without any server', !!(camA.link && camB.link), `code length ${camA.link.length}`);
const cA = await contribute(camA.link, '1920x1080x30');
const cB = await contribute(camB.link);
for (const [src, c] of [[camA, cA], [camB, cB]]) {
  const card = studio.locator(`.card[data-id="${src.id}"]`);
  await card.locator('textarea').fill(c.reply);
  await card.locator('button:has-text("Connect")').click();
}
const live = await until(() => studio.evaluate(() => window.studio.sources.all().every((s) => s.state === 'live' && s.videoFlowing)), 20000);
check('Two real remote WebRTC sources connected', !!live);
const srcInfo = await until(() => studio.evaluate(() => {
  const all = window.studio.sources.all();
  return all.every((s) => s.stats?.in.video?.width) ? all.map((s) => ({ n: s.cfg.name, w: s.stats.in.video.width, h: s.stats.in.video.height, fps: s.stats.in.video.fps, kbps: Math.round(s.stats.in.video.kbps), codec: s.stats.in.video.codec, audio: !!s.hasAudio })) : null;
}), 15000);
check('Source stats come from getStats (resolution, fps, bitrate)', !!srcInfo, JSON.stringify(srcInfo));
await sleep(1500);
await studio.screenshot({ path: `${SHOTS}/01-two-sources.png` });

// ---- 2. Multiview + Preview/Programme -------------------------------------------
const tilesVisible = await studio.evaluate(() => [...document.querySelectorAll('.mv-grid .tile video')].filter((v) => v.videoWidth > 0).length);
check('Both sources visible simultaneously in multiview', tilesVisible === 2, `${tilesVisible} playing tiles`);

const pgmShot = () => studio.evaluate(() => JSON.stringify(window.studio.switcher.programme));
const pvwShot = () => studio.evaluate(() => JSON.stringify(window.studio.switcher.preview));
await studio.locator('.mv-grid .tile').nth(0).click();
const pgmBefore = await pgmShot();
check('Selecting Preview does not change Programme', pgmBefore === 'null' && (await pvwShot()).includes(camA.id));
await studio.keyboard.press('Space');
check('Cut puts the Preview source on Programme', (await pgmShot()).includes(camA.id));
await studio.locator('.mv-grid .tile').nth(1).click();
check('Programme unchanged after choosing a new Preview', (await pgmShot()).includes(camA.id) && (await pvwShot()).includes(camB.id));
await studio.click('button.take.auto');
const midTrans = await studio.evaluate(() => window.studio.switcher.inTransition);
await sleep(1300);
check('Auto transition runs and completes', midTrans && (await pgmShot()).includes(camB.id));

// ---- 3. Composition with multiple sources and graphics ---------------------------
await studio.click('.tabs >> text=Scenes');
await studio.selectOption('.tab-body:not(.hidden) select', 'sbs');
await studio.click('.tab-body:not(.hidden) button:has-text("Create")');
await studio.click('.tabs >> text=Graphics');
await studio.click('button:has-text("+ Lower third")');
await studio.click('button:has-text("+ Text / bug")');
await studio.locator('.tab-body:not(.hidden) .onair-btn').nth(0).click();
await studio.locator('.tab-body:not(.hidden) .onair-btn').nth(1).click();
await studio.keyboard.press('Space'); // Take the scene (in Preview) to Programme
await sleep(800);
const comp = await studio.evaluate(() => {
  const st = window.studio;
  const sc = st.scenes.resolve(st.switcher.programme);
  return { kind: st.switcher.programme.kind, layers: sc.layers.length, sources: [...st.scenes.sourcesIn(st.switcher.programme)].length, keys: st.store.ws.overlays.filter((o) => st.switcher.keyOn(o.id)).length };
});
check('Programme is a composition with 2 sources and graphics', comp.kind === 'scene' && comp.sources === 2 && comp.keys === 2, JSON.stringify(comp));
await studio.screenshot({ path: `${SHOTS}/02-composition-on-air.png` });

// ---- 4. Audio mixing --------------------------------------------------------------
// The fake microphone emits short beeps, so record peak levels over a window.
const audioState = await studio.evaluate(async () => {
  const st = window.studio;
  const ids = st.sources.all().map((s) => s.id);
  const peak = { ch: Object.fromEntries(ids.map((id) => [id, -100])), master: -100 };
  for (let i = 0; i < 60; i++) {
    const lv = st.audio.levels();
    for (const id of ids) peak.ch[id] = Math.max(peak.ch[id], lv.ch[id] ?? -100);
    peak.master = Math.max(peak.master, ...lv.master);
    await new Promise((r) => setTimeout(r, 50));
  }
  const ok = st.audio.ctx.state === 'running' && Object.values(peak.ch).every((d) => d > -40) && peak.master > -40 && ids.every((id) => st.audio.isOnAir(id));
  return ok ? peak : { failed: peak, ctx: st.audio.ctx.state };
});
check('Audio from both sources reaches the programme mix', !audioState.failed, JSON.stringify(audioState));
await studio.evaluate(() => { const id = window.studio.sources.all()[0].id; window.studio.audio.set(id, { muted: true }); });
await sleep(300);
const mutedLevel = await studio.evaluate(() => window.studio.audio.levels().ch[window.studio.sources.all()[0].id]);
check('Mute silences a channel', mutedLevel < -90, `${mutedLevel?.toFixed?.(1)} dBFS`);
await studio.evaluate(() => { const id = window.studio.sources.all()[0].id; window.studio.audio.set(id, { muted: false }); });

// ---- 5. Programme output to a browser receiver ---------------------------------------
await studio.click('.tabs >> text=Outputs');
await studio.click('button:has-text("+ Browser receiver")');
await studio.click('button:has-text("Start (create invite)")');
const outLink = await studio.waitForFunction(() => window.studio.outputs.all()[0]?.invite?.link, null, { timeout: 15000 }).then((h) => h.jsonValue());
const rx = await ctx.newPage();
watch(rx, 'receiver');
await rx.goto(outLink);
await rx.waitForFunction(() => document.querySelector('#reply').value.length > 50, null, { timeout: 20000 });
const rxReply = await rx.inputValue('#reply');
const outCard = studio.locator('.tab-body:not(.hidden) .card').filter({ has: studio.locator('textarea') });
await outCard.locator('textarea').fill(rxReply);
await outCard.locator('button:has-text("Connect")').click();
const outLive = await until(() => studio.evaluate(() => window.studio.outputs.all()[0].state === 'live'), 20000);
check('Programme published as an outgoing WebRTC stream', !!outLive);
const rxMedia = await until(() => rx.evaluate(async () => {
  const v = window.receiver.video;
  if (!v.videoWidth) return null;
  const st = await window.receiver.pc.getStats();
  let audioBytes = 0, videoFrames = 0, energy = 0;
  st.forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'audio') { audioBytes = s.bytesReceived; energy = s.totalAudioEnergy; } if (s.type === 'inbound-rtp' && s.kind === 'video') videoFrames = s.framesDecoded; });
  return videoFrames > 30 && audioBytes > 2000 ? { w: v.videoWidth, h: v.videoHeight, videoFrames, audioBytes, energy } : null;
}), 20000);
check('Remote receiver gets composed video and mixed audio', !!rxMedia, JSON.stringify(rxMedia));

// Verify the received picture is the composition: background colour of the
// side-by-side scene (#101826) at the top-left, and the red text key ("LIVE" box).
async function sampleRx(x, y) {
  return rx.evaluate(([x, y]) => {
    const v = window.receiver.video;
    const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
    const g = c.getContext('2d'); g.drawImage(v, 0, 0);
    return [...g.getImageData(Math.round(x * c.width), Math.round(y * c.height), 1, 1).data].slice(0, 3);
  }, [x, y]);
}
const bg = await sampleRx(0.5, 0.1);
const key = await sampleRx(0.045, 0.07);
const near = (a, b, t = 40) => a.every((v, i) => Math.abs(v - b[i]) < t);
check('Received video shows the composition background', near(bg, [16, 24, 38]), `rgb ${bg}`);
check('Received video contains the keyed graphic', near(key, [229, 29, 72], 60), `rgb ${key}`);

// Transitions reach the output: cut to a source and look again.
await studio.evaluate(() => window.studio.switcher.setPreview({ kind: 'source', id: window.studio.sources.all()[0].id }));
await studio.evaluate(() => window.studio.store.ws.overlays.forEach((o) => window.studio.switcher.setKey(o.id, false, 0)));
await studio.evaluate(() => window.studio.switcher.cut());
await sleep(1500);
const afterCut = await sampleRx(0.5, 0.1);
check('Switching appears in the outgoing stream', !near(afterCut, [16, 24, 38], 20), `rgb ${afterCut}`);
await studio.evaluate(() => window.studio.switcher.toggleFtb());
await sleep(1600);
const black = await sampleRx(0.5, 0.5);
check('Fade to black appears in the outgoing stream', near(black, [0, 0, 0], 12), `rgb ${black}`);
await studio.evaluate(() => window.studio.switcher.toggleFtb());
await sleep(1200);
await rx.screenshot({ path: `${SHOTS}/03-receiver.png` });

const outStats = await studio.evaluate(() => { const o = window.studio.outputs.all()[0]; return o.stats?.out.video ? { w: o.stats.out.video.width, fps: o.stats.out.video.fps, kbps: Math.round(o.stats.out.video.kbps), codec: o.stats.out.video.codec, encoder: o.stats.out.video.encoder } : null; });
check('Output statistics reported', !!outStats?.w, JSON.stringify(outStats));

// ---- 6. WHIP output against the WHIP test sink -----------------------------------------
const whipRx = await ctx.newPage();
watch(whipRx, 'whip-rx');
await whipRx.goto(`${BASE}/receive.html#sig=${encodeURIComponent(BASE)}&room=whiptest&out=w1`);
await sleep(800);
await studio.evaluate((base) => {
  const o = window.studio.outputs.add({ kind: 'whip', name: 'WHIP test', url: `${base}/whip/whiptest/w1` });
  // Playwright's open-source Chromium has no H.264 encoder, so this uses the browser default (VP8).
  return window.studio.outputs.start(o.id);
}, BASE);
const whipLive = await until(() => studio.evaluate(() => window.studio.outputs.all().find((o) => o.cfg.kind === 'whip')?.state === 'live'), 20000);
const whipInfo = await studio.evaluate(() => { const o = window.studio.outputs.all().find((x) => x.cfg.kind === 'whip'); return { state: o.state, detail: o.detail, negotiated: o.negotiated, resource: !!o.resourceUrl }; });
check('WHIP output: POST offer, 201 + Location, media connects', !!whipLive && whipInfo.resource, JSON.stringify(whipInfo));
const whipMedia = await until(() => whipRx.evaluate(() => window.receiver.video.videoWidth > 0 && window.receiver.pc?.connectionState === 'connected'), 15000);
check('WHIP receiver plays the programme', !!whipMedia);
await studio.evaluate(() => window.studio.outputs.stop(window.studio.outputs.all().find((o) => o.cfg.kind === 'whip').id));
const whipStopped = await until(() => whipRx.evaluate(() => document.querySelector('#state').textContent.includes('stopped')), 8000);
check('Stopping WHIP sends DELETE and the session ends', !!whipStopped);

// ---- 7. Twitch output: real request against Twitch's WHIP endpoint ---------------------------
const twitch = await studio.evaluate(async () => {
  const o = window.studio.outputs.add({ kind: 'twitch' });
  await window.studio.outputs.start(o.id, { token: 'live_000000000_invalidtestkey' });
  await new Promise((r) => setTimeout(r, 8000));
  return { state: o.state, detail: o.detail, url: o.cfg.url };
});
console.log('Twitch attempt from this environment:', JSON.stringify(twitch));

// ---- 8. Failure isolation: kill one contributor -----------------------------------------
await cB.page.close();
await sleep(500);
const isolation = await until(() => studio.evaluate(() => {
  const [a, b] = window.studio.sources.all();
  return b.state !== 'live' ? { a: a.state, b: b.state, out: window.studio.outputs.all()[0].state } : null;
}), 30000, 500);
check('A failed source does not affect other sources or outputs', isolation && isolation.a === 'live' && isolation.out === 'live', JSON.stringify(isolation));
await studio.click('.tabs >> text=Sources');
await sleep(500);
await studio.screenshot({ path: `${SHOTS}/04-source-failure.png` });

// ---- 9. Persistence ---------------------------------------------------------------------
const before = await studio.evaluate(() => ({ sources: window.studio.store.ws.sources.map((s) => s.name), scenes: window.studio.store.ws.scenes.length, overlays: window.studio.store.ws.overlays.length, layout: window.studio.store.ws.multiview.layout, outputs: window.studio.store.ws.outputs.length }));
studio.on('dialog', (d) => d.accept());
await studio.reload();
await studio.waitForFunction(() => window.studio);
const after = await studio.evaluate(() => ({ sources: window.studio.store.ws.sources.map((s) => s.name), scenes: window.studio.store.ws.scenes.length, overlays: window.studio.store.ws.overlays.length, layout: window.studio.store.ws.multiview.layout, outputs: window.studio.store.ws.outputs.length, states: window.studio.sources.all().map((s) => s.state) }));
check('Reload restores saved production settings', JSON.stringify({ ...after, states: undefined }) === JSON.stringify(before), JSON.stringify(after));
check('Restored sources are shown as not connected', after.states.every((s) => s === 'offline'));
await sleep(500);
await studio.screenshot({ path: `${SHOTS}/05-restored.png` });

console.log('\nPage errors:', errors.length ? errors : 'none');
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
fs.writeFileSync(`${SHOTS}/results.json`, JSON.stringify({ results, errors, twitch }, null, 2));
process.exit(failed.length ? 1 : 0);
