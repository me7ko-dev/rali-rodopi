// Talking to the online server: profiles and leaderboards over HTTP, races over a WebSocket.
import { API } from './config.js';

const store = {
  get(k) { try { return localStorage.getItem('rali:' + k); } catch (e) { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem('rali:' + k); else localStorage.setItem('rali:' + k, String(v)); } catch (e) { /* private mode */ } }
};

export class Api {
  constructor() { this.token = store.get('token') || ''; this.me = null; this.online = !!API; }
  get signedIn() { return !!this.token && !!this.me; }

  async call(path, { method = 'POST', body, timeout = 8000 } = {}) {
    if (!API) throw Object.assign(new Error('Онлайн е изключен.'), { status: 0 });
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeout);
    let r;
    try {
      r = await fetch(API + path, { method, signal: ctl.signal, headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: 'Bearer ' + this.token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    } catch (e) {
      throw Object.assign(new Error('Сървърът не отговаря. Провери интернета или играй сам с ботове.'), { status: 0 });
    } finally { clearTimeout(timer); }
    let data = {};
    try { data = await r.json(); } catch (e) { /* not json */ }
    if (r.status === 401 && this.token && path !== '/api/login') { this.setToken(''); this.me = null; }
    if (!r.ok) throw Object.assign(new Error(data.error || 'Нещо се обърка (' + r.status + ').'), { status: r.status, data });
    if (data.me) this.me = data.me;
    return data;
  }
  setToken(t) { this.token = t; store.set('token', t || null); }

  async register(name, pass) { const d = await this.call('/api/register', { body: { name, pass } }); this.setToken(d.token); return d.me; }
  async login(name, pass) { const d = await this.call('/api/login', { body: { name, pass } }); this.setToken(d.token); return d.me; }
  async logout() { try { await this.call('/api/logout'); } catch (e) { /* ignore */ } this.setToken(''); this.me = null; }
  async refresh() { if (!this.token) return null; try { return (await this.call('/api/me', { method: 'GET' })).me; } catch (e) { if (e.status === 401) return null; throw e; } }
  async deleteMe(pass) { await this.call('/api/delete', { body: { pass } }); this.setToken(''); this.me = null; }
  look(look) { return this.call('/api/look', { body: { look } }); }
  solo(track, place) { return this.call('/api/solo', { body: { track, place } }); }
  importPoints(points) { return this.call('/api/import', { body: { points } }); }
  top(track) { return this.call('/api/top?track=' + encodeURIComponent(track), { method: 'GET' }); }
  week() { return this.call('/api/week', { method: 'GET' }); }
  room(track, laps) { return this.call('/api/room', { body: { track, laps } }); }
  ping() { return this.call('/api/ping', { method: 'GET', timeout: 5000 }); }
}

/**
 * One race connection. Emits through `on(type, fn)`: hello, lobby, start, s (snapshot), fin, res, saved, err,
 * lost (connection dropped, trying again), back (reconnected), dead (gave up).
 * Keeps a clock offset to the server so countdowns and smoothing use the server's time.
 */
export class RaceLink {
  constructor(api) { this.api = api; this.ws = null; this.handlers = {}; this.offset = 0; this.rtt = 150; this.room = ''; this.closed = false; this.retries = 0; }
  on(t, fn) { (this.handlers[t] ||= []).push(fn); return this; }
  emit(t, m) { for (const f of this.handlers[t] || []) try { f(m); } catch (e) { console.error(e); } }
  serverNow() { return Date.now() + this.offset; }

  connect(params) {
    this.params = params;
    return new Promise((resolve, reject) => {
      if (!API) { reject(new Error('Онлайн е изключен.')); return; }
      const qs = new URLSearchParams(params);
      let ws;
      try { ws = new WebSocket(API.replace(/^http/, 'ws') + '/api/play?' + qs, ['rali', this.api.token]); } catch (e) { reject(e); return; }
      this.ws = ws;
      let opened = false;
      const fail = setTimeout(() => { if (!opened) { try { ws.close(); } catch (e) { /* */ } reject(new Error('Сървърът не отговаря.')); } }, 9000);
      ws.onopen = () => { opened = true; clearTimeout(fail); this.sync(); this.pinger = setInterval(() => this.sync(), 4000); resolve(this); };
      ws.onerror = () => { if (!opened) { clearTimeout(fail); reject(new Error('Не успях да се свържа със сървъра. Влез отново или опитай след малко.')); } };
      ws.onclose = ev => { clearInterval(this.pinger); if (opened && this.ws === ws) this.dropped(ev); };
      ws.onmessage = ev => {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.t === 'pong') {
          const now = Date.now(), rtt = now - m.c;
          // keep the best (lowest round trip) estimates; they are the most accurate
          if (rtt < this.rtt * 1.5 || !this.synced) { this.offset = m.s - (m.c + now) / 2; this.synced = true; }
          this.rtt = this.rtt * 0.7 + rtt * 0.3;
          return;
        }
        if (m.t === 'hello') { this.room = m.room; this.you = m.you; }
        if (m.t === 'err') this.closed = true;
        this.emit(m.t, m);
      };
    });
  }
  sync() { this.send({ t: 'ping', c: Date.now() }); }
  send(m) { if (this.ws && this.ws.readyState === 1) { this.ws.send(JSON.stringify(m)); return true; } return false; }

  /** The connection fell over: try to come back to the same room three times, then give up. */
  async dropped(ev) {
    if (this.closed || ev.code === 1000 || ev.code === 4000 || ev.code === 4001) { this.emit('closed', ev); return; }
    this.emit('lost');
    for (const wait of [800, 2000, 4500]) {
      await new Promise(r => setTimeout(r, wait));
      if (this.closed) return;
      try {
        await this.connect({ car: this.params.car, rejoin: this.room });
        this.emit('back');
        return;
      } catch (e) { /* try again */ }
    }
    this.closed = true;
    this.emit('dead');
  }
  close() { this.closed = true; clearInterval(this.pinger); try { this.send({ t: 'leave' }); this.ws?.close(1000, 'bye'); } catch (e) { /* */ } }
}

export { Smoother } from './core/smooth.js';
