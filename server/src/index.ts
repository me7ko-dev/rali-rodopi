// Рали Родопи — онлайн сървър (Cloudflare Worker + Durable Objects + D1).
// Профили с име и парола, класации, гараж. Състезанията са в rooms.ts (по един Durable Object на състезание):
// там сървърът сам брои обиколките от позициите и отхвърля невъзможните резултати.
// Срещу много профили: лимит по ОТПЕЧАТЪК на адреса (SHA-256 със сол, истинският IP не се пази).
import { TRACKS, CARS } from '../../js/data.js';
import { cleanLook } from '../../js/core/looks.js';
import { pointsFor } from '../../js/core/race.js';
import type { D1, NS, Env } from './types';
export { RaceRoom, Lobby } from './rooms';

type User = { id: number; name: string; points: number; garage: number; races: number; wins: number; look: string; imported: number; seen: number };

const REG_PER_IP_DAY = 3;
const SOLO_PER_DAY = 60;          // състезания сам, които дават точки за гаража
const IMPORT_MAX = 300;           // точки, изкарани преди профила, които може да пренесе

// ---------------------------------------------------------------- помощни
class HttpError extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) { super(message); }
}
const fail = (status: number, msg: string, extra: Record<string, unknown> = {}): never => { throw new HttpError(status, msg, extra); };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS } });
}

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const b64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));
function randomHex(n: number) { const a = new Uint8Array(n); crypto.getRandomValues(a); return hex(a.buffer); }
export async function sha256(s: string) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(s))); }
async function hashPass(pass: string, salt: string) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 100_000 }, key, 256);
  return b64(bits);
}
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
/** Отпечатък на адреса: същият адрес дава същия отпечатък, но от него IP-то не може да се върне. */
async function ipKey(env: Env, req: Request) {
  // X-Forwarded-For се слуша само при локални тестове (DEV_FORWARDED=1); онлайн адресът идва от Cloudflare
  const fwd = env.DEV_FORWARDED === '1' ? req.headers.get('X-Forwarded-For')?.split(',')[0].trim() : '';
  const ip = fwd || req.headers.get('CF-Connecting-IP') || 'local';
  return (await sha256((env.IP_SALT || 'rali-dev-salt') + '|' + ip)).slice(0, 32);
}

// груби думи — не се допускат в имената (сравнява се без интервали и с латиницата като кирилица)
const BAD = ['путк', 'пичк', 'хуй', 'еба', 'ебе', 'шиба', 'курв', 'педал', 'мамка', 'мамицата', 'задник', 'лайн', 'гъз', 'сперм', 'секс', 'порн', 'нацист', 'хитлер', 'циган', 'мангал', 'боклук', 'идиот', 'тъпанар', 'кретен', 'простак',
  'fuck', 'shit', 'bitch', 'cunt', 'dick', 'pussy', 'porn', 'sex', 'nazi', 'hitler', 'nigg', 'whore', 'slut', 'asshole', 'fag', 'retard', 'rape', 'penis', 'vagina', 'cock'];
const LAT2CYR: Record<string, string> = { a: 'а', b: 'б', c: 'ц', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'х', i: 'и', j: 'й', k: 'к', l: 'л', m: 'м', n: 'н', o: 'о', p: 'п', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', x: 'х', y: 'у', z: 'з', '0': 'о', '3': 'з', '4': 'ч', '6': 'б' };
export function isRude(s: string) {
  const low = s.toLowerCase().replace(/[\s._\-]+/g, '');
  const cyr = [...low].map((c) => LAT2CYR[c] ?? c).join('');
  const lat = low.replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/\$/g, 's').replace(/@/g, 'a');
  return BAD.some((w) => low.includes(w) || cyr.includes(w) || lat.includes(w));
}
const nameKey = (raw: unknown) => String(raw ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
function cleanName(raw: unknown) {
  const s = String(raw ?? '').normalize('NFC').trim().replace(/\s+/g, ' ');
  if ([...s].length < 3 || [...s].length > 16) fail(400, 'Името трябва да е от 3 до 16 знака.');
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(s)) fail(400, 'Името може да съдържа само букви, цифри, интервал, точка, тире и долна черта.');
  if (isRude(s)) fail(400, 'Избери по-хубаво име.');
  return s;
}
function cleanPass(raw: unknown) {
  const s = String(raw ?? '');
  if (s.length < 6) fail(400, 'Паролата трябва да е поне 6 знака.');
  if (s.length > 64) fail(400, 'Паролата е твърде дълга.');
  return s;
}

