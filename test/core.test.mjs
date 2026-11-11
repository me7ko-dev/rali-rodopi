// Tests for the game core without a browser: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRACKS, CARS, LAPS } from '../js/data.js';
import { trackGeometry, shortestLap, LIM } from '../js/core/geo.js';
import { CarBody, collide } from '../js/core/physics.js';
import { lapCheck, rank, gridSlot, minLapTime, Referee, maxSpeed, pointsFor, CHECKPOINTS } from '../js/core/race.js';

const PLAYABLE = CARS.filter(c => !c.aiOnly);

/** Drive one AI car around a track with the game's fixed steps; calls onTick(car, time) every `every` seconds. */
function drive(def, spec, { laps = LAPS, dt = 1 / 120, every = 1 / 15, onTick, skill = 1 } = {}) {
  const geo = trackGeometry(def);
  const c = new CarBody(spec, 'AI');
  const { idx, lateral } = gridSlot(geo.M, 0);
  c.place(geo, idx, lateral); c.total = idx - geo.M; c.skill = skill;
  let t = 0, next = 0, maxD = 0;
  while ((c.finish == null || t < c.finish + 0.5) && t < 600) {
    c.update(dt, c.drive(geo, [c]), geo);
    t += dt; maxD = Math.max(maxD, Math.abs(c.d));
    lapCheck(c, t, geo.M, laps);
    if (onTick && t >= next) { onTick(c, t); next += every; }
  }
  return { c, t, maxD, geo };
}

test('tracks: closed, evenly sampled, sensible size', () => {
  for (const def of TRACKS) {
    const g = trackGeometry(def);
    assert.ok(g.M > 300, def.id + ' has samples');
    assert.ok(Math.abs(g.ds - 2) < 0.01, def.id + ' samples about every 2 m');
    // neighbours (including last → first) are one step apart
    for (let i = 0; i < g.M; i++) {
      const j = (i + 1) % g.M;
      assert.ok(Math.abs(Math.hypot(g.px[j] - g.px[i], g.pz[j] - g.pz[i]) - g.ds) < 0.05, def.id + ' gap at ' + i);
    }
    // unit tangents and normals
    assert.ok(Math.abs(Math.hypot(g.tx[5], g.tz[5]) - 1) < 1e-5);
    assert.ok(Math.abs(g.tx[5] * g.nx[5] + g.tz[5] * g.nz[5]) < 1e-5);
    // the shortest line is shorter than the centre line, but not absurdly so
    const s = shortestLap(g);
    assert.ok(s < g.length && s > g.length * 0.6, def.id + ' shortest ' + s);
  }
});

test('locate and lateral find the point back', () => {
  const g = trackGeometry(TRACKS[0]);
  for (const i of [0, 17, 200, g.M - 1]) {
    const x = g.px[i] + g.nx[i] * 3, z = g.pz[i] + g.nz[i] * 3;
    assert.equal(g.locate(x, z), i);
    assert.equal(g.locate(x, z, (i + 10) % g.M), i);
    assert.ok(Math.abs(g.lateral(x, z, i) - 3) < 0.01);
  }
});

test('car reaches its top speed on full throttle and stops with the brake', () => {
  const g = trackGeometry(TRACKS[2]);
  const spec = PLAYABLE[0];
  const c = new CarBody(spec, 'x'); c.place(g, 0, 0);
  // straight line test: keep pointing along the track
  let vmax = 0;
  for (let t = 0; t < 6; t += 1 / 120) { c.update(1 / 120, { throttle: 1, brake: 0, steer: 0, hand: false, nitro: false }, g); vmax = Math.max(vmax, c.vf); }
  assert.ok(vmax > 25, 'accelerates: ' + vmax);
  assert.ok(vmax <= spec.top + 0.01, 'no faster than top without nitro');
  for (let t = 0; t < 4; t += 1 / 120) c.update(1 / 120, { throttle: 0, brake: 1, steer: 0, hand: false, nitro: false }, g);
  assert.ok(Math.abs(c.vf) < 14, 'brakes');
});

test('walls hold the car on the track', () => {
  const g = trackGeometry(TRACKS[1]);
  const c = new CarBody(PLAYABLE[2], 'x'); c.place(g, 50, 0);
  for (let t = 0; t < 12; t += 1 / 120) {
    c.update(1 / 120, { throttle: 1, brake: 0, steer: 1, hand: t % 3 < 1, nitro: true }, g);
    assert.ok(Math.abs(c.d) <= LIM + 1e-6, 'inside the wall at t=' + t.toFixed(2));
  }
});

test('collisions push cars apart; a ghost (remote) car never moves', () => {
  const a = new CarBody(PLAYABLE[0], 'a'), b = new CarBody(PLAYABLE[1], 'b');
  a.x = 0; a.z = 0; b.x = 1; b.z = 0; a.vx = 10; b.vx = 0;
  collide([a, b]);
  assert.ok(b.x - a.x >= 3.09, 'apart');
  const c = new CarBody(PLAYABLE[0], 'c'), d = new CarBody(PLAYABLE[1], 'd');
  c.x = 0; d.x = 1; d.ghost = true;
  collide([c, d]);
  assert.equal(d.x, 1); assert.ok(c.x <= -2.09);
});

