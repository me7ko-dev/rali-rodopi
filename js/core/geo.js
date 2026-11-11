// Track geometry without three.js, so the same numbers run in the browser, in node tests and on the server.
// The spline is a port of three.js CatmullRomCurve3 (closed, centripetal) so tracks look exactly as before.

export const W = 7;          // half road width
export const KERB = 1.3;     // kerb width
export const RUN = 9;        // grass run-off before the wall
export const LIM = W + RUN - 1.2; // how far a car centre may go
export const SCALE = 1.3;    // track points are in "map units"; this turns them into metres

function catmull(pts) {
  const l = pts.length;
  const poly = (x0, x1, x2, x3, dt0, dt1, dt2) => {
    let t1 = (x1 - x0) / dt0 - (x2 - x0) / (dt0 + dt1) + (x2 - x1) / dt1;
    let t2 = (x2 - x1) / dt1 - (x3 - x1) / (dt1 + dt2) + (x3 - x2) / dt2;
    t1 *= dt1; t2 *= dt1;
    return [x1, t1, -3 * x1 + 3 * x2 - 2 * t1 - t2, 2 * x1 - 2 * x2 + t1 + t2];
  };
  const calc = (c, t) => c[0] + c[1] * t + c[2] * t * t + c[3] * t * t * t;
  return function point(t) {
    const p = l * t;
    let ip = Math.floor(p);
    const w = p - ip;
    ip += ip > 0 ? 0 : (Math.floor(Math.abs(ip) / l) + 1) * l;
    const p0 = pts[(ip - 1) % l], p1 = pts[ip % l], p2 = pts[(ip + 1) % l], p3 = pts[(ip + 2) % l];
    const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
    let dt0 = Math.pow(d2(p0, p1), 0.25), dt1 = Math.pow(d2(p1, p2), 0.25), dt2 = Math.pow(d2(p2, p3), 0.25);
    if (dt1 < 1e-4) dt1 = 1;
    if (dt0 < 1e-4) dt0 = dt1;
    if (dt2 < 1e-4) dt2 = dt1;
    return [calc(poly(p0[0], p1[0], p2[0], p3[0], dt0, dt1, dt2), w), calc(poly(p0[1], p1[1], p2[1], p3[1], dt0, dt1, dt2), w)];
  };
}

/** Evenly spaced samples (about every 2 m) along the closed spline. */
function spaced(pts, divisions = 4000) {
  const point = catmull(pts);
  const lens = [0];
  let last = point(0), sum = 0;
  for (let p = 1; p <= divisions; p++) {
    const cur = point(p / divisions);
    sum += Math.hypot(cur[0] - last[0], cur[1] - last[1]);
    lens.push(sum); last = cur;
  }
  const il = lens.length, length = sum;
  const at = u => {
    const target = u * length;
    let low = 0, high = il - 1, i = 0;
    while (low <= high) {
      i = Math.floor(low + (high - low) / 2);
      const c = lens[i] - target;
      if (c < 0) low = i + 1; else if (c > 0) high = i - 1; else { high = i; break; }
    }
    i = high;
    if (lens[i] === target) return point(i / (il - 1));
    const before = lens[i], after = lens[i + 1];
    return point((i + (target - before) / (after - before)) / (il - 1));
  };
  return { length, at };
}

const cache = new Map();

/** All the numbers the game needs about a track: samples, tangents, normals, curvature, and lookups. */
export function trackGeometry(def) {
  if (cache.has(def.id)) return cache.get(def.id);
  const { length, at } = spaced(def.pts.map(([x, z]) => [x * SCALE, z * SCALE]));
  const M = Math.round(length / 2);
  const ds = length / M;
  const px = new Float32Array(M), pz = new Float32Array(M), tx = new Float32Array(M), tz = new Float32Array(M);
  const nx = new Float32Array(M), nz = new Float32Array(M), curv = new Float32Array(M);
  const box = { minX: 1e9, maxX: -1e9, minZ: 1e9, maxZ: -1e9 };
  for (let i = 0; i < M; i++) {
    const p = at(i / M);
    px[i] = p[0]; pz[i] = p[1];
    box.minX = Math.min(box.minX, px[i]); box.maxX = Math.max(box.maxX, px[i]);
    box.minZ = Math.min(box.minZ, pz[i]); box.maxZ = Math.max(box.maxZ, pz[i]);
  }
  for (let i = 0; i < M; i++) {
    const a = (i - 1 + M) % M, b = (i + 1) % M;
    const dx = px[b] - px[a], dz = pz[b] - pz[a], l = Math.hypot(dx, dz) || 1;
    tx[i] = dx / l; tz[i] = dz / l; nx[i] = -tz[i]; nz[i] = tx[i];
  }
  const raw = new Float32Array(M);
  for (let i = 0; i < M; i++) {
    const a = (i - 3 + M) % M, b = (i + 3) % M;
    const cross = tx[a] * tz[b] - tz[a] * tx[b], dot = tx[a] * tx[b] + tz[a] * tz[b];
    raw[i] = Math.abs(Math.atan2(cross, dot)) / (6 * ds);
  }
  for (let i = 0; i < M; i++) { let s = 0; for (let k = -4; k <= 4; k++) s += raw[(i + k + M) % M]; curv[i] = s / 9; }

  /** Nearest sample. With a hint it only looks 60 m around it (fast, and keeps lap counting continuous). */
  function locate(x, z, hint, span = 30) {
    let best = 0, bd = 1e18;
    if (hint === undefined || hint < 0) {
      for (let i = 0; i < M; i++) { const d = (x - px[i]) ** 2 + (z - pz[i]) ** 2; if (d < bd) { bd = d; best = i; } }
    } else {
      for (let k = -span; k <= span; k++) { const i = (hint + k + M) % M; const d = (x - px[i]) ** 2 + (z - pz[i]) ** 2; if (d < bd) { bd = d; best = i; } }
    }
    return best;
  }
  const lateral = (x, z, i) => (x - px[i]) * nx[i] + (z - pz[i]) * nz[i];
  /** Distance from any point to the centre line (coarse, for scenery placement). */
  function distance(x, z) {
    let bd = 1e18;
    for (let i = 0; i < M; i += 3) { const d = (x - px[i]) ** 2 + (z - pz[i]) ** 2; if (d < bd) bd = d; }
    return Math.sqrt(bd);
  }
  const geo = { def, grip: def.grip || 1, M, ds, length, px, pz, tx, tz, nx, nz, curv, box, locate, lateral, distance };
  cache.set(def.id, geo);
  return geo;
}

/**
 * Length of the shortest line a car centre can drive around the track (it may cut every bend up to LIM).
 * Used for the "fastest possible lap" check: nobody can beat this distance at top speed.
 */
export function shortestLap(geo, iters = 400) {
  const { M, px, pz, nx, nz } = geo;
  const off = new Float64Array(M);
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < M; i++) {
      const a = (i - 1 + M) % M, b = (i + 1) % M;
      const mx = (px[a] + nx[a] * off[a] + px[b] + nx[b] * off[b]) / 2;
      const mz = (pz[a] + nz[a] * off[a] + pz[b] + nz[b] * off[b]) / 2;
      const o = (mx - px[i]) * nx[i] + (mz - pz[i]) * nz[i];
      off[i] = Math.max(-LIM, Math.min(LIM, o));
    }
  }
  let len = 0;
  for (let i = 0; i < M; i++) {
    const b = (i + 1) % M;
    len += Math.hypot(px[b] + nx[b] * off[b] - px[i] - nx[i] * off[i], pz[b] + nz[b] * off[b] - pz[i] - nz[i] * off[i]);
  }
  return len;
}