/** Ограничение: най-много n пъти за sec секунди по даден ключ. */
async function limit(env: Env, key: string, n: number, sec: number, msg = 'Твърде много опити. Опитай пак малко по-късно.') {
  const t = Date.now();
  const row = await env.DB.prepare('SELECT n, until FROM limits WHERE key = ?').bind(key).first<{ n: number; until: number }>();
  if (!row || row.until < t) {
    await env.DB.prepare('INSERT OR REPLACE INTO limits (key, n, until) VALUES (?, 1, ?)').bind(key, t + sec * 1000).run();
    return;
  }
  if (row.n >= n) fail(429, msg, { retryIn: row.until - t });
  await env.DB.prepare('UPDATE limits SET n = n + 1 WHERE key = ?').bind(key).run();
}

async function body(req: Request): Promise<Record<string, unknown>> {
  const txt = await req.text();
  if (txt.length > 4096) fail(413, 'Твърде много данни.');
  try { return txt ? JSON.parse(txt) : {}; } catch { return fail(400, 'Грешни данни.'); }
}

/** Понеделник 00:00 българско време (UTC+2; лятото е с час по-рано — няма значение за класацията). */
export function weekStart(t = Date.now()) {
  const local = new Date(t + 2 * 3600_000);
  const day = (local.getUTCDay() + 6) % 7; // 0 = понеделник
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - day) - 2 * 3600_000;
}

const COLS = 'id, name, points, garage, races, wins, look, imported, seen';
async function me(env: Env, u: User) {
  const w = await env.DB.prepare('SELECT COALESCE(SUM(points), 0) AS p FROM results WHERE user = ? AND valid = 1 AND t >= ?').bind(u.id, weekStart()).first<{ p: number }>();
  let look: unknown = null;
  try { look = u.look ? JSON.parse(u.look) : null; } catch { /* стара визия */ }
  return { id: u.id, name: u.name, points: u.points, garage: u.garage, races: u.races, wins: u.wins, week: w?.p ?? 0, look: cleanLook(look, u.garage), imported: !!u.imported };
}

/** Ключът идва като Bearer или (при WebSocket) като втори „протокол“ — там заглавки не може да се слагат. */
export function tokenOf(req: Request) {
  const h = req.headers.get('Authorization') || '';
  const proto = (req.headers.get('Sec-WebSocket-Protocol') || '').split(',').map((x) => x.trim());
  return h.startsWith('Bearer ') ? h.slice(7).trim() : proto[0] === 'rali' ? proto[1] ?? '' : '';
}

async function auth(env: Env, req: Request, optional = false): Promise<User | null> {
  const tok = tokenOf(req);
  if (!/^[0-9a-f]{64}$/.test(tok)) return optional ? null : fail(401, 'Влез отново в профила си.');
  const th = await sha256(tok);
  const u = await env.DB.prepare(`SELECT ${COLS.split(', ').map((c) => 'u.' + c).join(', ')}, s.seen AS sseen FROM sessions s JOIN users u ON u.id = s.user WHERE s.token = ?`)
    .bind(th).first<User & { sseen: number }>();
  if (!u) return optional ? null : fail(401, 'Влез отново в профила си.');
  const t = Date.now();
  if (t - u.sseen > 300_000) {
    await env.DB.batch([
      env.DB.prepare('UPDATE sessions SET seen = ? WHERE token = ?').bind(t, th),
      env.DB.prepare('UPDATE users SET seen = ? WHERE id = ?').bind(t, u.id),
    ]);
  }
  return u;
}
const must = async (env: Env, req: Request) => (await auth(env, req)) as User;

