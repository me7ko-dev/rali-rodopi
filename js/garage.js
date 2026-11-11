// Garage looks on a 3D car: paint, number plate + race numbers, spoiler, nitro flame and trail.
// Visual only: nothing here touches the physics. The catalog and the rules live in core/looks.js.
//
//   applyLook(car, look)     after a Car is created, and again whenever the look changes (idempotent)
//   update(dt, cars)         once per frame: nitro flames and trails for every car that has car.look
//   disposeLook(car)         when a car is thrown away (frees its own geometry, materials and trail)
import * as THREE from 'three';
import { LOOKS, item, cleanLook } from './core/looks.js';

/* ---------- paint ---------- */
// Kenney cars are one mesh textured from a 512x512 palette (8 colour cells x 4 rows, each cell = a flat half and a
// vertical-gradient half). The paint is one coloured cell per model; glass, trim and lights use other cells.
// We clone the car's geometry, move the paint triangles' UVs to the white cell and colour them with vertex colours,
// so the original gradient shading stays and nothing else on the car (or any other car) changes.
const COLS = 16, ROWS = 4; // half-cells across, rows down
const PAINT_CELLS = { // [half-column, row] of the paint, per model (found by triangle area on each body mesh)
  'sedan-sports': [[12, 1], [13, 1]], race: [[12, 1], [13, 1]], 'hatchback-sports': [[6, 1], [7, 1]],
  'race-future': [[14, 1], [15, 1]], 'suv-luxury': [[8, 1], [9, 1]], taxi: [[8, 1], [9, 1]], police: [[6, 2], [7, 2]] // police: the dark body, the white doors stay
};
const STOCK_COLOR = { // the factory paint, used for parts (spoilers) on a car that keeps its stock colour
  'sedan-sports': '#e05a48', race: '#e05a48', 'hatchback-sports': '#3fae7a', 'race-future': '#5f7fd0',
  'suv-luxury': '#ffbe4a', taxi: '#ffbe4a', police: '#4a4e5e'
};
const WHITE_FLAT = 12.5 / COLS, WHITE_GRAD = 13.5 / COLS, WHITE_ROW = 2; // the white cell (#fff flat, #fafafc..#bebed6 gradient)
const isWheel = o => /^wheel/.test(o.name);
const isStockSpoiler = o => o.name === 'spoiler';

let envTex = null; // a tiny sky/ground gradient so metallic paints have something to reflect
function metalEnv() {
  if (envTex || typeof document === 'undefined') return envTex;
  const c = document.createElement('canvas'); c.width = 128; c.height = 64;
  const g = c.getContext('2d'), gr = g.createLinearGradient(0, 0, 0, 64);
  gr.addColorStop(0, '#6f9fdc'); gr.addColorStop(0.45, '#dfe9f4'); gr.addColorStop(0.5, '#f6f2e8'); gr.addColorStop(0.53, '#6d6a5e'); gr.addColorStop(1, '#2b2c2a');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 64);
  envTex = new THREE.CanvasTexture(c); envTex.mapping = THREE.EquirectangularReflectionMapping; envTex.colorSpace = THREE.SRGBColorSpace;
  return envTex;
}

