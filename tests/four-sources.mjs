// Load check: four 1080p contributors into one studio, 2x2 scene on air, one receiver.
// Reports render time and decode rates. Numbers depend heavily on the machine.
import { createRequire } from 'node:module';
const require = createRequire(process.env.PLAYWRIGHT_DIR || '/opt/node-tools/node_modules/');
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:8787';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, permissions: ['camera', 'microphone'] });
const studio = await ctx.newPage();
const errors = [];
studio.on('pageerror', (e) => errors.push(e.message));
await studio.goto(`${BASE}/index.html`);
await studio.evaluate(() => localStorage.clear());
await studio.reload();
await studio.waitForFunction(() => window.studio);
for (let i = 0; i < 4; i++) {
  const link = await studio.evaluate(async (i) => { const s = window.studio.sources.add({ name: `Cam ${i + 1}` }); return (await window.studio.sources.createInvite(s.id)).link; }, i);
  const p = await ctx.newPage();
  await p.goto(link);
  await p.selectOption('#qsel', '1920x1080x30');
  await p.fill('#bitrate', '8000');
  await p.click('#go');
  await p.waitForFunction(() => document.querySelector('#reply').value.length > 50, null, { timeout: 20000 });
  const reply = await p.inputValue('#reply');
  await studio.evaluate(async ([i, r]) => window.studio.sources.acceptAnswer(window.studio.sources.all()[i].id, r), [i, reply]);
}
await studio.evaluate(async () => {
  const st = window.studio;
  const { sceneFromTemplate } = await import('./js/scenes.js');
  const sc = st.scenes.add(sceneFromTemplate('quad', st.sources.all().map((s) => s.id)));
  st.switcher.setPreview({ kind: 'scene', id: sc.id }); st.switcher.cut();
});
await sleep(25000);
const drawCost = await studio.evaluate(() => { const v = [...window.studio.compositor.videos.values()][0]; const c = document.createElement('canvas'); c.width = 1920; c.height = 1080; const g = c.getContext('2d'); const t = performance.now(); for (let i = 0; i < 10; i++) g.drawImage(v, 0, 0, 1920, 1080); g.getImageData(0, 0, 1, 1); return ((performance.now() - t) / 10).toFixed(1); });
console.log('ms per full-frame drawImage of one source:', drawCost);
const r = await studio.evaluate(() => {
  const st = window.studio;
  return {
    live: st.sources.all().filter((s) => s.state === 'live').length,
    inputs: st.sources.all().map((s) => `${s.stats?.in.video?.width}x${s.stats?.in.video?.height}@${Math.round(s.stats?.in.video?.fps || 0)}`),
    render: { fps: st.compositor.metrics.fps.toFixed(1), ms: st.compositor.metrics.renderMs.toFixed(1) },
    cores: navigator.hardwareConcurrency,
  };
});
console.log(JSON.stringify(r, null, 1));
await studio.screenshot({ path: `${process.env.SHOTS || '.'}/06-four-sources.png` });
console.log('errors', errors);
await browser.close();
