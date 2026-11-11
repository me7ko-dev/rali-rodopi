// Browser smoke test (Chrome through playwright-core, software WebGL), on a computer and on a phone.
//   node test/smoke.mjs                 -> serves this folder locally
//   SITE=https://... node test/smoke.mjs -> checks the live site
//   SHOTS=docs node test/smoke.mjs       -> where the screenshots go (default test/out)
// Chrome: CHROME_PATH or the usual install; Playwright's own browsers are not needed.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { serve } from './serve.mjs';

const OUT = process.env.SHOTS || 'test/out';
fs.mkdirSync(OUT, { recursive: true });
let site = process.env.SITE, srv = null;
if (!site) ({ srv, url: site } = await serve(0));
const extra = process.env.QUERY || '';

const launch = { channel: process.env.CHROME_PATH ? undefined : 'chrome', executablePath: process.env.CHROME_PATH || undefined, headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] };
const browser = await chromium.launch(launch);

const devices = {
  computer: { viewport: { width: 1280, height: 720 } },
  phone: { viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36' }
};
let failed = 0;
const ok = (cond, what) => { console.log((cond ? '  ✓ ' : '  ✗ ') + what); if (!cond) failed++; };

for (const [name, opts] of Object.entries(devices)) {
  console.log(`\n${name} — ${site}`);
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(site + (site.includes('?') ? '&' : '?') + 'auto' + extra, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game && window.__game.state === 'menu', null, { timeout: 90000 });
  ok(true, 'менюто се показа');
  const scroll = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, w: innerWidth, menu: [...document.querySelectorAll('.menu, .card, .sheet')].filter(e => getComputedStyle(e).display !== 'none' && !e.closest('[hidden]')).map(e => e.scrollWidth - e.clientWidth) }));
  ok(scroll.doc <= scroll.w && scroll.menu.every(d => d <= 1), 'без хоризонтален скрол: ' + JSON.stringify(scroll));
  await page.screenshot({ path: path.join(OUT, `${name}-menu.png`) });
  if (process.env.MENU_ONLY) { await ctx.close(); continue; }
  await page.evaluate(() => window.__game.solo());
  await page.waitForFunction(() => window.__game.state === 'race', null, { timeout: 30000 });
  const t0 = await page.evaluate(() => ({ total: window.__game.player.total, frames: window.__game.frames }));
  await page.waitForTimeout(6000);
  const t1 = await page.evaluate(() => ({ total: window.__game.player.total, frames: window.__game.frames, touch: !document.getElementById('touch').hidden, quality: window.__game.quality }));
  ok(t1.total > t0.total + 2, `колата кара (${t0.total} → ${t1.total})`);
  console.log(`    кадри за 6 s: ${t1.frames - t0.frames} (софтуерен WebGL, истинското е по-бързо), качество: ${t1.quality}`);
  ok(name !== 'phone' || t1.touch, 'бутоните за пръст се виждат на телефона');
  await page.screenshot({ path: path.join(OUT, `${name}-race.png`) });
  ok(errors.length === 0, 'без грешки в конзолата' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  await ctx.close();
}
await browser.close();
if (srv) srv.close();
console.log(failed ? `\n${failed} проблема` : '\nВсичко е наред');
process.exit(failed ? 1 : 0);
