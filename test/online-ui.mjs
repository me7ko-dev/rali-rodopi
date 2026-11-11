// The browser game against the online server, with a robot player on the other side:
//   API=http://localhost:8798 node test/online-ui.mjs           (local wrangler dev, local files)
//   SITE=https://... API=https://... node test/online-ui.mjs     (live)
// The browser registers through the menu, makes a room with a code, the robot joins with the code, the race runs,
// and the browser must show the other car moving, the name tags and the server's results. Test profiles are deleted.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import { serve } from './serve.mjs';
import { call, race } from './botclient.mjs';

const API = process.env.API || 'http://localhost:8798';
const OUT = process.env.SHOTS || 'test/out';
fs.mkdirSync(OUT, { recursive: true });
let site = process.env.SITE, srv = null;
if (!site) ({ srv, url: site } = await serve(0));
const local = /localhost|127\.0\.0\.1/.test(API);
const from = () => local ? '10.9.' + Math.floor(Math.random() * 250) + '.' + Math.floor(Math.random() * 250) : undefined;
let failed = 0;
const ok = (c, what) => { console.log((c ? '  ✓ ' : '  ✗ ') + what); if (!c) failed++; };
const sfx = Math.random().toString(36).slice(2, 6);
const human = { name: 'ТестЧ' + sfx, pass: 'проба123' }, robot = { name: 'ТестР' + sfx, pass: 'проба123' };

const browser = await chromium.launch({ channel: process.env.CHROME_PATH ? undefined : 'chrome', executablePath: process.env.CHROME_PATH || undefined, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));
let botRun = null;
try {
  const apiParam = site.includes('github.io') && !process.env.API ? '' : '&api=' + encodeURIComponent(API);
  await page.goto(site + '?auto' + apiParam, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game?.state === 'menu', null, { timeout: 120000 });
  await page.click('.modes button[data-mode="online"]');
  await page.fill('#onName', human.name); await page.fill('#onPass', human.pass);
  await page.click('#btnReg');
  await page.waitForSelector('#onHome:not([hidden])', { timeout: 20000 });
  ok(true, 'регистрация през менюто: ' + human.name);
  await page.screenshot({ path: OUT + '/online-menu.png' });
  await page.selectOption('#roomLaps', '1');
  await page.click('#btnCreate');
  await page.waitForSelector('#lobby:not([hidden]) #lbCodeVal:not(:empty)', { timeout: 20000 });
  const code = await page.textContent('#lbCodeVal');
  ok(/^[A-Z0-9]{6}$/.test(code), 'стаята има код: ' + code);

  const r = await call(API, '/api/register', { body: robot, from: from() });
  robot.token = r.token;
  botRun = race({ api: API, token: robot.token, car: 'race', query: { code }, log: m => console.log('    [робот] ' + m) });
  await page.waitForFunction(() => document.querySelectorAll('#lbList li').length >= 2, null, { timeout: 20000 });
  ok(true, 'роботът се появи в стаята');
  await page.screenshot({ path: OUT + '/online-lobby.png' });
  await page.click('#lbStart');
  await page.waitForFunction(() => window.__game.state === 'race', null, { timeout: 60000 });
  const a = await page.evaluate(() => window.__game.cars.filter(c => c.remote).map(c => ({ x: c.x, z: c.z, name: c.name })));
  await page.waitForTimeout(5000);
  const b = await page.evaluate(() => window.__game.cars.filter(c => c.remote).map(c => ({ x: c.x, z: c.z, name: c.name })));
  ok(a.length >= 1, 'другите коли са в играта: ' + b.map(x => x.name).join(', '));
  const robotCar = b.find(x => x.name === robot.name), robotCar0 = a.find(x => x.name === robot.name);
  ok(robotCar && Math.hypot(robotCar.x - robotCar0.x, robotCar.z - robotCar0.z) > 5, 'колата на робота се движи на екрана');
  const tags = await page.evaluate(() => [...document.querySelectorAll('#labels .tag')].map(t => t.textContent));
  ok(tags.some(t => t.startsWith(robot.name)), 'името над колата: ' + tags.join(', '));
  await page.screenshot({ path: OUT + '/online-race.png' });
  // the browser drives slowly with software WebGL; the robot finishes and the server ends the race 45 s later
  await page.waitForSelector('#finish:not([hidden])', { timeout: 200000 });
  await page.waitForFunction(() => window.__game.race.results, null, { timeout: 120000 });
  const rows = await page.evaluate(() => window.__game.race.results.rows);
  ok(rows.some(x => x.name === robot.name && x.valid && x.time > 0), 'класирането от сървъра е на екрана (роботът завърши)');
  ok(rows.some(x => x.name === human.name), 'и браузърът е в класирането');
  await page.screenshot({ path: OUT + '/online-finish.png' });
  ok(errors.length === 0, 'без грешки в конзолата' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
} catch (e) {
  failed++; console.log('  ✗ грешка:', e.message);
  await page.screenshot({ path: OUT + '/online-error.png' }).catch(() => {});
} finally {
  const token = await page.evaluate(() => localStorage.getItem('rali:token')).catch(() => null);
  if (token) { const r = await call(API, '/api/delete', { body: { pass: human.pass }, token }); ok(r.status === 200, 'изтрит ' + human.name); }
  if (botRun) await Promise.race([botRun, new Promise(r => setTimeout(r, 5000))]);
  if (robot.token) { const r = await call(API, '/api/delete', { body: { pass: robot.pass }, token: robot.token }); ok(r.status === 200, 'изтрит ' + robot.name); }
  await browser.close();
  if (srv) srv.close();
  console.log(failed ? `\n${failed} проблема` : '\nВсичко е наред');
  process.exit(failed ? 1 : 0);
}
