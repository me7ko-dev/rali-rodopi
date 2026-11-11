// Car physics and the simple AI driver, without three.js (runs in the browser, in tests and on the server).
import { W, KERB, LIM } from './geo.js';

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const wrap = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
export const WHEEL_R = 0.3 * 1.7;
export const NITRO_BOOST = 1.2; // top speed multiplier while boosting

export class CarBody {
  constructor(spec, name) {
    this.spec = spec; this.name = name;
    this.x = 0; this.z = 0; this.heading = 0; this.vx = 0; this.vz = 0;
    this.vf = 0; this.vl = 0; this.steer = 0; this.spin = 0; this.yawRate = 0;
    this.idx = 0; this.total = 0; this.d = 0; this.onRoad = true; this.hit = 0;
    this.nitro = 0.5; this.boosting = false; this.finish = null; this.lapTimes = []; this.lapStart = 0; this.lapsDone = -1;
    // AI personality
    this.skill = 1; this.lane = 0; this.baseLane = 0; this.laneGoal = 0; this.band = 1;
  }

  place(track, idx, lateral) {
    idx = ((idx % track.M) + track.M) % track.M;
    this.x = track.px[idx] + track.nx[idx] * lateral; this.z = track.pz[idx] + track.nz[idx] * lateral;
    this.heading = Math.atan2(track.tx[idx], track.tz[idx]);
    this.vx = this.vz = this.vf = this.vl = this.steer = this.yawRate = 0;
    this.idx = idx; this.d = lateral; this.sync();
  }

  /** inp: { throttle 0..1, brake 0..1, steer -1..1 (left positive), hand bool, nitro bool } */
  update(dt, inp, track) {
    const s = this.spec;
    this.onRoad = Math.abs(this.d) <= W + KERB;
    this.boosting = !!inp.nitro && this.nitro > 0.02 && inp.throttle > 0;
    const top = s.top * this.band * (this.onRoad ? 1 : 0.55 + (s.grip - 1) * 0.4) * (this.boosting ? NITRO_BOOST : 1);

    // steering eases toward the input
    this.steer += clamp(inp.steer - this.steer, -dt * 5, dt * 5);
    const speedK = clamp(Math.abs(this.vf) / 7, 0, 1) * Math.sign(this.vf || 1);
    this.yawRate = this.steer * (2.3 - 1.25 * clamp(Math.abs(this.vf) / s.top, 0, 1)) * speedK * (inp.hand ? 1.45 : 1);
    this.heading = wrap(this.heading + this.yawRate * dt);

    const fx = Math.sin(this.heading), fz = Math.cos(this.heading), lx = fz, lz = -fx;
    let vf = this.vx * fx + this.vz * fz, vl = this.vx * lx + this.vz * lz;

    if (inp.throttle > 0) {
      if (vf < top) vf += s.acc * (this.boosting ? 1.7 : 1) * inp.throttle * (1 - Math.pow(clamp(vf / top, 0, 1), 2) * 0.85) * dt;
    }
    if (vf > top) vf -= (vf - top) * 1.8 * dt;
    if (inp.brake > 0) vf -= (vf > 0.5 ? 46 : 14) * inp.brake * dt;
    vf = Math.max(vf, -13);
    vf -= vf * (0.1 + (this.onRoad ? 0 : 0.55) + (inp.hand ? 0.45 : 0)) * dt;
    if (!inp.throttle && !inp.brake && Math.abs(vf) < 0.4) vf = 0;

    const grip = (inp.hand ? 1.7 : 7.2 * s.grip) * (this.onRoad ? 1 : 0.65) * (track.grip || 1);
    vf -= Math.sign(vf) * Math.min(Math.abs(vf), Math.abs(vl) * 0.22 * dt);
    vl *= Math.exp(-grip * dt);

    // nitro: drains while used, refills by sliding on tarmac
    if (this.boosting) this.nitro = Math.max(0, this.nitro - 0.3 * dt);
    else this.nitro = Math.min(1, this.nitro + (0.035 + (this.onRoad && Math.abs(vl) > 5 ? 0.3 : 0)) * dt);

    this.vx = fx * vf + lx * vl; this.vz = fz * vf + lz * vl;
    this.x += this.vx * dt; this.z += this.vz * dt;

    // where are we on the track
    this.track(track);

    // wall
    if (Math.abs(this.d) > LIM) {
      const sgn = Math.sign(this.d), nxx = track.nx[this.idx] * sgn, nzz = track.nz[this.idx] * sgn;
      const over = Math.abs(this.d) - LIM;
      this.x -= nxx * over; this.z -= nzz * over; this.d = sgn * LIM;
      const vn = this.vx * nxx + this.vz * nzz;
      if (vn > 0) {
        this.vx -= nxx * vn * 1.3; this.vz -= nzz * vn * 1.3;
        if (vn > 2) { const k = 1 - clamp(vn / 70, 0, 0.25); this.vx *= k; this.vz *= k; this.hit = vn; }
      }
      // the wall turns the nose back along the track so you never get pinned
      const along = fx * track.tx[this.idx] + fz * track.tz[this.idx] >= 0 ? 1 : -1;
      const want = Math.atan2(track.tx[this.idx] * along, track.tz[this.idx] * along);
      this.heading = wrap(this.heading + wrap(want - this.heading) * Math.min(1, dt * 4));
    }
    this.vf = this.vx * fx + this.vz * fz; this.vl = this.vx * lx + this.vz * lz;
    this.spin += this.vf * dt / WHEEL_R;
    this.sync(dt, inp);
  }