/** Which body triangles are paint? Picks the model's table entry, or for an unknown model the biggest coloured cell. */
function paintCells(id, meshes) {
  if (PAINT_CELLS[id]) return new Set(PAINT_CELLS[id].map(([c, r]) => c + r * COLS));
  const area = new Map(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (const m of meshes) forTriangles(m.geometry, (i, j, k, cell) => {
    const p = m.geometry.attributes.position;
    a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, j); c.fromBufferAttribute(p, k);
    const s = b.sub(a).cross(c.sub(a)).length() / 2;
    if (Math.floor(cell / COLS) !== 2) area.set(cell, (area.get(cell) || 0) + s); // row 2 is greys and white trim
  });
  let best = -1, bestA = 0;
  for (const [cell, s] of area) if (s > bestA) { best = cell; bestA = s; }
  if (best < 0) return new Set();
  const col = best % COLS, row = Math.floor(best / COLS), pair = col - (col % 2);
  return new Set([pair + row * COLS, pair + 1 + row * COLS]);
}
function forTriangles(geo, fn) {
  const uv = geo.attributes.uv, idx = geo.index, n = idx ? idx.count : geo.attributes.position.count;
  for (let t = 0; t + 2 < n; t += 3) {
    const i = idx ? idx.getX(t) : t, j = idx ? idx.getX(t + 1) : t + 1, k = idx ? idx.getX(t + 2) : t + 2;
    const u = (uv.getX(i) + uv.getX(j) + uv.getX(k)) / 3, v = (uv.getY(i) + uv.getY(j) + uv.getY(k)) / 3;
    const cell = Math.min(COLS - 1, Math.max(0, Math.floor(u * COLS))) + Math.min(ROWS - 1, Math.max(0, Math.floor(v * ROWS))) * COLS;
    fn(i, j, k, cell);
  }
}
/** Clone a body geometry: paint vertices get a white UV and a colour attribute; returns the clone + which vertices are paint. */
function paintableGeometry(geo, cells) {
  const g = geo.clone(), uv = g.attributes.uv, n = uv.count;
  const paint = new Uint8Array(n);
  forTriangles(g, (i, j, k, cell) => { if (cells.has(cell)) paint[i] = paint[j] = paint[k] = 1; });
  for (let i = 0; i < n; i++) {
    if (!paint[i]) continue;
    const u = uv.getX(i), v = uv.getY(i), half = Math.floor(u * COLS), row = Math.floor(v * ROWS);
    const vRel = Math.min(0.96, Math.max(0.04, v * ROWS - row)); // keep the gradient's place, away from the cell edges
    uv.setXY(i, half % 2 ? WHITE_GRAD : WHITE_FLAT, half % 2 ? (WHITE_ROW + vRel) / ROWS : (WHITE_ROW + 0.5) / ROWS);
  }
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  return { geo: g, paint };
}

function setPaint(car, st, paintItem) {
  const meshes = [];
  car.model.traverse(o => { if (o.isMesh && !isWheel(o) && !o.userData.garage) meshes.push(o); });
  if (!paintItem.color) { // stock: give back the shared originals
    for (const p of st.paint) { p.mesh.geometry = p.g0; p.mesh.material = p.m0; p.geo.dispose(); p.mat.dispose(); }
    st.paint = [];
    return;
  }
  if (!st.paint.length) {
    const cells = paintCells(car.spec && car.spec.id, meshes);
    for (const mesh of meshes) {
      const { geo, paint } = paintableGeometry(mesh.geometry, cells);
      if (!paint.some(Boolean)) { geo.dispose(); continue; }
      const m0 = mesh.material, mat = m0.clone(); mat.vertexColors = true;
      st.paint.push({ mesh, g0: mesh.geometry, m0, geo, mat, flags: paint });
      mesh.geometry = geo; mesh.material = mat;
    }
  }
  const col = new THREE.Color(paintItem.color);
  for (const p of st.paint) {
    const a = p.geo.attributes.color;
    for (let i = 0; i < p.flags.length; i++) if (p.flags[i]) a.setXYZ(i, col.r, col.g, col.b);
    a.needsUpdate = true;
    const metal = !!paintItem.metal;
    p.mat.metalness = metal ? 0.75 : p.m0.metalness; p.mat.roughness = metal ? 0.26 : p.m0.roughness;
    p.mat.envMap = metal ? metalEnv() : p.m0.envMap; p.mat.envMapIntensity = 1.1;
    p.mat.needsUpdate = true;
  }
}

