// Full check of the online server with two robot players:
//   node test/online.mjs                 -> local wrangler dev (http://localhost:8798)
//   node test/online.mjs https://...     -> the real server
// Registers two test profiles, races them together in a quick race, checks the leaderboards, has one of them
// cheat in a room with a code (the result must be rejected), and deletes both test profiles at the end.
import { call, race } from './botclient.mjs';

const API = process.argv[2] || process.env.API || 'http://localhost:8798';
const local = /localhost|127\.0\.0\.1/.test(API);
const ip = () => local ? '10.' + [0, 0, 0].map(() => Math.floor(Math.random() * 250)).join('.') : undefined;
let ok = 0, bad = 0;
const check = (cond, what) => { if (cond) { ok++; console.log('  ✓', what); } else { bad++; console.log('  ✗', what); } };
const sfx = Math.random().toString(36).slice(2, 7);
const A = { name: 'ТестА' + sfx, pass: 'проба123' }, B = { name: 'ТестБ' + sfx, pass: 'проба456' };
const t0 = Date.now();
const log = who => msg => console.log(`    [${who}] ${msg}`);

console.log('Сървър:', API);
try {
  let r = await call(API, '/api/ping', { method: 'GET' });
  check(r.status === 200 && r.ok, `сървърът отговаря (${r.tracks} писти)`);

  console.log('Профили');
  const fromA = ip();
  r = await call(API, '/api/register', { body: A, from: fromA });
  check(r.status === 200 && /^[0-9a-f]{64}$/.test(r.token), 'регистрация на ' + A.name);
  A.token = r.token; A.id = r.me?.id;
  r = await call(API, '/api/register', { body: { name: A.name.toUpperCase(), pass: 'друга123' }, from: fromA });
  check(r.status === 409, 'същото име с главни букви е заето');
  r = await call(API, '/api/register', { body: { name: 'fuck' + sfx, pass: 'проба123' }, from: ip() });
  check(r.status === 400, 'грубо име (EN) се отказва');
  r = await call(API, '/api/register', { body: { name: 'Курва' + sfx, pass: 'проба123' }, from: ip() });
  check(r.status === 400, 'грубо име (БГ) се отказва');
  r = await call(API, '/api/register', { body: { name: 'аб', pass: 'проба123' }, from: ip() });
  check(r.status === 400, 'твърде кратко име');
  r = await call(API, '/api/register', { body: { name: 'Абвгдежзийклмнопр', pass: 'проба123' }, from: ip() });
  check(r.status === 400, 'над 16 знака не става');
  r = await call(API, '/api/register', { body: B, from: ip() });
  check(r.status === 200, 'регистрация на ' + B.name);
  B.token = r.token; B.id = r.me?.id;
  r = await call(API, '/api/login', { body: { name: A.name.toLowerCase(), pass: 'грешна1' } });
  check(r.status === 401, 'грешна парола');
  r = await call(API, '/api/login', { body: { name: ' ' + A.name.toLowerCase() + ' ', pass: A.pass } });
  check(r.status === 200 && r.me.name === A.name, 'вход с малки букви');
  r = await call(API, '/api/me', { method: 'GET', token: 'f'.repeat(64) });
  check(r.status === 401, 'чужд ключ не става');

  console.log('Бързо състезание: двамата в една стая (+ ботове след 15 s)');
  const [ra, rb] = await Promise.all([
    race({ api: API, token: A.token, car: 'race', query: { mode: 'quick' }, log: log('А') }),
    race({ api: API, token: B.token, car: 'hatchback-sports', query: { mode: 'quick' }, log: log('Б') })
  ]);
  check(ra.hello && rb.hello && ra.hello.room === rb.hello.room, 'в една и съща стая: ' + ra.hello?.room);
  check(ra.players?.length >= 6 && ra.players.filter(p => p.bot).length >= 4, `допълнено с ботове (${ra.players?.length} коли)`);
  check(ra.slot !== rb.slot && ra.slot >= 0, 'различни места на старта');
  check(ra.results && rb.results, 'и двамата получиха класирането');
  check(ra.msgs.filter(t => t === 's').length > 100, 'позициите идват постоянно (' + ra.msgs.filter(t => t === 's').length + ')');
  const rowA = ra.results?.rows.find(x => x.id === 'u' + A.id), rowB = ra.results?.rows.find(x => x.id === 'u' + B.id);
  check(rowA?.valid && rowB?.valid, `и двата резултата са приети (${rowA?.why || '-'} / ${rowB?.why || '-'})`);
  check(rowA?.time > 0 && rowB?.time > 0, `завършиха: ${rowA?.time?.toFixed(1)} s и ${rowB?.time?.toFixed(1)} s`);
  check(Math.abs(rowA?.time - ra.finish) < 1.5, `сървърът и колата са съгласни за времето (${rowA?.time?.toFixed(2)} / ${ra.finish?.toFixed(2)})`);
  check(rowA?.points > 0 && rowB?.points > 0, `точки: ${rowA?.points} и ${rowB?.points}`);
  check(ra.saved && rb.saved, 'записано в базата');
  const track = ra.track;

  console.log('Класации');
  r = await call(API, '/api/top?track=' + track, { method: 'GET', token: A.token });
  check(r.top?.some(x => x.name === A.name) && r.top?.some(x => x.name === B.name), `и двамата са в класацията на пистата ${track}`);
  check(r.me?.name === A.name && r.me.ms === Math.round(rowA.best * 1000), 'моят ред е отделно и с вярното време');
  r = await call(API, '/api/week', { method: 'GET', token: B.token });
  check(r.top?.some(x => x.name === A.name && x.points === rowA.points), 'седмичната класация има точките на А');
  check(r.me?.name === B.name && r.me.points === rowB.points, 'моят ред в седмичната класация');
  r = await call(API, '/api/me', { method: 'GET', token: A.token });
  check(r.me?.races === 1 && r.me.points === rowA.points && r.me.garage === rowA.points, 'профилът брои състезанието и точките');

  console.log('Измама: Б кара два пъти по-бързо в стая с код (1 обиколка, друга писта)');
  const other = ['dospat', 'velingrad', 'sarnitsa'].find(t => t !== track);
  r = await call(API, '/api/room', { body: { track: other, laps: 1 }, token: A.token });
  check(r.code && /^[A-Z0-9]{6}$/.test(r.code), 'код на стаята: ' + r.code);
  const code = r.code;
  let started = false;
  const host = race({
    api: API, token: A.token, car: 'sedan-sports', query: { code }, log: log('А'),
    onLobby: (m, ws) => { if (!started && m.players.filter(p => !p.bot).length >= 2 && m.host === 'u' + A.id) { started = true; ws.send(JSON.stringify({ t: 'start' })); } }
  });
  await new Promise(r => setTimeout(r, 1200));
  const cheat = race({ api: API, token: B.token, car: 'race', query: { code: code.toLowerCase() }, cheat: 'speed', log: log('Б-измамник') });
  const [ca, cb] = await Promise.all([host, cheat]);
  check(ca.hello?.room === cb.hello?.room, 'приятелят влезе с кода');
  const cRowB = ca.results?.rows.find(x => x.id === 'u' + B.id), cRowA = ca.results?.rows.find(x => x.id === 'u' + A.id);
  check(cRowB && !cRowB.valid && cRowB.points === 0, `невъзможният резултат е отхвърлен (${cRowB?.why})`);
  check(cRowA?.valid, 'честният в същата стая е приет');
  r = await call(API, '/api/top?track=' + other, { method: 'GET' });
  check(!r.top?.some(x => x.name === B.name), 'измамникът го няма в класацията на пистата');

  console.log('Гараж и защита');
  r = await call(API, '/api/look', { body: { look: { paint: 'chrome', spoiler: 'lip', num: 42 } }, token: A.token });
  check(r.me?.look.paint === 'stock' && r.me.look.num === 42, 'заключена боя не минава (хром иска 450 т.)');
  check(r.me?.look.spoiler === (r.me.garage >= 20 ? 'lip' : 'none'), 'спойлерът — според точките');
  r = await call(API, '/api/solo', { body: { track: 'dospat', place: 1 }, token: B.token });
  check(r.status === 200 && r.got > 0, 'състезание сам дава точки за гаража: ' + r.got);
  r = await call(API, '/api/solo', { body: { track: 'dospat', place: 1 }, token: B.token });
  check(r.status === 429, 'второ веднага — не');
  const bad1 = await new Promise(res => { const ws = new WebSocket(API.replace(/^http/, 'ws') + '/api/play?car=race&mode=quick', ['rali', 'a'.repeat(64)]); ws.onopen = () => { ws.close(); res('open'); }; ws.onerror = () => res('refused'); });
  check(bad1 === 'refused', 'без вход в състезание не се влиза');
} catch (e) {
  bad++; console.log('  ✗ грешка:', e);
} finally {
  console.log('Чистене: трият се само двата тестови профила');
  for (const u of [A, B]) if (u.token) {
    const r = await call(API, '/api/delete', { body: { pass: u.pass }, token: u.token });
    check(r.status === 200, 'изтрит ' + u.name);
  }
  if (A.token) { const r = await call(API, '/api/me', { method: 'GET', token: A.token }); check(r.status === 401, 'тестовият профил вече го няма'); }
  console.log(`\n${ok} ✓, ${bad} ✗ за ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  process.exit(bad ? 1 : 0);
}
