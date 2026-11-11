import * as THREE from 'three';
import { W, RUN } from './track.js';
import { Precipitation, Headlights, glowTexture, STARS_GLSL } from './weather.js';

function hash(x, y) {
  let n = Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
function vn(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let xf = x - xi, yf = y - yi;
  xf = xf * xf * (3 - 2 * xf); yf = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
}
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Deterministic random so a track always looks the same.
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

/** Measure a loaded model once: how to centre it on the ground and scale it to a given size. */
export function measure(scene) {
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene);
  const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
  return { scene, c, s, minY: box.min.y };
}

/**
 * Sky, light, ground, scenery and weather for one track.
 * opts.low: half the snow/rain particles and no extra shadow-casting light (for weak phones).
 */
export function buildWorld(track, theme, models, opts = {}) {
  const low = opts.low === true;
  const root = new THREE.Group();
  const extras = []; // things only the new themes add; disposed at the end
  // a copy of a material with its colour pulled toward tint = [colour, amount] (snowy trees); one copy per material
  const tints = new Map();
  const tinted = (mat, tint) => {
    if (Array.isArray(mat)) return mat.map(m => tinted(m, tint));
    if (!mat.color || mat.map || mat.name === 'bark') return mat;
    if (!tints.has(mat)) { const m = mat.clone(); m.color.lerp(new THREE.Color(tint[0]), tint[1]); tints.set(mat, m); extras.push(m); }
    return tints.get(mat);
  };
  const { px, pz, nx, nz, tx, tz, M, box } = track;
  const seed = rng(track.def.pts.length * 7919 + Math.round(track.length));

  /* ---- sky ---- */
  const sunDir = new THREE.Vector3(...theme.sunDir).normalize();
  const sky = new THREE.Mesh(new THREE.SphereGeometry(3000, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { uZ: { value: new THREE.Color(theme.zen) }, uH: { value: new THREE.Color(theme.hor) }, uSun: { value: sunDir }, uSunCol: { value: new THREE.Color(theme.sunCol) } },
    vertexShader: 'varying vec3 vD; void main(){ vD = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 uZ; uniform vec3 uH; uniform vec3 uSun; uniform vec3 uSunCol; varying vec3 vD;
      void main(){ vec3 d = normalize(vD); vec3 c = mix(uH, uZ, pow(clamp(d.y, 0.0, 1.0), 0.5));
        float s = max(dot(d, uSun), 0.0);
        c += uSunCol * (pow(s, 10.0) * 0.25 + pow(s, 120.0) * 0.5 + smoothstep(0.9993, 0.9996, s));${theme.stars ? STARS_GLSL : ''}
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`
  }));
  sky.renderOrder = -5; sky.frustumCulled = false;
  root.add(sky);

  /* ---- lights ---- */
  const hemi = new THREE.HemisphereLight(theme.hemiSky, theme.hemiGround, theme.hemi);
  const sun = new THREE.DirectionalLight(theme.sunCol, theme.sun);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera; sc.left = -75; sc.right = 75; sc.top = 75; sc.bottom = -75; sc.near = 10; sc.far = 420;
  sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.6;
  root.add(hemi, sun, sun.target);
  if (theme.night) sun.castShadow = false; // moonlight: the player's headlight casts the shadows instead

  /* ---- ground ---- */
  const cx = (box.minX + box.maxX) / 2, cz = (box.minZ + box.maxZ) / 2;
  const size = Math.max(box.maxX - box.minX, box.maxZ - box.minZ) + 1300;
  const SEG = 190;
  const height = (x, z, d) => {
    let f = 0, amp = 0.5, fr = 0.006;
    for (let o = 0; o < 4; o++) { f += vn(x * fr + o * 13.1, z * fr - o * 7.7) * amp; amp *= 0.5; fr *= 2.1; }
    f /= 0.9375;
    return (f - 0.41) * 105 * smooth(W + RUN + 6, 170, d) + smooth(260, 600, d) * 95;
  };
  const geo = new THREE.PlaneGeometry(size, size, SEG, SEG).rotateX(-Math.PI / 2);
  const gp = geo.attributes.position, gc = new Float32Array(gp.count * 3);
  const cGrass = new THREE.Color(theme.grass), cForest = new THREE.Color(theme.forest), cRock = new THREE.Color(theme.rock), cSand = new THREE.Color(theme.sand), c = new THREE.Color();
  for (let i = 0; i < gp.count; i++) {
    const x = gp.getX(i) + cx, z = gp.getZ(i) + cz;
    const d = track.distance(x, z), h = height(x, z, d);
    gp.setXYZ(i, x, h, z);
    if (h < -0.6) c.copy(cSand); else if (h < 28) c.copy(cGrass).lerp(cForest, smooth(2, 28, h)); else c.copy(cForest).lerp(cRock, smooth(40, 95, h));
    const v = 0.9 + hash(i, 3) * 0.2;
    gc[i * 3] = c.r * v; gc[i * 3 + 1] = c.g * v; gc[i * 3 + 2] = c.b * v;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(gc, 3));
  geo.computeVertexNormals();
  const ground = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  ground.receiveShadow = true;
  root.add(ground);

  const water = new THREE.Mesh(new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2), new THREE.MeshPhongMaterial({ color: theme.water, shininess: 120, specular: 0xffffff, transparent: true, opacity: 0.88 }));
  water.position.set(cx, -1.6, cz);
  root.add(water);

  /* ---- scenery from the model packs ---- */
  const tmp = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1);
  // places: [{x, y, z, yaw, size}] ; "by" picks which dimension "size" refers to
  function scatter(name, places, by = 'xz', cast = true, tint = null) {
    const m = models[name]; if (!m || !places.length) return;
    const dim = by === 'y' ? m.s.y : Math.max(m.s.x, m.s.z);
    m.scene.traverse(o => {
      if (!o.isMesh) return;
      const im = new THREE.InstancedMesh(o.geometry, tint ? tinted(o.material, tint) : o.material, places.length);
      places.forEach((p, i) => {
        const k = p.size / dim;
        tmp.compose(new THREE.Vector3(p.x, p.y || 0, p.z), q.setFromAxisAngle(up, p.yaw || 0), one);
        tmp.multiply(new THREE.Matrix4().makeScale(k, k, k)).multiply(new THREE.Matrix4().makeTranslation(-m.c.x, -m.minY, -m.c.z)).multiply(o.matrixWorld);
        im.setMatrixAt(i, tmp);
      });
      im.castShadow = cast; im.receiveShadow = true; im.frustumCulled = false;
      root.add(im);
    });
  }
  // A spot beside the track: sample index, side (+1 / -1), distance from the centre line. Model front (+z) faces the road.
  const beside = (i, side, off, size, turn = 0) => {
    i = ((i % M) + M) % M;
    return { x: px[i] + nx[i] * side * off, z: pz[i] + nz[i] * side * off, yaw: Math.atan2(-nx[i] * side, -nz[i] * side) + turn, size };
  };
  const edge = W + RUN;

  const trees = { treeLarge: [], treeSmall: [] };
  for (let n = 0; n < 5200 && trees.treeLarge.length + trees.treeSmall.length < 900; n++) {
    const x = box.minX - 230 + seed() * (box.maxX - box.minX + 460), z = box.minZ - 230 + seed() * (box.maxZ - box.minZ + 460);
    const d = track.distance(x, z);
    if (d < edge + 5 || d > 240) continue;
    if (vn(x * 0.02 + 3, z * 0.02 + 8) < 0.42 && d > edge + 22) continue; // clearings
    const h = height(x, z, d); if (h < 0.2) continue;
    const big = seed() < 0.6;
    (big ? trees.treeLarge : trees.treeSmall).push({ x, y: h - 0.2, z, yaw: seed() * 6.28, size: big ? 9 + seed() * 6 : 5 + seed() * 3 });
  }
  scatter('treeLarge', trees.treeLarge, 'y', true, theme.treeTint); scatter('treeSmall', trees.treeSmall, 'y', true, theme.treeTint);

  const posts = [], boards = [], towers = [];
  if (theme.lamps) for (let i = 20, k = 0; i < M - 12; i += theme.lamps, k++) posts.push(beside(i, k % 2 ? 1 : -1, edge + 1.5, 10, Math.PI / 2));
  else for (let i = 20; i < M; i += 36) posts.push(beside(i, (i / 36) % 2 ? 1 : -1, edge + 1.5, 10, Math.PI / 2));
  for (let i = 70; i < M - 40; i += 120) {
    // outside of the bend: the side the track curves away from
    const a = (i - 6 + M) % M, b = (i + 6) % M, turn = tx[a] * tz[b] - tz[a] * tx[b];
    boards.push(beside(i, turn > 0 ? -1 : 1, edge + 5, 11));
  }
  for (let i = 130; i < M - 40; i += 240) towers.push(beside(i, 1, edge + 3, 3.4), beside(i + 8, -1, edge + 3, 3.4));
  scatter('lightPostLarge', posts, 'y'); scatter('billboard', boards); scatter('bannerTowerRed', towers);

  const stands = [], garages = [], tents = [];
  for (let k = 0; k < 4; k++) stands.push(beside(8 + k * 9, 1, edge + 11, 17));
  for (let k = 0; k < 3; k++) garages.push(beside(10 + k * 6, -1, edge + 8, 11.5));
  for (let k = 0; k < 2; k++) tents.push(beside(34 + k * 10, -1, edge + 9, 18));
  scatter('grandStandCovered', stands.slice(0, 2)); scatter('grandStand', stands.slice(2));
  scatter('pitsGarage', garages); scatter('tentLong', tents);
  scatter('overheadRoundColored', [{ x: px[3], z: pz[3], yaw: Math.atan2(-nz[3], nx[3]), size: 2 * edge + 1 }]);
  scatter('flagCheckers', [beside(3, 1, edge + 2, 9), beside(3, -1, edge + 2, 9)], 'y');

  /* ---- night: glowing lamp heads and pools of light under them ---- */
  if (theme.lamps && posts.length && models.lightPostLarge) {
    const tips = lampHeads(models.lightPostLarge, posts);
    const glow = glowTexture();
    const hg = new THREE.BufferGeometry();
    hg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(tips.flatMap(h => [h.x, h.y - 0.25, h.z])), 3));
    const halo = new THREE.Points(hg, new THREE.PointsMaterial({ color: 0xffd28a, size: 3.4, map: glow, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    halo.frustumCulled = false; halo.renderOrder = 3;
    // one pool per post, on the road on the post's side
    const poolGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const pools = new THREE.InstancedMesh(poolGeo, new THREE.MeshBasicMaterial({ map: glow, color: 0xffbf6a, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5 }), posts.length);
    const pm = new THREE.Matrix4(), ps = new THREE.Vector3(30, 1, 30), pp = new THREE.Vector3(), pq = new THREE.Quaternion();
    posts.forEach((p, i) => {
      const j = track.locate(p.x, p.z), side = Math.sign(track.lateral(p.x, p.z, j)) || 1;
      pp.set(px[j] + nx[j] * side * (W - 2.5), 0.13, pz[j] + nz[j] * side * (W - 2.5));
      pools.setMatrixAt(i, pm.compose(pp, pq, ps));
    });
    pools.frustumCulled = false; pools.renderOrder = 2;
    root.add(halo, pools);
    extras.push(glow, hg, halo.material, poolGeo, pools.material);
  }

  /* ---- weather and headlights ---- */
  let precip = null, heads = null;
  if (theme.weather) {
    precip = new Precipitation(theme.weather, Math.round((theme.weather === 'snow' ? 1400 : 1500) * (low ? 0.5 : 1)));
    root.add(precip.points);
  }
  if (theme.night) heads = new Headlights(root, { shadows: !low });

  const fog = new THREE.Fog(theme.hor, theme.fog[0], theme.fog[1]);

  /** Every frame. dt and cars are optional: without them the weather stands still and nobody gets headlights. */
  function update(camera, focus, dt = 0, cars = []) {
    sky.position.copy(camera.position);
    sun.position.copy(focus).addScaledVector(sunDir, 200);
    sun.target.position.copy(focus);
    if (precip) precip.update(camera, dt);
    if (heads) heads.update(cars);
  }
  function dispose() {
    if (heads) heads.dispose();
    if (precip) precip.dispose();
    for (const x of extras) x.dispose();
    root.traverse(o => { if (o.geometry && !o.isInstancedMesh) o.geometry.dispose(); });
    root.removeFromParent();
  }
  return { root, fog, update, dispose, height };
}

/** Where the lamps of each light post are, in world space (the model has an arm on each side; we take both tips). */
function lampHeads(m, places) {
  const pts = [], v = new THREE.Vector3();
  m.scene.traverse(o => {
    if (!o.isMesh) return;
    const a = o.geometry.attributes.position;
    for (let i = 0; i < a.count; i++) { v.fromBufferAttribute(a, i).applyMatrix4(o.matrixWorld); if (v.y > m.minY + m.s.y * 0.85) pts.push(v.clone()); }
  });
  if (!pts.length) return [];
  let minX = Infinity, maxX = -Infinity, top = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); top = Math.max(top, p.y); }
  const tips = [];
  for (const end of [minX, maxX]) {
    const near = pts.filter(p => Math.abs(p.x - end) < (maxX - minX) * 0.15);
    const t = new THREE.Vector3(); for (const p of near) t.add(p); t.divideScalar(near.length); t.y = top;
    tips.push(t);
  }
  const dim = m.s.y, mat = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), out = [];
  for (const p of places) {
    const k = p.size / dim;
    mat.compose(new THREE.Vector3(p.x, p.y || 0, p.z), q.setFromAxisAngle(up, p.yaw || 0), new THREE.Vector3(k, k, k))
      .multiply(new THREE.Matrix4().makeTranslation(-m.c.x, -m.minY, -m.c.z));
    for (const t of tips) out.push(t.clone().applyMatrix4(mat));
  }
  return out;
}

/** Soft round particles for tyre smoke and dust. */
export class Smoke {
  constructor(n = 360) {
    this.n = n; this.i = 0;
    this.pos = new Float32Array(n * 3); this.age = new Float32Array(n).fill(1); this.size = new Float32Array(n);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('aAge', new THREE.BufferAttribute(this.age, 1));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    this.points = new THREE.Points(g, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { uColor: { value: new THREE.Color(0xe9e6e0) }, uScale: { value: 600 } },
      vertexShader: 'attribute float aAge; attribute float aSize; varying float vA; uniform float uScale; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; gl_PointSize = aSize * (1.0 + aAge * 2.6) * uScale / -mv.z; vA = aAge >= 1.0 ? 0.0 : (1.0 - aAge) * 0.42; }',
      fragmentShader: 'uniform vec3 uColor; varying float vA; void main(){ float r = length(gl_PointCoord - 0.5); if (r > 0.5) discard; gl_FragColor = vec4(uColor, vA * smoothstep(0.5, 0.15, r)); }'
    }));
    this.points.frustumCulled = false;
  }
  emit(x, y, z, size) {
    const i = this.i; this.i = (i + 1) % this.n;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z; this.age[i] = 0; this.size[i] = size;
  }
  update(dt) {
    for (let i = 0; i < this.n; i++) if (this.age[i] < 1) { this.age[i] = Math.min(1, this.age[i] + dt * 1.3); this.pos[i * 3 + 1] += dt * 1.4; }
    const a = this.points.geometry.attributes; a.position.needsUpdate = a.aAge.needsUpdate = a.aSize.needsUpdate = true;
  }
}