/* ---------- measuring a model (once per model id) ---------- */
const fits = new Map();
const ray = new THREE.Raycaster();
/** Where things go on this model, in car.body space: size, rear plate spot, door spots, roof spot, spoiler mount, exhaust. */
function fitFor(car) {
  const id = car.spec && car.spec.id;
  if (id && fits.has(id)) return fits.get(id);
  car.obj.updateWorldMatrix(true, true);
  const toLocal = new THREE.Matrix4().copy(car.body.matrixWorld).invert(), toWorld = car.body.matrixWorld;
  const meshes = [];
  car.model.traverse(o => { if (o.isMesh && !isWheel(o) && !isStockSpoiler(o) && !o.userData.garage) meshes.push(o); });
  const box = new THREE.Box3(), tmpBox = new THREE.Box3(), m = new THREE.Matrix4();
  for (const o of meshes) {
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    box.union(tmpBox.copy(o.geometry.boundingBox).applyMatrix4(m.multiplyMatrices(toLocal, o.matrixWorld)));
  }
  const size = box.getSize(new THREE.Vector3());
  const nrm = new THREE.Matrix3();
  /** Cast a ray in body space; returns { p, n } (point and normal in body space) or null. */
  const cast = (ox, oy, oz, dx, dy, dz) => {
    const o = new THREE.Vector3(ox, oy, oz).applyMatrix4(toWorld), d = new THREE.Vector3(dx, dy, dz).transformDirection(toWorld);
    ray.set(o, d); ray.far = 100;
    const hit = ray.intersectObjects(meshes, false)[0];
    if (!hit) return null;
    nrm.getNormalMatrix(m.multiplyMatrices(toLocal, hit.object.matrixWorld));
    return { p: hit.point.applyMatrix4(toLocal), n: hit.face ? hit.face.normal.clone().applyMatrix3(nrm).normalize() : new THREE.Vector3() };
  };
  const { min, max } = box, W = size.x, H = size.y, L = size.z, cz = (min.z + max.z) / 2;

  // rear plate: the most upright spot on the back between 22% and 55% of the height
  let plate = null;
  for (let f = 0.22; f <= 0.56; f += 0.04) {
    const h = cast(0, min.y + H * f, min.z - 2, 0, 0, 1);
    if (h && (!plate || h.n.z < plate.n.z - 0.02)) plate = { ...h, f };
  }
  if (!plate) plate = { p: new THREE.Vector3(0, min.y + H * 0.35, min.z), n: new THREE.Vector3(0, 0, -1) };

  // doors: the widest upright spot on the side, between the wheels, at 25%..60% of the height
  let door = null;
  for (let f = 0.25; f <= 0.6; f += 0.035) {
    const h = cast(max.x + 2, min.y + H * f, cz, -1, 0, 0);
    if (h && h.n.x > 0.8 && (!door || h.p.x > door.p.x + 0.005)) door = h;
  }

  // roof: a flat spot along the centre line (skips taxi signs and police lights)
  let roof = null;
  for (const t of [0, -0.08, -0.16, 0.08, -0.24]) {
    const z = cz + t * L, hs = [0, -0.2, 0.2].map(x => cast(x * W, max.y + 2, z, 0, -1, 0));
    if (hs.some(h => !h)) continue;
    const ys = hs.map(h => h.p.y);
    if (Math.max(...ys) - Math.min(...ys) < 0.06 && ys[0] > min.y + H * 0.62 && hs[0].n.y > 0.9) { roof = hs[0]; break; }
  }

  // spoiler mount: the highest point over the last 16% of the car (trunk lid, or the roof edge on a hatchback)
  let mount = null;
  for (let f = 0.035; f <= 0.17; f += 0.0225) {
    const h = cast(0, max.y + 2, min.z + L * f, 0, -1, 0);
    if (h && (!mount || h.p.y > mount.p.y + 0.01)) mount = h;
  }
  if (!mount) mount = { p: new THREE.Vector3(0, min.y + H * 0.6, min.z + L * 0.08) };
  // how wide the body is at the mount height (so the wing spans the car, not the mirrors)
  const side = cast(max.x + 2, mount.p.y - 0.08, mount.p.z + 0.1, -1, 0, 0);
  const mountW = side ? Math.min(W, side.p.x * 2) : W * 0.85;

  // exhaust: low at the back
  const ex = cast(W * 0.25, min.y + H * 0.16, min.z - 2, 0, 0, 1);
  const exhaust = new THREE.Vector3(W * 0.25, min.y + H * 0.16, ex ? ex.p.z : min.z);

  const mountHigh = mount.p.y > min.y + H * 0.72; // a roof-edge mount (hatchback, SUV): shorter struts

  const fit = { box, W, H, L, plate, door, roof, mount, mountW, mountHigh, exhaust };
  if (id) fits.set(id, fit);
  return fit;
}

