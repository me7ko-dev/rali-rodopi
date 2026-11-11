// Състезанията на сървъра: всяко състезание е отделен Durable Object („стая“), а лобито събира хората.
// Браузърът кара колата си и праща позицията 15 пъти в секунда; стаята я проверява (съдия от js/core/race.js),
// препраща на другите, кара ботовете и накрая записва класирането.
import { TRACKS, CARS } from '../../js/data.js';
import { trackGeometry } from '../../js/core/geo.js';
import { CarBody } from '../../js/core/physics.js';
import { Referee, lapCheck, rank, gridSlot, minLapTime, pointsFor, MAX_PLAYERS } from '../../js/core/race.js';
import { cleanLook } from '../../js/core/looks.js';
import type { DOState, Env } from './types';

declare const WebSocketPair: { new(): { 0: WebSocket; 1: WebSocket & { accept(): void } } };

type Spec = { id: string; name: string; top: number; acc: number; grip: number; aiOnly?: boolean };
type TrackDef = { id: string; name: string; pts: number[][]; grip?: number };
const PLAYABLE = (CARS as Spec[]).filter((c) => !c.aiOnly);

export const TICK_MS = 1000 / 15;
export const WAIT_MS = 15_000;       // бързо състезание: толкова се чакат хора, после се допълва с ботове
export const COUNT_MS = 4_000;       // от „старт“ до зеления светофар (3-2-1 + време да се зареди пистата)
const AFTER_FIRST_MS = 45_000;       // след първия финиширал човек останалите имат толкова време
const MAX_RACE_MS = 10 * 60_000;
const GONE_MS = 30_000;              // изгубена връзка: след толкова колата спира да се чака
const QUICK_CARS = 6;                // бързо състезание: допълва се с ботове до толкова коли
const CODE_MIN_CARS = 4;             // стая с код: ако сте по-малко, се добавят ботове
const BOT_NAMES = ['Гошо', 'Ива', 'Марто', 'Деси', 'Боби', 'Ники', 'Тони', 'Рали'];

type Phase = 'new' | 'wait' | 'count' | 'race' | 'done';
interface Player {
  id: string; name: string; car: Spec; look: unknown; bot: boolean; slot: number;
  ws: (WebSocket & { accept(): void }) | null; goneAt: number;
  ref?: Referee; body?: CarBody;
  x: number; z: number; h: number; v: number; f: number; total: number; d: number;
  finish: number | null; lapTimes: number[]; msgs: number; msgWin: number;
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const trackDef = (id: string) => (TRACKS as TrackDef[]).find((t) => t.id === id);

export class RaceRoom {
  private phase: Phase = 'new';
  private players: Player[] = [];
  private name = '';
  private mode: 'quick' | 'code' = 'quick';
  private code = '';
  private host = '';
  private def: TrackDef = TRACKS[0];
  private laps = 3;
  private deadline = 0;
  private startAt = 0;
  private firstFinish = 0;
  private doneAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private saved = false;

  constructor(private state: DOState, private env: Env) {}

  private get geo() { return trackGeometry(this.def); }
  private humans() { return this.players.filter((p) => !p.bot); }
  private now() { return (Date.now() - this.startAt) / 1000; }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const q = url.searchParams;
    const id = req.headers.get('X-User-Id') || '';
    const name = decodeURIComponent(req.headers.get('X-User-Name') || 'Играч');
    const car = PLAYABLE.find((c) => c.id === req.headers.get('X-Car')) || PLAYABLE[0];
    let look: unknown = null;
    try { look = cleanLook(JSON.parse(decodeURIComponent(req.headers.get('X-Look') || 'null'))); } catch { /* */ }

    const pair = new WebSocketPair();
    const client = pair[0], ws = pair[1];
    ws.accept();
    const reply = () => new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': 'rali' } } as ResponseInit);
    const refuse = (code: string, msg: string) => { this.send(ws, { t: 'err', code, msg }); setTimeout(() => { try { ws.close(4000, code); } catch { /* */ } }, 50); return reply(); };

