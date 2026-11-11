// Laps, checkpoints, ranking, points and the "is this result possible" rules.
// Shared by the game, the tests and the server, so everyone counts the same way.
import { shortestLap } from './geo.js';
import { NITRO_BOOST } from './physics.js';

export const CHECKPOINTS = 8;      // sectors per lap; they must be passed in order
export const MAX_PLAYERS = 8;
export const POINTS = [10, 8, 6, 5, 4, 3, 2, 1]; // by place (bots take places too)
export const FINISH_BONUS = 2;

/** Grid slot k (0 = pole): sample index and side. Everyone starts a little behind the line. */
export function gridSlot(M, k) {
  return { idx: M - 5 - k * 4, lateral: k % 2 ? -3.2 : 3.2 };
}

/**
 * Lap counter for one car, driven by its progress `total` (in samples). Starts behind the line at a negative total.
 * Returns 'lap' when a lap finished, 'finish' on the last one, or null.
 */
export function lapCheck(c, time, M, laps) {
  const done = Math.floor(c.total / M);
  if (done <= c.lapsDone) return null;
  c.lapsDone = done;
  let ev = null;
  if (done >= 1) { c.lapTimes.push(time - c.lapStart); ev = 'lap'; }
  c.lapStart = time;
  if (done >= laps && c.finish == null) { c.finish = time; ev = 'finish'; }
  return ev;
}

/** Who is ahead: finished cars by time, the rest by progress. */
export function rank(cars) {
  return cars.slice().sort((a, b) => (b.finish != null ? 1e7 - b.finish : b.total) - (a.finish != null ? 1e7 - a.finish : a.total));
}

export function pointsFor(place, finished) {
  return (POINTS[place - 1] || 0) + (finished ? FINISH_BONUS : 0);
}

/** Highest speed a car can honestly reach (nitro, a bump from behind, rounding) in m/s. */
export function maxSpeed(spec) {
  return spec.top * NITRO_BOOST * 1.15 + 4;
}

const minLapCache = new Map();
/**
 * Fastest lap that is physically possible: the shortest line around the track driven at the highest speed of the
 * fastest car, without slowing for a single bend. Real laps are far slower; anything below this is a cheat.
 */
export function minLapTime(geo, cars) {
  if (minLapCache.has(geo.def.id)) return minLapCache.get(geo.def.id);
  const vmax = Math.max(...cars.map(maxSpeed));
  const t = shortestLap(geo) / vmax;
  minLapCache.set(geo.def.id, t);
  return t;
}

/**
 * Server-side referee for one car. Feed it every position the car reports; it keeps its own progress
 * (only continuous driving counts), checks the checkpoint order, the speed and the lap times.
 */
export class Referee {
  constructor(geo, spec, laps, minLap, grid) {
    this.geo = geo; this.spec = spec; this.laps = laps; this.minLap = minLap;
    this.vmax = maxSpeed(spec);
    this.idx = ((grid.idx % geo.M) + geo.M) % geo.M; this.total = grid.idx - geo.M;
    this.x = geo.px[this.idx]; this.z = geo.pz[this.idx];
    this.cp = Math.floor(this.total / (geo.M / CHECKPOINTS)); // last checkpoint passed (counts across laps)
    this.lapsDone = -1; this.lapStart = 0; this.lapTimes = []; this.finish = null;
    this.lastK = null; this.lastT = null;
    this.flags = new Set();
    this.window = []; // [car clock, total] for the 2 s distance check
  }
  get valid() { return this.flags.size === 0; }
  flag(why, info = '') { if (!this.flags.size) this.detail = why + (info ? ' ' + info : '') + ' @' + (this.lastK ?? 0).toFixed(2); this.flags.add(why); }

  /**
   * One reported position. now = server time in seconds since the start, k = the car's own race clock
   * (lap times use k, so network hiccups do not change them).
   * Returns 'lap' | 'finish' | null.
   */
  feed(x, z, k, now) {
    const g = this.geo;
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(k)) { this.flag('data'); return null; }
    if (this.finish != null) return null;
    // the car's clock may not run ahead of ours (plus network slack), and may not go back
    if (k > now + 2) this.flag('clock', `${k.toFixed(2)}>${now.toFixed(2)}`);
    if (this.lastK != null && k < this.lastK - 0.001) this.flag('clock');
    let idx = g.locate(x, z, this.idx, 40);
    const off = Math.abs(g.lateral(x, z, idx));
    let step = idx - this.idx; if (step > g.M / 2) step -= g.M; else if (step < -g.M / 2) step += g.M;
    if (off > 22) {
      // nowhere near where it was. A gap after a lost connection is fine if the car's clock explains the distance;
      // anything else is a jump and does not count as progress.
      idx = g.locate(x, z);
      step = idx - this.idx; if (step > g.M / 2) step -= g.M; else if (step < -g.M / 2) step += g.M;
      const dk = this.lastK != null ? k - this.lastK : 0;
      if (Math.abs(g.lateral(x, z, idx)) > 22) { this.flag('offtrack'); step = 0; }
      else if (!(step > 0 && step * g.ds <= this.vmax * dk + 6)) {
        step = 0;
        this.jumps = (this.jumps || 0) + 1;
        if (this.jumps > 3) this.flag('jump');
      }
    }
    // speed between two reports, by the car's own clock (along the track, so a reset to the centre is fine)
    if (this.lastK != null && step > 0) {
      const dk = Math.max(k - this.lastK, 1 / 60);
      if (step * g.ds > this.vmax * dk + 6) this.flag('speed', `${(step * g.ds).toFixed(1)}m/${dk.toFixed(3)}s`);
    }
    this.idx = idx; this.x = x; this.z = z; this.total += step; this.lastK = k; this.lastT = now;
    // distance over the last 2 s of the car's clock: many small steps just under the per-report slack add up here
    this.window.push([k, this.total]);
    while (this.window.length > 2 && k - this.window[0][0] > 2) this.window.shift();
    const [k0, p0] = this.window[0];
    if (k - k0 > 0.5 && (this.total - p0) * g.ds > this.vmax * (k - k0) + 12) this.flag('speed', `${((this.total - p0) * g.ds).toFixed(1)}m/${(k - k0).toFixed(2)}s`);
    // checkpoints strictly in order
    const cp = Math.floor(this.total / (g.M / CHECKPOINTS));
    if (cp > this.cp + 1) this.flag('checkpoint');
    if (cp > this.cp) this.cp = cp;
    // laps on the car's clock (it cannot run ahead of ours, and a slow clock shows up as too much speed above)
    const done = Math.floor(this.total / g.M);
    if (done <= this.lapsDone) return null;
    this.lapsDone = done;
    let ev = null;
    if (done >= 1) {
      const lt = k - this.lapStart;
      this.lapTimes.push(lt);
      if (lt < this.minLap) this.flag('laptime');
      ev = 'lap';
    }
    this.lapStart = k;
    if (done >= this.laps) {
      this.finish = k; ev = 'finish';
      if (k < this.minLap * this.laps) this.flag('laptime');
    }
    return ev;
  }
}
