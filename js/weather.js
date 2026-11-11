// Weather and night effects: falling snow / rain around the camera, star sky, street lamp glow and car headlights.
// Everything here is cheap on purpose: one draw call per effect, no per-frame allocations, and at most one real light.
import * as THREE from 'three';

/** A soft round glow on a small canvas (shared by lamp heads and headlights). */
export function glowTexture(size = 64) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'), r = size / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(0.22, 'rgba(255,255,255,.75)');
  grad.addColorStop(0.5, 'rgba(255,255,255,.22)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Light falling on the road from a headlight: bright near the car, a wide fan that fades out ahead. */
function beamTexture(size = 128) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'), img = g.createImageData(size, size), d = img.data;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const v = y / (size - 1);                // canvas top row lands at the car (flipY), bottom row far ahead
    const u = (x / (size - 1)) * 2 - 1;      // -1..1 across
    const half = 0.22 + 0.78 * Math.sqrt(v); // the fan widens ahead
    const side = Math.max(0, 1 - Math.pow(Math.abs(u) / half, 2.2));
    const along = Math.min(1, v * 9) * Math.pow(1 - v, 1.35);
    const a = side * along;
    const i = (y * size + x) * 4;
    d[i] = d[i + 1] = d[i + 2] = Math.round(255 * Math.min(1, a * 1.25)); d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Star field for the night sky shader: added to the colour, so other skies stay exactly as they were. */
export const STARS_GLSL = `
  vec3 sd = d * 160.0; vec3 si = floor(sd);
  float sh = fract(sin(dot(si, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  float sr = length(fract(sd) - 0.5);
  c += vec3(0.9, 0.93, 1.0) * step(0.985, sh) * smoothstep(0.32, 0.0, sr) * smoothstep(0.02, 0.25, d.y) * (0.45 + 0.55 * fract(sh * 91.7));
`;

/**
 * Snow or rain: one THREE.Points whose drops live in a box that wraps around the camera on the GPU.
 * The CPU only moves a few uniforms per frame.
 */
export class Precipitation {
  constructor(kind, count) {
    const snow = kind === 'snow';
    this.snow = snow;
    this.box = snow ? new THREE.Vector3(72, 34, 72) : new THREE.Vector3(58, 30, 58);
    this.vel = snow ? new THREE.Vector3(0.6, -2.2, 0.3) : new THREE.Vector3(1.5, -24, 0.8);
    const pos = new Float32Array(count * 3), rnd = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = Math.random() * this.box.x; pos[i * 3 + 1] = Math.random() * this.box.y; pos[i * 3 + 2] = Math.random() * this.box.z;
      rnd[i] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aRnd', new THREE.BufferAttribute(rnd, 1));
    this.off = new THREE.Vector3(); this.time = 0;
    this.uniforms = {
      uOff: { value: this.off }, uCenter: { value: new THREE.Vector3() }, uBox: { value: this.box }, uTime: { value: 0 },
      uSize: { value: snow ? 0.16 : 0.62 }, uScale: { value: 700 }, uMax: { value: snow ? 14 : 44 },
      uColor: { value: new THREE.Color(snow ? 0xffffff : 0xb9c7d6) }, uAlpha: { value: snow ? 0.95 : 0.6 }
    };
    this.points = new THREE.Points(g, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false, uniforms: this.uniforms,
      vertexShader: `attribute float aRnd; uniform vec3 uOff; uniform vec3 uCenter; uniform vec3 uBox; uniform float uTime;
        uniform float uSize; uniform float uScale; uniform float uMax; varying float vA;
        void main(){
          vec3 p = position + uOff;
          ${snow ? 'p.x += sin(uTime * 0.9 + aRnd * 40.0) * 0.9; p.z += cos(uTime * 0.7 + aRnd * 30.0) * 0.9;' : ''}
          p = uCenter + mod(p - uCenter, uBox) - 0.5 * uBox;
          vec4 mv = viewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          float d = max(-mv.z, 0.3);
          gl_PointSize = min(uSize * (0.7 + 0.6 * aRnd) * uScale / d, uMax);
          vec2 e = abs(p.xz - uCenter.xz) / (0.5 * uBox.xz);
          vA = (1.0 - smoothstep(0.7, 1.0, max(e.x, e.y))) * smoothstep(0.4, 2.5, d);
        }`,
      fragmentShader: `uniform vec3 uColor; uniform float uAlpha; varying float vA;
        void main(){
          vec2 q = gl_PointCoord - 0.5;
          ${snow
            ? 'float a = smoothstep(0.5, 0.15, length(q));'
            : 'float a = smoothstep(0.07, 0.0, abs(q.x)) * smoothstep(0.5, 0.15, abs(q.y));'}
          if (a * vA < 0.01) discard;
          gl_FragColor = vec4(uColor, a * vA * uAlpha);
        }`
    }));
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    this.dir = new THREE.Vector3();
  }

  update(camera, dt) {
    this.time = (this.time + dt) % 1000;
    this.uniforms.uTime.value = this.time;
    const o = this.off, b = this.box, v = this.vel;
    // keep the offset inside one box (the shader wraps by the box anyway), so floats never grow
    o.x = (o.x + v.x * dt) % b.x; o.y = (o.y + v.y * dt) % b.y; o.z = (o.z + v.z * dt) % b.z;
    // centre the box a little ahead of and above the camera, where you can see the drops
    camera.getWorldDirection(this.dir);
    this.uniforms.uCenter.value.copy(camera.position).addScaledVector(this.dir, b.x * 0.3);
    this.uniforms.uCenter.value.y = camera.position.y + b.y * 0.25;
  }

  dispose() {
    this.points.geometry.dispose(); this.points.material.dispose(); this.points.removeFromParent();
  }
}