test('AI finishes 3 laps on every track; laps are well above the impossible limit', () => {
  for (const def of TRACKS) {
    const { c, t, maxD, geo } = drive(def, PLAYABLE[0]);
    assert.ok(c.finish != null, def.id + ' finished');
    assert.equal(c.lapTimes.length, LAPS);
    assert.ok(maxD <= LIM + 1e-6);
    const min = minLapTime(geo, PLAYABLE);
    const best = Math.min(...c.lapTimes);
    assert.ok(best > min * 1.3, `${def.id}: best ${best.toFixed(1)} s vs impossible ${min.toFixed(1)} s`);
    assert.ok(t < 400);
  }
});

test('lap counting starts behind the line and counts each lap once', () => {
  const c = { total: -5, lapsDone: -1, lapStart: 0, lapTimes: [], finish: null };
  const M = 100;
  assert.equal(lapCheck(c, 1, M, 2), null);
  c.total = 0; assert.equal(lapCheck(c, 2, M, 2), null); assert.equal(c.lapStart, 2);
  c.total = 50; assert.equal(lapCheck(c, 5, M, 2), null);
  c.total = 100; assert.equal(lapCheck(c, 10, M, 2), 'lap'); assert.deepEqual(c.lapTimes, [8]);
  assert.equal(lapCheck(c, 11, M, 2), null);
  c.total = 200; assert.equal(lapCheck(c, 20, M, 2), 'finish'); assert.equal(c.finish, 20);
});

test('ranking: finished by time, then by progress', () => {
  const r = rank([{ n: 'a', total: 10, finish: null }, { n: 'b', total: 50, finish: null }, { n: 'c', total: 300, finish: 90 }, { n: 'd', total: 300, finish: 80 }]);
  assert.deepEqual(r.map(x => x.n), ['d', 'c', 'b', 'a']);
  assert.equal(pointsFor(1, true), 12); assert.equal(pointsFor(9, false), 0);
});

/** Run the referee on a drive. cheat(c, t) may change what gets reported. */
function referee(def, spec, laps, report = (c, t) => [c.x, c.z, t, t]) {
  const geo = trackGeometry(def);
  const ref = new Referee(geo, spec, laps, minLapTime(geo, PLAYABLE), gridSlot(geo.M, 0));
  const r = drive(def, spec, { laps, onTick: (c, t) => { const [x, z, k, now] = report(c, t); ref.feed(x, z, k, now); } });
  return { ref, r };
}

test('referee: an honest drive is valid and agrees with the car', () => {
  for (const def of TRACKS) {
    const { ref, r } = referee(def, PLAYABLE[2], 2);
    assert.ok(ref.valid, def.id + ' flags: ' + [...ref.flags]);
    assert.ok(ref.finish != null, def.id + ' referee saw the finish');
    assert.ok(Math.abs(ref.finish - r.c.finish) < 0.2, `${def.id} ${ref.finish} vs ${r.c.finish}`);
  }
});

test('referee: too fast (clock or distance) is flagged', () => {
  const def = TRACKS[0];
  // reports a race clock that runs twice as fast as the server's
  let a = referee(def, PLAYABLE[0], 1, (c, t) => [c.x, c.z, t, t / 2]);
  assert.ok(!a.ref.valid, 'fast clock');
  // a car that moves twice as far per tick as its clock allows (speed hack)
  a = referee(def, PLAYABLE[0], 1, (c, t) => [c.x, c.z, t / 2, t / 2]);
  assert.ok(a.ref.flags.has('speed') || a.ref.flags.has('laptime'), 'speed hack: ' + [...a.ref.flags]);
});

test('referee: teleporting ahead gives no progress; skipping checkpoints is flagged', () => {
  const def = TRACKS[1], geo = trackGeometry(def);
  const ref = new Referee(geo, PLAYABLE[0], 1, minLapTime(geo, PLAYABLE), gridSlot(geo.M, 0));
  let t = 0;
  // jump straight to the finish line area, again and again
  for (let n = 0; n < 10; n++) { t += 0.07; ref.feed(geo.px[geo.M - 3], geo.pz[geo.M - 3], t, t); ref.feed(geo.px[5], geo.pz[5], t + 0.01, t + 0.01); }
  assert.equal(ref.finish, null, 'no finish from jumps');
  assert.ok(!ref.valid);
  // positions off the map
  const r2 = new Referee(geo, PLAYABLE[0], 1, 10, gridSlot(geo.M, 0));
  r2.feed(99999, 99999, 0.1, 0.1);
  assert.ok(r2.flags.has('offtrack'));
  assert.equal(CHECKPOINTS, 8);
  // a gap after a lost connection is accepted when the clock explains it
  const r3 = new Referee(geo, PLAYABLE[0], 3, minLapTime(geo, PLAYABLE), gridSlot(geo.M, 0));
  r3.feed(geo.px[2], geo.pz[2], 0.5, 0.5);
  r3.feed(geo.px[120], geo.pz[120], 12, 12);
  assert.ok(r3.total > 100 && r3.valid, 'gap after reconnect: ' + [...r3.flags]);
});

test('max speed allows nitro and bumps', () => {
  for (const s of PLAYABLE) assert.ok(maxSpeed(s) > s.top * 1.2);
});
