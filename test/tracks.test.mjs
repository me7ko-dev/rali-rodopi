// Every track must be a clean, drivable loop: node --test test/tracks.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRACKS, THEMES, CARS, LAPS } from '../js/data.js';
import { trackGeometry, W, RUN, LIM } from '../js/core/geo.js';
import { CarBody } from '../js/core/physics.js';
import { lapCheck, gridSlot } from '../js/core/race.js';

const PLAYABLE = CARS.filter(c => !c.aiOnly);
const CLEAR = 2 * (W + RUN) + 2; // two road bands (with run-off and walls) must never touch
const FAR = 120;                 // metres along the track after which two points count as "not neighbours"
const MAX_CURV = 0.045;          // rad/m, a radius of about 22 m: the AI and players can take it at a sane speed
const ORIGINAL = [
  [[0, 0], [120, -10], [220, 40], [260, 140], [200, 220], [100, 200], [40, 260], [-80, 280], [-180, 220], [-200, 110], [-120, 60], [-80, -20]],
  [[0, 0], [140, 0], [230, -50], [300, 10], [280, 110], [180, 130], [150, 210], [230, 290], [160, 360], [40, 330], [20, 230], [-60, 180], [-160, 230], [-240, 160], [-200, 50], [-100, 30]],
  [[0, 0], [200, -20], [340, 60], [360, 200], [260, 280], [140, 240], [60, 300], [80, 420], [-40, 480], [-160, 420], [-140, 300], [-240, 220], [-260, 80], [-140, 20]]
];

test('track list: unique ids, the first three unchanged, every track has a known theme', () => {
  const ids = TRACKS.map(t => t.id);
  assert.equal(new Set(ids).size, ids.length, 'unique ids');
  assert.deepEqual(ids.slice(0, 3), ['dospat', 'velingrad', 'sarnitsa']);
  // the online server and the records depend on these points
  assert.deepEqual(TRACKS.slice(0, 3).map(t => t.pts), ORIGINAL);
  for (const t of TRACKS.slice(0, 3)) assert.equal(t.grip, undefined, t.id + ' keeps full grip');
  assert.ok(TRACKS.length >= 6);
  for (const t of TRACKS) {
    assert.ok(THEMES[t.theme], t.id + ' theme ' + t.theme);
    assert.ok(t.name && t.sub, t.id + ' name and description');
    assert.ok(t.grip === undefined || (t.grip > 0.6 && t.grip <= 1), t.id + ' grip');
  }
});

for (const def of TRACKS) {
  test(`${def.id}: geometry builds, sensible length`, () => {
    const g = trackGeometry(def);
    assert.ok(g.M > 300 && Number.isFinite(g.length), 'samples');
    assert.ok(g.length > 1500 && g.length < 2700, 'length ' + g.length.toFixed(0));
    for (let i = 0; i < g.M; i++) assert.ok(Number.isFinite(g.px[i] + g.pz[i] + g.curv[i]), 'finite at ' + i);
  });

  test(`${def.id}: the road never runs into itself`, () => {
    const g = trackGeometry(def);
    // coarse grid: each cell is CLEAR wide, so close points are always in the same or a neighbouring cell
    const cells = new Map(), key = (a, b) => a + ',' + b;
    for (let i = 0; i < g.M; i++) {
      const k = key(Math.floor(g.px[i] / CLEAR), Math.floor(g.pz[i] / CLEAR));
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push(i);
    }
    const far = Math.ceil(FAR / g.ds);
    let worst = Infinity, at = null;
    for (let i = 0; i < g.M; i++) {
      const cx = Math.floor(g.px[i] / CLEAR), cz = Math.floor(g.pz[i] / CLEAR);
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
        for (const j of cells.get(key(cx + a, cz + b)) || []) {
          if (j <= i) continue;
          const gap = Math.min(j - i, g.M - (j - i));
          if (gap < far) continue;
          const d = Math.hypot(g.px[i] - g.px[j], g.pz[i] - g.pz[j]);
          if (d < worst) { worst = d; at = [i, j]; }
        }
      }
    }
    assert.ok(worst > CLEAR, `${def.id}: samples ${at} only ${worst.toFixed(1)} m apart (need ${CLEAR})`);
  });

  test(`${def.id}: bends are drivable`, () => {
    const g = trackGeometry(def);
    let max = 0; for (let i = 0; i < g.M; i++) max = Math.max(max, g.curv[i]);
    assert.ok(max < MAX_CURV, `${def.id}: tightest bend ${max.toFixed(4)} rad/m, radius ${(1 / max).toFixed(1)} m`);
    // the start line sits on a straight-ish piece, so the grid and the pit props fit
    for (let i = -10; i <= 10; i++) assert.ok(g.curv[(i + g.M) % g.M] < 0.02, 'straight at the start');
  });

  test(`${def.id}: an AI car finishes ${LAPS} laps inside the walls`, () => {
    const g = trackGeometry(def);
    for (const spec of [PLAYABLE[0], PLAYABLE[3]]) {
      const c = new CarBody(spec, 'AI');
      const { idx, lateral } = gridSlot(g.M, 0);
      c.place(g, idx, lateral); c.total = idx - g.M;
      let t = 0, maxD = 0;
      const dt = 1 / 120;
      while (c.finish == null && t < 400) {
        c.update(dt, c.drive(g, [c]), g);
        t += dt; maxD = Math.max(maxD, Math.abs(c.d));
        lapCheck(c, t, g.M, LAPS);
      }
      assert.ok(c.finish != null && c.finish < 400, `${def.id} ${spec.id}: finished (${t.toFixed(1)} s)`);
      assert.equal(c.lapTimes.length, LAPS);
      assert.ok(maxD <= LIM, `${def.id} ${spec.id}: stayed inside, max |d| ${maxD.toFixed(2)}`);
    }
  });
}