/* ---------- number plate and race numbers ---------- */
const PLATE_STYLE = {
  white: { bg: '#f6f2e8', fg: '#14161b', edge: '#14161b' },
  kerb: { bg: '#e23b2e', fg: '#f6f2e8', edge: '#f6f2e8' },
  amber: { bg: '#ffb627', fg: '#14161b', edge: '#14161b' },
  gold: { bg: ['#f7dd7a', '#c9a227', '#9c7a14'], fg: '#2a1d05', edge: '#5a440a', metal: true }
};
const textures = new Map(); // `${kind}:${style}:${num}` -> CanvasTexture, shared by every car
let fontReady = typeof document === 'undefined' || !document.fonts || document.fonts.check('64px "Russo One"');
if (!fontReady) document.fonts.load('64px "Russo One"').then(() => { fontReady = true; for (const [k, t] of textures) { drawDecal(t.image, ...k.split(':')); t.needsUpdate = true; } }).catch(() => {});

function fill(g, style, x0, y0, x1, y1) {
  if (Array.isArray(style.bg)) { const gr = g.createLinearGradient(x0, y0, x1, y1); style.bg.forEach((c, i) => gr.addColorStop(i / (style.bg.length - 1), c)); return gr; }
  return style.bg;
}
function drawDecal(c, kind, styleId, num) {
  const g = c.getContext('2d'), s = PLATE_STYLE[styleId], txt = String(num).padStart(2, '0'), font = '"Russo One", "Arial Black", Impact, sans-serif';
  g.clearRect(0, 0, c.width, c.height);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  if (kind === 'plate') { // 256x96 rear plate: a kerb-red band with "РР", then the number
    const r = 10;
    g.fillStyle = s.edge; g.beginPath(); g.roundRect(0, 0, 256, 96, r + 4); g.fill();
    g.fillStyle = fill(g, s, 0, 0, 0, 96); g.beginPath(); g.roundRect(6, 6, 244, 84, r); g.fill();
    g.fillStyle = styleId === 'kerb' ? '#14161b' : '#e23b2e'; g.beginPath(); g.roundRect(6, 6, 52, 84, [r, 0, 0, r]); g.fill();
    g.fillStyle = '#f6f2e8'; g.font = `30px ${font}`; g.fillText('РР', 32, 50);
    g.fillStyle = s.fg; g.font = `76px ${font}`; g.fillText(txt, 156, 52);
  } else { // 128x128 race roundel for doors and roof
    g.fillStyle = s.edge; g.beginPath(); g.arc(64, 64, 63, 0, Math.PI * 2); g.fill();
    g.fillStyle = fill(g, s, 0, 0, 128, 128); g.beginPath(); g.arc(64, 64, 56, 0, Math.PI * 2); g.fill();
    g.fillStyle = s.fg; g.font = `70px ${font}`; g.fillText(txt, 64, 69);
  }
}
function decalTexture(kind, styleId, num) {
  const key = `${kind}:${styleId}:${num}`;
  let t = textures.get(key);
  if (!t) {
    const c = document.createElement('canvas'); c.width = kind === 'plate' ? 256 : 128; c.height = kind === 'plate' ? 96 : 128;
    drawDecal(c, kind, styleId, num);
    t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    textures.set(key, t);
  }
  return t;
}
const decalMats = new Map(); // texture key -> material
function decalMaterial(kind, styleId, num) {
  const key = `${kind}:${styleId}:${num}`;
  let m = decalMats.get(key);
  if (!m) {
    const metal = !!PLATE_STYLE[styleId].metal;
    m = new THREE.MeshStandardMaterial({ map: decalTexture(kind, styleId, num), alphaTest: 0.5, roughness: metal ? 0.3 : 0.55, metalness: metal ? 0.6 : 0,
      envMap: metal ? metalEnv() : null, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    decalMats.set(key, m);
  }
  return m;
}
const planeGeo = new THREE.PlaneGeometry(1, 1);

function buildNumbers(fit, plateId, num) {
  const grp = new THREE.Group(); grp.name = 'garage-numbers'; grp.userData.garage = true;
  const put = (kind, w, h, spot, lift = 0.012) => {
    const m = new THREE.Mesh(planeGeo, decalMaterial(kind, plateId, num));
    m.scale.set(w, h, 1); m.userData.garage = true;
    m.position.copy(spot.p).addScaledVector(spot.n, lift);
    m.lookAt(m.position.clone().add(spot.n)); // planes face +z; turn them to face out of the surface
    grp.add(m); return m;
  };
  const pw = Math.min(0.78, fit.W * 0.36);
  put('plate', pw, pw * 96 / 256, fit.plate);
  if (fit.door) {
    const d = Math.min(0.62, fit.H * 0.3);
    put('round', d, d, fit.door);
    put('round', d, d, { p: fit.door.p.clone().setX(-fit.door.p.x), n: fit.door.n.clone().setX(-fit.door.n.x) });
  }
  if (fit.roof) { const d = Math.min(0.9, fit.W * 0.42); put('round', d, d, fit.roof).rotation.set(-Math.PI / 2, 0, Math.PI); } // lying flat, top of the digits forward: reads from the chase camera
  return grp;
}

/* ---------- spoilers ---------- */
const boxGeo = new THREE.BoxGeometry(1, 1, 1);
const partMats = new Map();
function partMaterial(hex, metal) {
  const key = hex + (metal ? 'm' : '');
  let m = partMats.get(key);
  if (!m) { m = new THREE.MeshStandardMaterial({ color: hex, roughness: metal ? 0.26 : 0.5, metalness: metal ? 0.75 : 0, envMap: metal ? metalEnv() : null }); partMats.set(key, m); }
  return m;
}
const carbon = () => partMaterial('#1c1e24', false);

function buildSpoiler(fit, kind, hex, metal) {
  const grp = new THREE.Group(); grp.name = 'garage-spoiler'; grp.userData.garage = true;
  const { p } = fit.mount, w = fit.mountW, body = partMaterial(hex, metal), dark = carbon();
  const add = (mat, sx, sy, sz, x, y, z, rx = 0) => {
    const m = new THREE.Mesh(boxGeo, mat); m.scale.set(sx, sy, sz); m.position.set(x, y, z); m.rotation.x = rx;
    m.castShadow = true; m.userData.garage = true; grp.add(m); return m;
  };
  if (kind === 'lip') { // a small ducktail on the edge of the lid
    add(body, w * 0.82, 0.07, 0.24, 0, 0.03, 0.02, -0.32);
  } else if (kind === 'gt') { // a plank on two struts, with small end plates
    const hgt = fit.mountHigh ? 0.14 : 0.3, y = hgt + 0.02, d = 0.34;
    add(dark, 0.06, hgt + 0.08, 0.13, -w * 0.3, hgt / 2 - 0.04, 0.04);
    add(dark, 0.06, hgt + 0.08, 0.13, w * 0.3, hgt / 2 - 0.04, 0.04);
    add(body, w * 0.94, 0.05, d, 0, y, 0, 0.12);
    add(dark, 0.035, 0.16, d + 0.06, -w * 0.47, y + 0.03, 0);
    add(dark, 0.035, 0.16, d + 0.06, w * 0.47, y + 0.03, 0);
  } else if (kind === 'wing') { // tall two-element rally wing, a touch wider than the car
    const hgt = fit.mountHigh ? 0.26 : 0.56, y = hgt + 0.03, d = 0.46, ww = Math.min(fit.W * 1.04, w * 1.12);
    add(dark, 0.08, hgt + 0.1, 0.18, -ww * 0.28, hgt / 2 - 0.05, 0.05);
    add(dark, 0.08, hgt + 0.1, 0.18, ww * 0.28, hgt / 2 - 0.05, 0.05);
    add(body, ww, 0.06, d, 0, y, 0, 0.1);
    add(body, ww * 0.96, 0.04, d * 0.4, 0, y + 0.1, -d * 0.36, -0.35);
    add(dark, 0.045, 0.3, d + 0.12, -ww / 2, y + 0.05, -0.02);
    add(dark, 0.045, 0.3, d + 0.12, ww / 2, y + 0.05, -0.02);
  }
  grp.position.set(0, p.y, p.z);
  return grp;
}

/* ---------- applyLook ---------- */
const stateOf = car => car._garage || (car._garage = { look: null, paint: [], numbers: null, spoiler: null });
function drop(obj) { if (obj) obj.removeFromParent(); return null; }

/**
 * Dress a car in a look. Safe to call any number of times; only what changed is rebuilt.
 * Unknown ids fall back to the defaults (lock checks are the caller's job: pass cleanLook(look, points)).
 * Sets car.look, which update() uses for the nitro trail colour.
 */
export function applyLook(car, look) {
  if (!car || !car.model || !car.body) return;
  const L = cleanLook(look), st = stateOf(car), old = st.look || {};
  const fit = fitFor(car);
  const paint = item('paint', L.paint);
  if (L.paint !== old.paint) setPaint(car, st, paint);
  if (L.plate !== old.plate || L.num !== old.num) {
    st.numbers = drop(st.numbers);
    if (L.plate !== 'none') car.body.add(st.numbers = buildNumbers(fit, L.plate, L.num));
  }
  if (L.spoiler !== old.spoiler || L.paint !== old.paint) {
    st.spoiler = drop(st.spoiler);
    car.model.traverse(o => { if (isStockSpoiler(o)) o.visible = L.spoiler === 'none'; });
    if (L.spoiler !== 'none') {
      const hex = paint.color || STOCK_COLOR[car.spec && car.spec.id] || '#d8d8d8';
      car.body.add(st.spoiler = buildSpoiler(fit, L.spoiler, hex, !!paint.metal));
    }
  }
  st.look = L; car.look = L;
}

/** Undo everything applyLook did and free the car's own resources (shared textures and materials stay cached). */
export function disposeLook(car) {
  if (!car || !car._garage) return;
  const st = car._garage;
  setPaint(car, st, { color: null });
  st.numbers = drop(st.numbers); st.spoiler = drop(st.spoiler);
  car.model.traverse(o => { if (isStockSpoiler(o)) o.visible = true; });
  const tr = trails.get(car); if (tr) tr.dispose();
  car._garage = null; car.look = null;
}

/* ---------- nitro flame + trail ---------- */
const N = 72; // particles per car
const trailMat = new THREE.ShaderMaterial({
  uniforms: { uScale: { value: 400 }, uSize: { value: 1.05 } },
  vertexShader: `
    attribute vec3 aColor; attribute float aLife;
    uniform float uScale, uSize;
    varying vec3 vC; varying float vL;
    void main() {
      vL = aLife; vC = mix(aColor, vec3(1.0), clamp((aLife - 0.75) * 3.0, 0.0, 0.7));
      if (aLife <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mv;
      gl_PointSize = uSize * (0.35 + aLife) * uScale / max(0.5, -mv.z);
    }`,
  fragmentShader: `
    varying vec3 vC; varying float vL;
    void main() {
      vec2 d = gl_PointCoord - 0.5; float r = dot(d, d) * 4.0;
      if (r > 1.0) discard;
      float a = (1.0 - r) * vL;
      gl_FragColor = vec4(vC * a * 1.4, a);
    }`,
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
});
const flameGeo = new THREE.ConeGeometry(0.13, 1, 10, 1, true).rotateX(-Math.PI / 2).translate(0, 0, -0.5); // tip along -z
const coreGeo = new THREE.ConeGeometry(0.065, 1, 8, 1, true).rotateX(-Math.PI / 2).translate(0, 0, -0.5);
const coreMat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
const bufSize = new THREE.Vector2();
const tmpCol = new THREE.Color();

/** Nitro flame from the exhaust and a short glowing trail behind the car while car.boosting is true. */
export class NitroTrail {
  constructor(car) {
    this.car = car;
    const fit = fitFor(car);
    this.ex = fit.exhaust.clone(); // body space (right pipe; the left one is mirrored)
    this.pos = new Float32Array(N * 3); this.col = new Float32Array(N * 3); this.life = new Float32Array(N);
    this.vel = new Float32Array(N * 3); this.max = new Float32Array(N).fill(1);
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage);
    this.aLife = new THREE.BufferAttribute(this.life, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos); g.setAttribute('aColor', this.aCol); g.setAttribute('aLife', this.aLife);
    this.points = new THREE.Points(g, trailMat);
    this.points.frustumCulled = false; this.points.visible = false; this.points.renderOrder = 2;
    this.points.onBeforeRender = renderer => { renderer.getDrawingBufferSize(bufSize); trailMat.uniforms.uScale.value = bufSize.y * 0.5; };
    // flames: two pipes, an outer coloured cone and a white core each
    this.flameMat = new THREE.MeshBasicMaterial({ color: '#39c0ff', transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    this.flames = new THREE.Group(); this.flames.name = 'garage-flame'; this.flames.userData.garage = true; this.flames.visible = false;
    for (const sx of [1, -1]) {
      const o = new THREE.Mesh(flameGeo, this.flameMat), c = new THREE.Mesh(coreGeo, coreMat);
      for (const m of [o, c]) { m.position.set(this.ex.x * sx, this.ex.y, this.ex.z - 0.02); m.renderOrder = 3; m.userData.garage = true; this.flames.add(m); }
    }
    car.body.add(this.flames);
    this.next = 0; this.t = Math.random() * 10; this.flame = 0;
    this.lx = 0; this.lz = 0; this.has = false; // last emit point (world), for gap-free streaks
  }

  /** The trail colour right now (rainbow cycles). Writes into `out`. */
  color(out, shift = 0) {
    const it = item('trail', this.car.look && this.car.look.trail) || LOOKS.trail[0];
    if (it.color) return out.set(it.color);
    return out.setHSL(((this.t * 0.55 + shift) % 1 + 1) % 1, 1, 0.55);
  }

  update(dt) {
    const car = this.car;
    this.t += dt;
    if (!this.points.parent && car.obj.parent) car.obj.parent.add(this.points);
    const on = !!car.boosting;
    // flame: grows fast, dies fast, flickers
    this.flame += ((on ? 1 : 0) - this.flame) * (1 - Math.exp(-dt * (on ? 18 : 12)));
    this.flames.visible = this.flame > 0.03;
    if (this.flames.visible) {
      this.color(this.flameMat.color);
      const k = this.flame;
      for (let i = 0; i < this.flames.children.length; i++) {
        const m = this.flames.children[i], core = i % 2 === 1;
        const len = (core ? 0.45 : 0.9) * k * (0.8 + Math.random() * 0.45), r = k * (0.85 + Math.random() * 0.3);
        m.scale.set(r, r, Math.max(0.01, len));
      }
    }
    // particles: age and drift
    let alive = 0;
    for (let i = 0; i < N; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] = Math.max(0, this.life[i] - dt / this.max[i]);
      const j = i * 3;
      this.pos[j] += this.vel[j] * dt; this.pos[j + 1] += this.vel[j + 1] * dt; this.pos[j + 2] += this.vel[j + 2] * dt;
      if (this.life[i] > 0) alive++;
    }
    // emit along the path the exhausts travelled this frame
    const s = Math.sin(car.heading), c = Math.cos(car.heading);
    if (on) {
      const lz = this.ex.z, ly = this.ex.y + 0.06; // body space -> world: x' = x*c + z*s, z' = -x*s + z*c
      const cx = car.x + lz * s, cz = car.z + lz * c;
      const steps = this.has ? Math.min(6, Math.max(1, Math.ceil(Math.hypot(cx - this.lx, cz - this.lz) / 0.45))) : 1;
      for (let k = 1; k <= steps; k++) {
        const f = k / steps, bx = this.has ? this.lx + (cx - this.lx) * f : cx, bz = this.has ? this.lz + (cz - this.lz) * f : cz;
        const side = (this.next & 1) ? 1 : -1, lx = this.ex.x * side;
        const i = this.next; this.next = (this.next + 1) % N; const j = i * 3;
        this.pos[j] = bx + lx * c + (Math.random() - 0.5) * 0.12;
        this.pos[j + 1] = 0.06 + ly + (Math.random() - 0.5) * 0.1;
        this.pos[j + 2] = bz - lx * s + (Math.random() - 0.5) * 0.12;
        this.vel[j] = -s * 3 + (Math.random() - 0.5) * 1.2; this.vel[j + 1] = 0.6 + Math.random() * 0.8; this.vel[j + 2] = -c * 3 + (Math.random() - 0.5) * 1.2;
        this.max[i] = 0.2 + Math.random() * 0.14; this.life[i] = 1 - (steps - k) / steps * 0.25;
        this.color(tmpCol, i * 0.013);
        this.col[j] = tmpCol.r; this.col[j + 1] = tmpCol.g; this.col[j + 2] = tmpCol.b;
        alive++;
      }
      this.lx = cx; this.lz = cz; this.has = true;
    } else this.has = false;
    this.points.visible = alive > 0;
    if (alive || on) { this.aPos.needsUpdate = true; this.aCol.needsUpdate = true; this.aLife.needsUpdate = true; }
  }

  dispose() {
    this.points.removeFromParent(); this.points.geometry.dispose();
    this.flames.removeFromParent(); this.flameMat.dispose();
    trails.delete(this.car); active.delete(this);
  }
}

const trails = new Map(); // car -> NitroTrail
const active = new Set();
let tick = 0;

/** Once per frame: flames and trails for every car that has a look. Trails of cars no longer in `cars` are freed. */
export function updateTrails(dt, cars) {
  tick++;
  for (const car of cars) {
    if (!car || !car.look || !car.body) continue;
    let tr = trails.get(car);
    if (!tr) { tr = new NitroTrail(car); trails.set(car, tr); active.add(tr); }
    tr.seen = tick; tr.update(dt);
  }
  for (const tr of active) if (tr.seen !== tick) tr.dispose();
}
export const update = updateTrails;

/** Free the trails of these cars (or of every car when called without arguments). */
export function disposeTrails(cars) {
  if (!cars) { for (const tr of [...active]) tr.dispose(); return; }
  for (const car of cars) { const tr = trails.get(car); if (tr) tr.dispose(); }
}