async function newSession(env: Env, user: number) {
  const tok = randomHex(32);
  const t = Date.now();
  await env.DB.prepare('INSERT INTO sessions (token, user, created, seen) VALUES (?, ?, ?, ?)').bind(await sha256(tok), user, t, t).run();
  return tok;
}

const trackById = (id: unknown) => TRACKS.find((t: { id: string }) => t.id === id);

// ---------------------------------------------------------------- маршрути
type Handler = (env: Env, req: Request, url: URL) => Promise<unknown>;
const routes = new Map<string, Handler>();
const route = (method: string, path: string, h: Handler) => routes.set(method + ' ' + path, h);

route('GET', '/api/ping', async () => ({ ok: true, t: Date.now(), tracks: TRACKS.length }));

route('POST', '/api/register', async (env, req) => {
  const b = await body(req);
  const name = cleanName(b.name);
  const pass = cleanPass(b.pass);
  const key = nameKey(name);
  if (await env.DB.prepare('SELECT 1 FROM users WHERE name_key = ?').bind(key).first()) fail(409, 'Това име е заето. Избери друго.');
  const ip = await ipKey(env, req);
  await limit(env, 'reg:' + ip, REG_PER_IP_DAY, 86400, `От тази връзка днес вече са направени ${REG_PER_IP_DAY} профила. Влез в някой от тях или опитай утре.`);
  const salt = randomHex(16);
  const t = Date.now();
  const r = await env.DB.prepare('INSERT INTO users (name, name_key, pass, salt, created, seen, ip) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(name, key, await hashPass(pass, salt), salt, t, t, ip).run();
  const id = r.meta.last_row_id;
  const token = await newSession(env, id);
  return { token, me: await me(env, { id, name, points: 0, garage: 0, races: 0, wins: 0, look: '', imported: 0, seen: t }) };
});

route('POST', '/api/login', async (env, req) => {
  const b = await body(req);
  const key = nameKey(b.name);
  const pass = String(b.pass ?? '');
  if (!key || !pass) fail(400, 'Напиши име и парола.');
  await limit(env, 'login:' + key, 12, 900);
  await limit(env, 'loginip:' + (await ipKey(env, req)), 40, 900);
  const u = await env.DB.prepare(`SELECT ${COLS}, pass, salt FROM users WHERE name_key = ?`).bind(key).first<User & { pass: string; salt: string }>();
  if (!u || !safeEqual(await hashPass(pass, u.salt), u.pass)) fail(401, 'Грешно име или парола.');
  const token = await newSession(env, u!.id);
  return { token, me: await me(env, u!) };
});

route('POST', '/api/logout', async (env, req) => {
  const tok = tokenOf(req);
  if (/^[0-9a-f]{64}$/.test(tok)) await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(await sha256(tok)).run();
  return { ok: true };
});

route('GET', '/api/me', async (env, req) => ({ me: await me(env, await must(env, req)) }));

/** Изтриване на профила (с паролата): профил, сесии, резултати и обиколки. */
route('POST', '/api/delete', async (env, req) => {
  const u = await must(env, req);
  const b = await body(req);
  const row = await env.DB.prepare('SELECT pass, salt FROM users WHERE id = ?').bind(u.id).first<{ pass: string; salt: string }>();
  if (!row || !safeEqual(await hashPass(String(b.pass ?? ''), row.salt), row.pass)) fail(401, 'Грешна парола.');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE user = ?').bind(u.id),
    env.DB.prepare('DELETE FROM results WHERE user = ?').bind(u.id),
    env.DB.prepare('DELETE FROM laps WHERE user = ?').bind(u.id),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(u.id),
  ]);
  return { ok: true };
});

/** Визията в гаража: само отключени неща (сървърът знае точките). */
route('POST', '/api/look', async (env, req) => {
  const u = await must(env, req);
  const b = await body(req);
  const look = cleanLook(b.look, u.garage);
  await env.DB.prepare('UPDATE users SET look = ? WHERE id = ?').bind(JSON.stringify(look), u.id).run();
  return { me: await me(env, { ...u, look: JSON.stringify(look) }) };
});