/**
 * Night: fake headlights on every car (glow sprites, a light fan on the road, a faint beam in the air)
 * and one real SpotLight that follows the player's car.
 */
export class Headlights {
  constructor(root, { shadows = true } = {}) {
    this.glow = glowTexture();
    this.beamTex = beamTexture();
    // two lamps at x = ±1; each car scales this to its own width (point sizes are not affected by scale)
    this.lampGeo = new THREE.BufferGeometry();
    this.lampGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, 0, 0, 1, 0, 0]), 3));
    const pm = (color, size) => new THREE.PointsMaterial({ color, size, map: this.glow, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
    this.frontMat = pm(0xfff2d2, 1.5); this.rearMat = pm(0xff2614, 0.95);
    // the fan of light on the road: a unit plane from z = 0 forward to z = 1, scaled per car
    this.beamGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0, 0.5);
    this.beamMat = new THREE.MeshBasicMaterial({ map: this.beamTex, color: 0xb0a080, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 });
    // a faint cone in the air, apex at the lamps
    const LEN = 22;
    this.coneGeo = new THREE.ConeGeometry(4.2, LEN, 14, 1, true).rotateX(-Math.PI / 2).translate(0, 0, LEN / 2);
    this.coneMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
      uniforms: { uLen: { value: LEN }, uColor: { value: new THREE.Color(0xfff0cc) }, uAlpha: { value: 0.11 } },
      vertexShader: `uniform float uLen; varying float vT; varying float vEdge;
        void main(){
          vT = position.z / uLen;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vec3 n = normalize(normalMatrix * normal);
          vEdge = abs(dot(n, normalize(-mv.xyz)));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `uniform vec3 uColor; uniform float uAlpha; varying float vT; varying float vEdge;
        void main(){ float a = pow(1.0 - vT, 2.0) * smoothstep(0.0, 0.06, vT) * pow(vEdge, 1.6) * uAlpha; gl_FragColor = vec4(uColor * a, a); }`
    });
    this.attached = [];

    this.spot = new THREE.SpotLight(0xfff1d8, 0, 95, 0.52, 0.6, 1.1);
    this.spot.castShadow = shadows;
    if (shadows) {
      this.spot.shadow.mapSize.set(512, 512);
      this.spot.shadow.camera.near = 1; this.spot.shadow.camera.far = 95;
      this.spot.shadow.bias = -0.0008; this.spot.shadow.normalBias = 0.4;
    }
    this.power = 18;
    root.add(this.spot, this.spot.target);
    this._inv = new THREE.Matrix4(); this._m = new THREE.Matrix4(); this._b = new THREE.Box3();
  }

  /** Put lights on one car, once. The parts are plain Object3Ds over shared buffers, so dropped cars leak nothing. */
  attach(car) {
    const obj = car.obj;
    if (!obj || (obj.userData.headlights && obj.userData.headlights.parent === obj)) return;
    // the car's size in its own frame (+z is forward)
    obj.updateMatrixWorld(true);
    this._inv.copy(obj.matrixWorld).invert();
    const box = new THREE.Box3();
    obj.traverse(o => {
      if (!o.isMesh || !o.geometry) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      this._b.copy(o.geometry.boundingBox).applyMatrix4(this._m.multiplyMatrices(this._inv, o.matrixWorld));
      box.union(this._b);
    });
    if (box.isEmpty()) box.set(new THREE.Vector3(-1, 0, -2.2), new THREE.Vector3(1, 1.4, 2.2));
    const halfW = (box.max.x - box.min.x) / 2, h = box.max.y - box.min.y, y = box.min.y + h * 0.38;
    const g = new THREE.Group(); g.name = 'headlights';
    const front = new THREE.Points(this.lampGeo, this.frontMat);
    front.position.set(0, y, box.max.z - 0.05); front.scale.x = halfW * 0.68;
    const rear = new THREE.Points(this.lampGeo, this.rearMat);
    rear.position.set(0, y + h * 0.05, box.min.z + 0.05); rear.scale.x = halfW * 0.72;
    const beam = new THREE.Mesh(this.beamGeo, this.beamMat);
    beam.position.set(0, 0.08, box.max.z - 0.4); beam.scale.set(16, 1, 34);
    const cone = new THREE.Mesh(this.coneGeo, this.coneMat);
    cone.position.set(0, y, box.max.z); cone.rotation.x = 0.07;
    for (const o of [front, rear, beam, cone]) { o.frustumCulled = false; o.renderOrder = 3; g.add(o); }
    g.userData.front = box.max.z; g.userData.y = y;
    obj.add(g); obj.userData.headlights = g;
    this.attached.push(g);
  }

  update(cars) {
    for (const c of cars) this.attach(c);
    // forget cars that are no longer in the scene
    for (let i = this.attached.length - 1; i >= 0; i--) {
      const g = this.attached[i];
      if (!g.parent || !g.parent.parent) { this.detach(g); this.attached.splice(i, 1); }
    }
    let player = null;
    for (const c of cars) if (c.isPlayer) { player = c; break; }
    const s = this.spot;
    if (!player || !player.obj) { s.intensity = 0; return; }
    const fx = Math.sin(player.heading), fz = Math.cos(player.heading), o = player.obj.position;
    const g = player.obj.userData.headlights, front = g ? g.userData.front : 2;
    s.intensity = this.power;
    s.position.set(o.x + fx * (front - 0.3), 1.25, o.z + fz * (front - 0.3));
    s.target.position.set(o.x + fx * 30, 0, o.z + fz * 30);
  }

  detach(g) {
    const p = g.parent;
    if (p && p.userData.headlights === g) delete p.userData.headlights;
    g.removeFromParent();
  }

  dispose() {
    for (const g of this.attached) this.detach(g);
    this.attached.length = 0;
    for (const x of [this.lampGeo, this.beamGeo, this.coneGeo, this.frontMat, this.rearMat, this.beamMat, this.coneMat, this.glow, this.beamTex]) x.dispose();
    this.spot.removeFromParent(); this.spot.target.removeFromParent();
    if (this.spot.shadow && this.spot.shadow.map) this.spot.shadow.map.dispose();
  }
}