  /** Follow the car along the track: nearest sample, progress (in samples, can go negative) and side offset. */
  track(track) {
    const prev = this.idx;
    this.idx = track.locate(this.x, this.z, prev);
    let step = this.idx - prev; if (step > track.M / 2) step -= track.M; else if (step < -track.M / 2) step += track.M;
    this.total += step;
    this.d = track.lateral(this.x, this.z, this.idx);
  }

  /** Visual cars override this to move their 3D model. */
  sync() {}

  /** Simple driver: aim at a point ahead on the racing lane, slow down for bends. */
  drive(track, others) {
    const M = track.M, v = Math.max(this.vf, 0);
    // avoid the car right in front
    this.laneGoal = this.baseLane;
    for (const o of others) {
      if (o === this) continue;
      const gap = o.total - this.total; if (gap < 0 || gap > 9) continue;
      if (Math.abs(o.d - this.d) < 2.6) { this.laneGoal = o.d > this.d ? o.d - 3.6 : o.d + 3.6; break; }
    }
    this.laneGoal = clamp(this.laneGoal, -W + 1.6, W - 1.6);
    this.lane += clamp(this.laneGoal - this.lane, -0.06, 0.06);

    const look = (this.idx + 5 + Math.round(v * 0.32)) % M;
    const txx = track.px[look] + track.nx[look] * this.lane, tzz = track.pz[look] + track.nz[look] * this.lane;
    const ang = wrap(Math.atan2(txx - this.x, tzz - this.z) - this.heading);
    let maxC = 0.0005; const span = 8 + Math.round(v * 0.75);
    for (let k = 0; k < span; k += 2) maxC = Math.max(maxC, track.curv[(this.idx + k) % M]);
    const safe = Math.sqrt(31 * this.skill * this.spec.grip * (track.grip || 1) / maxC);
    return { steer: clamp(ang * 2.4, -1, 1), throttle: v < safe ? 1 : 0, brake: v > safe * 1.1 ? 1 : 0, hand: false, nitro: false };
  }
}

/** Push overlapping cars apart and trade some speed. Cars with `ghost` set never move (remote cars online). */
export function collide(cars) {
  const R = 1.55;
  for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) {
    const a = cars[i], b = cars[j];
    if (a.ghost && b.ghost) continue;
    let dx = b.x - a.x, dz = b.z - a.z; const d = Math.hypot(dx, dz);
    if (d >= 2 * R || d < 1e-4) continue;
    dx /= d; dz /= d;
    const wa = a.ghost ? 0 : b.ghost ? 1 : 0.5, wb = b.ghost ? 0 : a.ghost ? 1 : 0.5;
    const push = 2 * R - d;
    a.x -= dx * push * wa; a.z -= dz * push * wa; b.x += dx * push * wb; b.z += dz * push * wb;
    const rel = (b.vx - a.vx) * dx + (b.vz - a.vz) * dz;
    if (rel < 0) {
      const imp = -rel * 0.65;
      if (!a.ghost) { a.vx -= dx * imp; a.vz -= dz * imp; }
      if (!b.ghost) { b.vx += dx * imp; b.vz += dz * imp; }
      a.hit = b.hit = -rel;
    }
  }
}