    if (this.phase === 'new') {
      if (q.get('mode') === 'rejoin') return refuse('gone', 'Състезанието вече свърши.');
      this.name = q.get('room') || '';
      this.mode = q.get('mode') === 'code' ? 'code' : 'quick';
      this.code = q.get('code') || '';
      this.host = this.mode === 'code' ? (q.get('host') || id) : '';
      this.def = trackDef(q.get('track') || '') || TRACKS[0];
      this.laps = this.mode === 'code' ? Math.max(1, Math.min(5, Number(q.get('laps')) || 3)) : 3;
      this.deadline = this.mode === 'quick' ? Number(q.get('deadline')) || Date.now() + WAIT_MS : 0;
      this.phase = 'wait';
    }

    let p = this.players.find((x) => x.id === id && !x.bot);
    if (p) {
      // връщане след прекъсване (или втори раздел): новата връзка заменя старата
      if (p.ws && p.ws !== ws) { try { p.ws.close(4001, 'replaced'); } catch { /* */ } }
      p.ws = ws; p.goneAt = 0;
    } else {
      if (this.phase !== 'wait') return refuse('started', 'Това състезание вече тръгна.');
      if (this.humans().length >= MAX_PLAYERS) return refuse('full', 'Стаята е пълна.');
      p = this.newPlayer(id, name, car, look, false);
      p.ws = ws;
      this.players.push(p);
    }
    const me = p;
    ws.addEventListener('message', (ev: MessageEvent) => {
      try {
        const m = JSON.parse(String(ev.data));
        if (m && typeof m.t === 'string') this.onMessage(me, ws, m);
      } catch { /* грешни данни */ }
    });
    const gone = () => this.onClose(me, ws);
    ws.addEventListener('close', gone);
    ws.addEventListener('error', gone);

    this.send(ws, this.hello(me));
    this.lobbyUpdate();
    if (this.mode === 'quick' && this.phase === 'wait' && this.humans().length >= MAX_PLAYERS) this.startCountdown();
    this.ensureTimer();
    return reply();
  }

  private newPlayer(id: string, name: string, car: Spec, look: unknown, bot: boolean): Player {
    return { id, name, car, look, bot, slot: -1, ws: null, goneAt: 0, x: 0, z: 0, h: 0, v: 0, f: 0, total: 0, d: 0, finish: null, lapTimes: [], msgs: 0, msgWin: 0 };
  }

  private send(ws: WebSocket | null, m: unknown) { if (ws) try { ws.send(JSON.stringify(m)); } catch { /* затворена */ } }
  private broadcast(m: unknown) { const s = JSON.stringify(m); for (const p of this.players) if (p.ws) try { p.ws.send(s); } catch { /* */ } }

  private list() {
    return this.players.map((p) => ({ id: p.id, slot: p.slot, name: p.name, car: p.car.id, look: p.look, bot: p.bot, on: p.bot || !!p.ws }));
  }
  private info() {
    return { room: this.name, mode: this.mode, code: this.code, host: this.host, track: this.def.id, laps: this.laps, phase: this.phase, deadline: this.deadline, startAt: this.startAt, now: Date.now() };
  }
  private hello(p: Player) {
    return { t: 'hello', you: p.id, slot: p.slot, ...this.info(), players: this.list() };
  }
  private lobbyUpdate() { this.broadcast({ t: 'lobby', ...this.info(), players: this.list() }); }

  private onMessage(p: Player, ws: WebSocket, m: Record<string, unknown>) {
    if (p.ws !== ws) return;
    if (m.t === 'ping') { this.send(ws, { t: 'pong', c: m.c, s: Date.now() }); return; }
    if (m.t === 'p') {
      // най-много 30 съобщения в секунда (повече е излишно и се пренебрегва)
      const t = Date.now();
      if (t - p.msgWin > 1000) { p.msgWin = t; p.msgs = 0; }
      if (++p.msgs > 30) return;
      if (this.phase !== 'race' && this.phase !== 'done') return;
      const x = Number(m.x), z = Number(m.z), k = Number(m.k);
      if (!Number.isFinite(x) || !Number.isFinite(z)) return;
      p.x = x; p.z = z; p.h = Number(m.h) || 0; p.v = Number(m.v) || 0; p.f = Number(m.f) | 0;
      if (this.phase === 'race' && p.ref && p.finish == null) {
        const ev = p.ref.feed(x, z, k, this.now());
        p.total = p.ref.total; p.d = this.geo.lateral(x, z, p.ref.idx);
        if (ev === 'finish') this.onFinish(p, p.ref.finish!);
      }
      return;
    }
    if (m.t === 'start' && this.mode === 'code' && p.id === this.host && this.phase === 'wait') { this.startCountdown(); return; }
    if (m.t === 'leave') { try { ws.close(1000, 'bye'); } catch { /* */ } this.onClose(p, ws); }
  }

