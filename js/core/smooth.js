// Smoothing of other players' cars online (also used by the tests).
/** Smooth movement of another car from snapshots (server time in ms): draws it a little in the past and blends. */
export class Smoother {
  constructor() { this.buf = []; }
  push(t, x, z, h, v, total) {
    const b = this.buf;
    if (b.length && t <= b[b.length - 1].t) return;
    b.push({ t, x, z, h, v, total });
    if (b.length > 40) b.shift();
  }
  /** Position at time t (ms). Interpolates between snapshots, extrapolates up to 300 ms if they stop coming. */
  sample(t, out) {
    const b = this.buf;
    if (!b.length) return false;
    if (t <= b[0].t) { Object.assign(out, b[0]); return true; }
    for (let i = b.length - 1; i > 0; i--) {
      const a = b[i - 1], c = b[i];
      if (t >= a.t && t <= c.t) {
        const k = (t - a.t) / Math.max(1, c.t - a.t);
        out.x = a.x + (c.x - a.x) * k; out.z = a.z + (c.z - a.z) * k;
        let dh = c.h - a.h; while (dh > Math.PI) dh -= 2 * Math.PI; while (dh < -Math.PI) dh += 2 * Math.PI;
        out.h = a.h + dh * k; out.v = a.v + (c.v - a.v) * k; out.total = c.total;
        return true;
      }
    }
    const last = b[b.length - 1], dt = Math.min(t - last.t, 300) / 1000;
    out.x = last.x + Math.sin(last.h) * last.v * dt; out.z = last.z + Math.cos(last.h) * last.v * dt;
    out.h = last.h; out.v = last.v; out.total = last.total;
    return true;
  }
}