/** Състезание сам с ботове: точки само за гаража (не за класациите — браузърът може да излъже). */
route('POST', '/api/solo', async (env, req) => {
  const u = await must(env, req);
  const b = await body(req);
  if (!trackById(b.track)) fail(400, 'Няма такава писта.');
  const place = Math.round(Number(b.place));
  if (!(place >= 1 && place <= 6)) fail(400, 'Грешно място.');
  await limit(env, 'solo:' + u.id, 1, 40, 'Твърде бързо. Едно състезание трае поне минута.');
  await limit(env, 'soloday:' + u.id, SOLO_PER_DAY, 86400, 'За днес точките от състезания сам свършиха. Онлайн още се печелят.');
  const pts = Math.ceil(pointsFor(place, true) / 2);
  await env.DB.prepare('UPDATE users SET garage = garage + ? WHERE id = ?').bind(pts, u.id).run();
  return { got: pts, me: await me(env, { ...u, garage: u.garage + pts }) };
});

/** Точките, изкарани в браузъра преди профила (веднъж, до IMPORT_MAX). */
route('POST', '/api/import', async (env, req) => {
  const u = await must(env, req);
  const b = await body(req);
  if (u.imported) return { got: 0, me: await me(env, u) };
  const pts = Math.max(0, Math.min(IMPORT_MAX, Math.round(Number(b.points) || 0)));
  const r = await env.DB.prepare('UPDATE users SET garage = garage + ?, imported = 1 WHERE id = ? AND imported = 0').bind(pts, u.id).run();
  const got = r.meta.changes ? pts : 0;
  return { got, me: await me(env, { ...u, garage: u.garage + got, imported: 1 }) };
});

/** Класация по писта: най-добра обиколка. С ключ — и моят ред. */
route('GET', '/api/top', async (env, req, url) => {
  const track = url.searchParams.get('track');
  if (!trackById(track)) fail(400, 'Няма такава писта.');
  const r = await env.DB.prepare('SELECT u.name, l.best_ms AS ms, l.car FROM laps l JOIN users u ON u.id = l.user WHERE l.track = ? ORDER BY l.best_ms ASC, l.t ASC LIMIT 20')
    .bind(track).all<{ name: string; ms: number; car: string }>();
  const u = await auth(env, req, true);
  let mine = null;
  if (u) {
    const m = await env.DB.prepare('SELECT best_ms AS ms, car FROM laps WHERE user = ? AND track = ?').bind(u.id, track).first<{ ms: number; car: string }>();
    if (m) {
      const k = await env.DB.prepare('SELECT COUNT(*) AS n FROM laps WHERE track = ? AND best_ms < ?').bind(track, m.ms).first<{ n: number }>();
      mine = { rank: (k?.n ?? 0) + 1, name: u.name, ms: m.ms, car: m.car };
    }
  }
  return { track, top: r.results, me: mine };
});

/** Обща класация: точки от онлайн състезания тази седмица. */
route('GET', '/api/week', async (env, req) => {
  const from = weekStart();
  const r = await env.DB.prepare('SELECT u.name, SUM(r.points) AS pts, COUNT(*) AS races FROM results r JOIN users u ON u.id = r.user WHERE r.valid = 1 AND r.t >= ? GROUP BY r.user HAVING pts > 0 ORDER BY pts DESC, MIN(r.t) ASC LIMIT 20')
    .bind(from).all<{ name: string; pts: number; races: number }>();
  const u = await auth(env, req, true);
  let mine = null;
  if (u) {
    const m = await env.DB.prepare('SELECT COALESCE(SUM(points), 0) AS p, COUNT(*) AS n FROM results WHERE user = ? AND valid = 1 AND t >= ?').bind(u.id, from).first<{ p: number; n: number }>();
    if (m && m.p > 0) {
      const k = await env.DB.prepare('SELECT COUNT(*) AS n FROM (SELECT SUM(points) AS p FROM results WHERE valid = 1 AND t >= ? GROUP BY user HAVING p > ?)').bind(from, m.p).first<{ n: number }>();
      mine = { rank: (k?.n ?? 0) + 1, name: u.name, points: m.p, races: m.n };
    }
  }
  return { from, top: r.results.map((x) => ({ name: x.name, points: x.pts, races: x.races })), me: mine };
});

