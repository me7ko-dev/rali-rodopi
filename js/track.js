import * as THREE from 'three';

import { trackGeometry, W, KERB, RUN, LIM } from './core/geo.js';
import { THEMES } from './data.js';
export { W, KERB, RUN, LIM };

function canvasTex(size, draw) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

export function buildTrack(def) {
  const geo = trackGeometry(def);
  const { M, ds, px, pz, nx, nz, tx, tz } = geo;

  const group = new THREE.Group();

  // Each ribbon is built from separate quads so colour blocks stay crisp.
  function ribbon(o1, y1, o2, y2, colorFn, vScale) {
    const pos = new Float32Array(M * 18), uv = new Float32Array(M * 12), col = colorFn ? new Float32Array(M * 18) : null;
    const c = new THREE.Color();
    for (let i = 0, p = 0, u = 0; i < M; i++) {
      const j = (i + 1) % M;
      const ax = px[i] + nx[i] * o1, az = pz[i] + nz[i] * o1, bx = px[i] + nx[i] * o2, bz = pz[i] + nz[i] * o2;
      const cx = px[j] + nx[j] * o1, cz = pz[j] + nz[j] * o1, dx = px[j] + nx[j] * o2, dz = pz[j] + nz[j] * o2;
      const v0 = i * ds / (vScale || 1), v1 = (i + 1) * ds / (vScale || 1);
      const quad = [ax, y1, az, 0, v0, cx, y1, cz, 0, v1, bx, y2, bz, 1, v0, bx, y2, bz, 1, v0, cx, y1, cz, 0, v1, dx, y2, dz, 1, v1];
      if (colorFn) c.set(colorFn(i));
      for (let k = 0; k < 6; k++) {
        pos[p] = quad[k * 5]; pos[p + 1] = quad[k * 5 + 1]; pos[p + 2] = quad[k * 5 + 2];
        if (col) { col[p] = c.r; col[p + 1] = c.g; col[p + 2] = c.b; }
        p += 3; uv[u++] = quad[k * 5 + 3]; uv[u++] = quad[k * 5 + 4];
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    if (col) g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();
    return g;
  }

  const roadTex = canvasTex(256, (g, s) => {
    g.fillStyle = '#34363d'; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 2600; i++) { g.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,.035)' : 'rgba(0,0,0,.07)'; g.fillRect(Math.random() * s, Math.random() * s, 2, 2); }
    g.fillStyle = '#eeeae0'; g.fillRect(s * 0.035, 0, s * 0.022, s); g.fillRect(s * 0.943, 0, s * 0.022, s);
    g.fillRect(s * 0.492, 0, s * 0.016, s * 0.5);
  });
  roadTex.wrapT = THREE.RepeatWrapping;
  const flat = { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide };
  // themes may tint the asphalt or make it wet (shiny); the first three tracks keep the plain material
  const look = (THEMES[def.theme] || {}).road;
  const roadMat = !look ? new THREE.MeshLambertMaterial({ map: roadTex, ...flat })
    : look.wet ? new THREE.MeshPhongMaterial({ map: roadTex, color: look.color, specular: 0x8a929c, shininess: look.shine || 60, ...flat })
    : new THREE.MeshLambertMaterial({ map: roadTex, color: look.color, ...flat });
  const road = new THREE.Mesh(ribbon(-W, 0.06, W, 0.06, null, 12), roadMat);
  road.receiveShadow = true; group.add(road);

  const kerbCol = i => (Math.floor(i / 2) % 2 ? 0xd9362b : 0xf2efe6);
  const kerbMat = new THREE.MeshLambertMaterial({ vertexColors: true, ...flat, polygonOffsetFactor: -3 });
  for (const s of [-1, 1]) {
    const k = new THREE.Mesh(ribbon(s * W, 0.07, s * (W + KERB), 0.1, kerbCol), kerbMat);
    k.receiveShadow = true; group.add(k);
    const wallCol = i => (Math.floor(i / 4) % 2 ? 0xc93a30 : 0xe9e6dd);
    const wall = new THREE.Mesh(ribbon(s * (W + RUN), 0, s * (W + RUN), 1.15, wallCol), new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    wall.castShadow = true; wall.receiveShadow = true; group.add(wall);
    const cap = new THREE.Mesh(ribbon(s * (W + RUN), 1.15, s * (W + RUN + 0.5), 1.15, () => 0xbdb9b0), new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    group.add(cap);
  }

  const checker = canvasTex(64, (g, s) => { for (let y = 0; y < 2; y++) for (let x = 0; x < 8; x++) { g.fillStyle = (x + y) % 2 ? '#111' : '#f4f4f4'; g.fillRect(x * s / 8, y * s / 2, s / 8, s / 2); } });
  const line = new THREE.Mesh(new THREE.PlaneGeometry(2 * W, 3).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ map: checker, ...flat, polygonOffsetFactor: -4 }));
  line.position.set(px[0], 0.09, pz[0]); line.rotation.y = Math.atan2(tx[0], tz[0]); line.receiveShadow = true;
  group.add(line);

  return { ...geo, group };
}