  private onClose(p: Player, ws: WebSocket) {
    if (p.ws !== ws) return;
    p.ws = null; p.goneAt = Date.now();
    if (this.phase === 'wait') {
      this.players = this.players.filter((x) => x !== p);
      if (p.id === this.host) this.host = this.humans()[0]?.id || '';
      this.lobbyUpdate();
    }
  }

  private ensureTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => { try { this.tick(); } catch (e) { console.error(e); } }, TICK_MS);
  }
  private stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  private report() {
    void this.env.LOBBY.get(this.env.LOBBY.idFromName('lobby')).fetch('https://lobby/report', {
      method: 'POST', body: JSON.stringify({ room: this.name, phase: this.phase, mode: this.mode, code: this.code, humans: this.humans().length }),
    }).catch(() => {});
  }

  private startCountdown() {
    const geo = this.geo;
    const want = this.mode === 'quick' ? QUICK_CARS : CODE_MIN_CARS;
    let n = 0;
    while (this.players.length < want) {
      const spec = PLAYABLE[(Math.random() * PLAYABLE.length) | 0];
      const bot = this.newPlayer('b' + n, BOT_NAMES[n % BOT_NAMES.length], spec, null, true);
      bot.body = new CarBody(spec, bot.name);
      bot.body.skill = 0.9 + Math.random() * 0.1;
      bot.body.baseLane = bot.body.lane = (n % 2 ? -1 : 1) * (1.2 + (n % 3));
      this.players.push(bot); n++;
    }
    const minLap = minLapTime(geo, PLAYABLE);
    this.players.forEach((p, k) => {
      p.slot = k;
      const g = gridSlot(geo.M, k);
      const idx = ((g.idx % geo.M) + geo.M) % geo.M;
      p.x = geo.px[idx] + geo.nx[idx] * g.lateral; p.z = geo.pz[idx] + geo.nz[idx] * g.lateral;
      p.h = Math.atan2(geo.tx[idx], geo.tz[idx]); p.v = 0; p.total = g.idx - geo.M; p.d = g.lateral;
      p.finish = null; p.lapTimes = [];
      if (p.bot) {
        const b = p.body!;
        b.place(geo, g.idx, g.lateral); b.total = g.idx - geo.M; b.lapsDone = -1; b.lapStart = 0; b.finish = null; b.lapTimes = [];
      } else p.ref = new Referee(geo, p.car, this.laps, minLap, g);
    });
    this.startAt = Date.now() + COUNT_MS;
    this.firstFinish = 0; this.saved = false;
    this.phase = 'count';
    this.broadcast({ t: 'start', ...this.info(), players: this.list() });
    this.report();
  }

  private onFinish(p: Player, time: number) {
    p.finish = time;
    if (!p.bot && !this.firstFinish) this.firstFinish = Date.now();
    this.broadcast({ t: 'fin', slot: p.slot, time, valid: p.bot || !!p.ref?.valid });
  }

  private tick() {
    const t = Date.now();
    if (this.phase === 'wait') {
      if (!this.humans().length) { this.close(); return; }
      if (this.mode === 'quick' && t >= this.deadline) this.startCountdown();
      return;
    }
    if (this.phase === 'count') {
      if (t >= this.startAt) this.phase = 'race';
      else return;
    }
    if (this.phase === 'race') {
      this.driveBots();
      const active = this.humans().filter((p) => p.finish == null && (p.ws || t - p.goneAt < GONE_MS));
      if (!active.length || (this.firstFinish && t - this.firstFinish > AFTER_FIRST_MS) || t - this.startAt > MAX_RACE_MS) void this.end();
    }
    if (this.phase === 'race' || this.phase === 'done') {
      const n = Date.now() - this.startAt;
      this.broadcast({ t: 's', n, c: this.players.map((p) => [p.slot, r2(p.x), r2(p.z), r2(p.h), r2(p.v), p.total, p.f]) });
    }
    if (this.phase === 'done') {
      if (!this.humans().some((p) => p.ws)) { this.close(); return; }
      if (t - this.doneAt > 10_000) {
        if (this.mode === 'code') this.rematch();
        else if (t - this.doneAt > 20_000) this.close();
      }
    }
  }

  /** Ботовете карат тук, с физиката на играта, по 4 стъпки на всеки тик. */
  private driveBots() {
    const geo = this.geo;
    const bots = this.players.filter((p) => p.bot);
    if (!bots.length) return;
    const others = this.players.map((p) => (p.bot ? p.body! : { total: p.total, d: p.d, x: p.x, z: p.z }));
    const dt = TICK_MS / 1000 / 4;
    const time = this.now();
    for (let s = 0; s < 4; s++) {
      for (const p of bots) {
        const b = p.body!;
        const inp = b.drive(geo, others as CarBody[]);
        if (b.finish != null) inp.throttle = b.vf < 22 ? 0.6 : 0;
        b.update(dt, inp, geo);
        if (lapCheck(b, time, geo.M, this.laps) === 'finish') this.onFinish(p, b.finish!);
      }
    }
    for (const p of bots) { const b = p.body!; p.x = b.x; p.z = b.z; p.h = b.heading; p.v = b.vf; p.total = b.total; p.d = b.d; p.f = 0; }
  }

  private async end() {
    if (this.phase !== 'race') return;
    this.phase = 'done'; this.doneAt = Date.now();
    const order = rank(this.players.map((p) => ({ p, finish: p.finish, total: p.total }))) as { p: Player }[];
    const rows = order.map((o: { p: Player }, i: number) => {
      const p = o.p, place = i + 1;
      const valid = p.bot || !!p.ref?.valid;
      const left = !p.bot && !p.ws && p.finish == null;
      const lapTimes = p.bot ? p.body!.lapTimes : p.ref!.lapTimes;
      const best = lapTimes.length ? Math.min(...lapTimes) : null;
      const pts = p.bot || !valid || left ? 0 : Math.round(pointsFor(place, p.finish != null) * this.laps / 3);
      const why = p.bot ? '' : [...(p.ref?.flags ?? [])].join(',');
      if (why) console.log('отхвърлен', p.name, p.ref?.detail);
      return { slot: p.slot, id: p.bot ? '' : p.id, name: p.name, bot: p.bot, car: p.car.id, place, time: p.finish, best, points: pts, valid, why };
    });
    this.broadcast({ t: 'res', track: this.def.id, laps: this.laps, rows });
    this.report();
    if (!this.saved) { this.saved = true; await this.save(rows); }
  }

  private async save(rows: { id: string; place: number; time: number | null; best: number | null; points: number; valid: boolean; why: string; car: string; bot: boolean }[]) {
    const db = this.env.DB, t = Date.now(), track = this.def.id;
    const humans = rows.filter((r) => !r.bot);
    const stmts = [];
    for (const r of humans) {
      const uid = Number(r.id.slice(1));
      const ms = r.time != null ? Math.round(r.time * 1000) : null, best = r.best != null ? Math.round(r.best * 1000) : null;
      stmts.push(db.prepare('INSERT INTO results (user, track, room, place, cars, humans, laps, time_ms, best_ms, points, valid, why, car, t) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(uid, track, this.name, r.place, rows.length, humans.length, this.laps, ms, best, r.points, r.valid ? 1 : 0, r.why, r.car, t));
      stmts.push(db.prepare('UPDATE users SET races = races + 1, wins = wins + ?, points = points + ?, garage = garage + ? WHERE id = ?')
        .bind(r.place === 1 && r.valid ? 1 : 0, r.points, r.points, uid));
      if (r.valid && best != null) {
        stmts.push(db.prepare('INSERT INTO laps (user, track, best_ms, car, t) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user, track) DO UPDATE SET best_ms = excluded.best_ms, car = excluded.car, t = excluded.t WHERE excluded.best_ms < laps.best_ms')
          .bind(uid, track, best, r.car, t));
      }
    }
    try { if (stmts.length) await db.batch(stmts); this.broadcast({ t: 'saved' }); } catch (e) { console.error('save', e); this.broadcast({ t: 'saved', error: true }); }
  }

  /** Стая с код: след класирането всички остават за реванш. */
  private rematch() {
    this.players = this.players.filter((p) => !p.bot && p.ws);
    for (const p of this.players) { p.slot = -1; p.ref = undefined; p.finish = null; p.lapTimes = []; p.total = 0; }
    if (!this.players.some((p) => p.id === this.host)) this.host = this.players[0]?.id || '';
    this.phase = 'wait'; this.startAt = 0;
    this.lobbyUpdate();
    this.report();
  }

  private close() {
    this.stop();
    for (const p of this.players) if (p.ws) { try { p.ws.close(1000, 'end'); } catch { /* */ } }
    this.players = []; this.phase = 'new';
    this.report();
  }
}

/** Лобито: събира хората за бързо състезание и пази кодовете на стаите за приятели. */
export class Lobby {
  private forming: { room: string; deadline: number; track: string; users: Set<string> } | null = null;
  private active = new Map<string, { humans: number; at: number }>();
  constructor(private state: DOState, private env: Env) {}

  private static rand(n: number) {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const a = new Uint8Array(n); crypto.getRandomValues(a);
    return [...a].map((x) => A[x % A.length]).join('');
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const q = url.searchParams;
    const t = Date.now();
    if (url.pathname === '/quick') {
      const user = q.get('user') || '';
      const f = this.forming;
      if (f && (f.users.has(user) || (f.users.size < MAX_PLAYERS && t < f.deadline - 1500))) {
        f.users.add(user);
        return Response.json({ room: f.room, deadline: f.deadline, track: f.track, laps: 3, mode: 'quick' });
      }
      const track = TRACKS[(Math.random() * TRACKS.length) | 0].id;
      this.forming = { room: 'q-' + t.toString(36) + '-' + Lobby.rand(4).toLowerCase(), deadline: t + WAIT_MS, track, users: new Set([user]) };
      return Response.json({ room: this.forming.room, deadline: this.forming.deadline, track, laps: 3, mode: 'quick' });
    }
    if (url.pathname === '/report') {
      const b = await req.json() as { room: string; phase: string; mode: string; code: string; humans: number };
      if (this.forming?.room === b.room && b.phase !== 'wait') this.forming = null;
      if (b.phase === 'new') {
        this.active.delete(b.room);
        if (b.code) await this.state.storage.delete('code:' + b.code);
      } else this.active.set(b.room, { humans: b.humans, at: t });
      return new Response('ok');
    }
    if (url.pathname === '/code/new') {
      let code = '';
      for (let i = 0; i < 10 && !code; i++) { const c = Lobby.rand(6); if (!(await this.state.storage.get('code:' + c))) code = c; }
      const pick = q.get('track') || 'random';
      const track = pick === 'random' ? TRACKS[(Math.random() * TRACKS.length) | 0].id : pick;
      const room = { room: 'c-' + code.toLowerCase() + '-' + t.toString(36), track, laps: Number(q.get('laps')) || 3, host: q.get('user') || '', code, at: t };
      await this.state.storage.put('code:' + code, room);
      return Response.json({ code, track, laps: room.laps });
    }
    if (url.pathname === '/code/get') {
      const code = (q.get('code') || '').toUpperCase();
      if (!/^[A-Z0-9]{6}$/.test(code)) return Response.json({ error: 'Кодът е от 6 знака.' });
      const r = await this.state.storage.get<{ room: string; track: string; laps: number; host: string; code: string; at: number }>('code:' + code);
      if (!r || t - r.at > 6 * 3600_000) return Response.json({ error: 'Няма стая с този код.' });
      return Response.json({ ...r, mode: 'code' });
    }
    if (url.pathname === '/count') {
      let racing = 0;
      for (const [k, v] of this.active) { if (t - v.at > 15 * 60_000) this.active.delete(k); else racing += v.humans; }
      return Response.json({ waiting: this.forming && t < this.forming.deadline ? this.forming.users.size : 0, racing });
    }
    return new Response('?', { status: 404 });
  }
}