/** Стая с код за приятели: връща 6-знаков код. */
route('POST', '/api/room', async (env, req) => {
  const u = await must(env, req);
  const b = await body(req);
  const track = b.track === 'random' || b.track == null ? 'random' : trackById(b.track)?.id;
  if (!track) fail(400, 'Няма такава писта.');
  const laps = Math.round(Number(b.laps ?? 3));
  if (!(laps >= 1 && laps <= 5)) fail(400, 'Обиколките са от 1 до 5.');
  await limit(env, 'room:' + u.id, 20, 3600, 'Твърде много стаи. Опитай след малко.');
  return (await lobby(env).fetch(`https://lobby/code/new?user=u${u.id}&track=${track}&laps=${laps}`)).json();
});

route('GET', '/api/online', async (env) => (await lobby(env).fetch('https://lobby/count')).json());

const lobby = (env: Env) => env.LOBBY.get(env.LOBBY.idFromName('lobby'));

// ---------------------------------------------------------------- вход
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    try {
      // състезание: WebSocket към стаята, която лобито избере (бързо), по код (приятели) или същата (връщане след прекъсване)
      if (url.pathname === '/api/play') {
        if (req.headers.get('Upgrade') !== 'websocket') fail(426, 'Трябва WebSocket.');
        const u = await must(env, req);
        const car = url.searchParams.get('car') || '';
        if (!CARS.some((c: { id: string; aiOnly?: boolean }) => c.id === car && !c.aiOnly)) fail(400, 'Няма такава кола.');
        let info: { room?: string; error?: string; deadline?: number; track?: string; laps?: number; code?: string; mode?: string };
        const code = (url.searchParams.get('code') || '').toUpperCase();
        const rejoin = url.searchParams.get('rejoin') || '';
        if (rejoin) {
          if (!/^[a-z0-9-]{4,40}$/.test(rejoin)) fail(400, 'Грешна стая.');
          info = { room: rejoin, mode: 'rejoin' };
        } else if (code) {
          info = await (await lobby(env).fetch(`https://lobby/code/get?code=${encodeURIComponent(code)}`)).json();
          if (!info.room) fail(404, info.error || 'Няма стая с този код.');
        } else {
          info = await (await lobby(env).fetch(`https://lobby/quick?user=u${u.id}`)).json();
        }
        let look: unknown = null;
        try { look = u.look ? JSON.parse(u.look) : null; } catch { /* */ }
        const q = new URLSearchParams({ room: info.room!, mode: info.mode || '', track: info.track || '', laps: String(info.laps || ''), deadline: String(info.deadline || ''), code: info.code || '', host: (info as { host?: string }).host || '' });
        const stub = env.ROOMS.get(env.ROOMS.idFromName(info.room!));
        const h = new Headers(req.headers);
        h.set('X-User-Id', 'u' + u.id); h.set('X-User-Name', encodeURIComponent(u.name)); h.set('X-Car', car);
        h.set('X-Look', encodeURIComponent(JSON.stringify(cleanLook(look, u.garage))));
        return stub.fetch(new Request(`https://room/connect?${q}`, { headers: h }));
      }
      const h = routes.get(req.method + ' ' + url.pathname);
      if (h) {
        const out = await h(env, req, url);
        if (Math.random() < 0.01) {
          const t = Date.now();
          await env.DB.batch([
            env.DB.prepare('DELETE FROM sessions WHERE seen < ?').bind(t - 90 * 86400_000),
            env.DB.prepare('DELETE FROM limits WHERE until < ?').bind(t),
          ]);
        }
        return json(out);
      }
      if (url.pathname === '/' || url.pathname === '') return new Response('Рали Родопи — сървър.', { headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS } });
      return json({ error: 'Няма такова нещо.' }, 404);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, ...e.extra }, e.status);
      console.error(e);
      return json({ error: 'Сървърът има проблем. Опитай пак.' }, 500);
    }
  },
};
export type { D1, NS };
