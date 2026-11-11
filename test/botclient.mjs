// A robot player for testing the online server: it signs in, joins a race through the WebSocket
// and drives with the real game physics, sending its position 15 times a second like the browser does.
// cheat: 'speed' makes the car move twice as fast as physics allows (the server must reject the result).
import { TRACKS, CARS } from '../js/data.js';
import { trackGeometry } from '../js/core/geo.js';
import { CarBody } from '../js/core/physics.js';
import { gridSlot, lapCheck } from '../js/core/race.js';

export async function call(api, path, { method = 'POST', body, token, from } = {}) {
  const r = await fetch(api + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(from ? { 'X-Forwarded-For': from } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = {};
  try { data = await r.json(); } catch { /* */ }
  return { status: r.status, ...data };
}

/**
 * Join a race and drive it. opts: { api, token, car, query ('quick' | {code} | {rejoin}), cheat, onLobby(msg, ws), log }
 * Resolves with { hello, results, slot, finish, msgs } after the results arrive (or on timeout).
 */
export function race({ api, token, car = 'race', query = {}, cheat = null, onLobby, onMsg, timeout = 300000, log = () => {} }) {
  const qs = new URLSearchParams({ car, ...query });
  const ws = new WebSocket(api.replace(/^http/, 'ws') + '/api/play?' + qs, ['rali', token]);
  return new Promise((resolve, reject) => {
    const out = { hello: null, results: null, slot: -1, finish: null, msgs: [], saved: false, errors: [] };
    let geo = null, body = null, laps = 3, startAt = 0, offset = 0, drive = null, lastReal = 0, sendT = 0, raceT = 0;
    const timer = setTimeout(() => { done(); }, timeout);
    const done = () => { clearTimeout(timer); clearInterval(drive); try { ws.close(); } catch { /* */ } resolve(out); };
    ws.onerror = e => { out.errors.push(String(e.message || 'ws error')); };
    ws.onclose = ev => { if (!out.results) { out.closed = ev.code; done(); } };
    const ping = () => ws.send(JSON.stringify({ t: 'ping', c: Date.now() }));
    ws.onopen = () => { ping(); };
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      out.msgs.push(m.t);
      onMsg?.(m, ws);
      if (m.t === 'pong') { const now = Date.now(); offset = m.s - (m.c + now) / 2; return; }
      if (m.t === 'err') { out.error = m; return; }
      if (m.t === 'hello') { out.hello = m; onLobby?.(m, ws); return; }
      if (m.t === 'lobby') { onLobby?.(m, ws); return; }
      if (m.t === 'start') {
        const me = m.players.find(p => p.id === out.hello.you);
        out.slot = me.slot; out.players = m.players; out.track = m.track;
        const def = TRACKS.find(t => t.id === m.track);
        geo = trackGeometry(def); laps = m.laps; startAt = m.startAt;
        body = new CarBody(CARS.find(c => c.id === car), 'bot');
        const g = gridSlot(geo.M, me.slot);
        body.place(geo, g.idx, g.lateral); body.total = g.idx - geo.M;
        log(`слот ${me.slot}, писта ${m.track}, ${laps} обиколки, ${m.players.length} коли`);
        ping();
        drive = setInterval(() => {
          const serverNow = Date.now() + offset;
          if (serverNow < startAt) { lastReal = Date.now(); return; }
          const real = Date.now(), dt = Math.min((real - (lastReal || real)) / 1000, 0.1); lastReal = real;
          const k = cheat === 'speed' ? 2 : 1;
          let left = dt * k;
          while (left > 1e-6) {
            const h = Math.min(left, 1 / 120);
            const inp = body.drive(geo, [body]);
            if (body.finish != null) inp.throttle = body.vf < 15 ? 0.5 : 0;
            body.update(h, inp, geo);
            left -= h;
          }
          raceT += dt;
          const clock = (serverNow - startAt) / 1000;
          if (lapCheck(body, clock, geo.M, laps) === 'finish') { out.finish = clock; log('финал на ' + clock.toFixed(1) + ' s'); }
          sendT += dt;
          if (sendT >= 1 / 15) {
            sendT = 0;
            ws.send(JSON.stringify({ t: 'p', x: body.x, z: body.z, h: body.heading, v: body.vf, k: clock, f: 0 }));
          }
        }, 1000 / 60);
        return;
      }
      if (m.t === 'res') { out.results = m; return; }
      if (m.t === 'saved') { out.saved = !m.error; done(); }
    };
  });
}
