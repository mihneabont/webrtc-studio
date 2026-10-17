// The show lives on the Studio Mixer: a second browser that pairs with it opens the same
// sources, scenes and outputs, and the mixer keeps stream keys for outputs.
// Usage: start the mixer (python3 -m studio_mixer --data DIR), python3 -m http.server 8080 &,
//        then MIXER_DATA=DIR node tests/mixer-show.mjs
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(`${process.env.PLAYWRIGHT_DIR || '/opt/node-tools/node_modules'}/`);
const { chromium } = require('playwright');
const MIXER = process.env.MIXER_URL || 'http://127.0.0.1:8788';
const data = process.env.MIXER_DATA || '/tmp/claude-0/mixdata';
const r = []; const check = (n, ok, i = '') => { r.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${i ? `  (${i})` : ''}`); };
const until = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await fn()) return true; } catch { /* retry */ } await new Promise((res) => setTimeout(res, 250)); } return false; };

const b = await chromium.launch();
const errs = [];
async function studio() {
  const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto('http://127.0.0.1:8080/index.html');
  await page.waitForTimeout(800);
  return page;
}
async function pair(page) {
  const code = JSON.parse(readFileSync(`${data}/mixer.json`, 'utf8')).pair_code;
  await page.evaluate(({ url, code }) => window.studio.mixer.pairWithCode(url, code), { url: MIXER, code }).catch(() => {});
}
const active = (page) => until(() => page.evaluate(() => window.studio?.mixer?.active), 20000);

// ---- browser A builds a show
const a = await studio();
await pair(a);
check('Browser A connects to the mixer', await active(a));
const ids = await a.evaluate(() => {
  const st = window.studio;
  const s = st.sources.add({ name: 'Stage cam', kind: 'srt' });
  const o = st.outputs.add({ kind: 'rtmp', url: 'rtmp://127.0.0.1:1935/live' });
  o.token = 'secret-key-123';
  st.store.save();
  return { sid: s.id, oid: o.id, mix: s.cfg.mixToken };
});
check('Browser A saves its show on the mixer', await until(() => a.evaluate(() => !!window.studio.mixer.cfg.showRev)));
const saved = () => JSON.parse(readFileSync(`${data}/mixer.json`, 'utf8')).show;
check('The show on the mixer has the source and the output', await until(() => saved()?.data?.sources?.some((s) => s.id === ids.sid) && saved()?.data?.outputs?.some((o) => o.id === ids.oid)));
const show = saved();
check('The show on the mixer holds no stream key', !JSON.stringify(show).includes('secret-key-123'));
check('The mixer keeps the stream key for its output', await until(async () => JSON.parse(readFileSync(`${data}/mixer.json`, 'utf8')).output_keys?.[ids.oid] === 'secret-key-123'));

// ---- browser B, fresh, pairs and gets the same show
const bp = await studio();
await pair(bp);
await bp.waitForLoadState('load');
check('Browser B connects after taking the show', await active(bp));
const got = await bp.evaluate((ids) => {
  const st = window.studio;
  const s = st.sources.get(ids.sid);
  return { name: s?.cfg.name, mix: s?.cfg.mixToken, out: !!st.outputs.get(ids.oid) };
}, ids);
check('Browser B has the same source, with the same sender key', got.name === 'Stage cam' && got.mix === ids.mix, JSON.stringify(got));
check('Browser B has the same output', got.out);
await bp.evaluate(() => window.studio.ui.showTab('outputs'));
check('Browser B shows the key as saved on the mixer', await until(async () => (await bp.locator('input[placeholder="Saved on the mixer"]').count()) > 0));

// ---- an edit in B reaches A
await bp.evaluate((id) => { window.studio.store.ws.sources.find((s) => s.id === id).name = 'Main cam'; window.studio.store.save(); }, ids.sid);
check('Browser A is told the show changed elsewhere', await until(async () => /changed in another browser/.test(await a.locator('#alerts').innerText())));
await a.reload();
check('After a reload, browser A has the edit', await until(() => a.evaluate((id) => window.studio.sources.get(id)?.cfg.name === 'Main cam', ids.sid), 20000));

check('No page errors', errs.length === 0, errs.join(' | '));
await b.close();
console.log(`${r.filter(Boolean).length}/${r.length} passed`);
process.exit(r.every(Boolean) ? 0 : 1);
