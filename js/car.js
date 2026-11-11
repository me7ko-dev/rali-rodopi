import * as THREE from 'three';
import { CarBody, collide, clamp } from './core/physics.js';

export { collide };
const SCALE = 1.7;

/** A car you can see: the physics body from core/physics.js plus its 3D model. */
export class Car extends CarBody {
  constructor(spec, gltfScene, name, isPlayer) {
    super(spec, name);
    this.isPlayer = isPlayer;
    this.obj = new THREE.Group(); this.body = new THREE.Group();
    const model = gltfScene.clone(true); model.scale.setScalar(SCALE);
    this.model = model;
    this.body.add(model); this.obj.add(this.body);
    this.wheels = { front: [], back: [] };
    model.traverse(o => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; }
      if (/^wheel-front/.test(o.name)) { o.rotation.order = 'YXZ'; this.wheels.front.push(o); }
      else if (/^wheel-back/.test(o.name)) this.wheels.back.push(o);
    });
  }

  sync(dt = 0, inp) {
    if (!this.obj) return; // called from the base constructor path before the model exists
    this.obj.position.set(this.x, 0.06, this.z);
    this.obj.rotation.y = this.heading;
    const roll = clamp(this.yawRate * this.vf * 0.0022, -0.13, 0.13);
    const pitch = inp ? clamp((inp.brake ? 0.05 : 0) - (inp.throttle ? 0.025 : 0) * (1 - Math.abs(this.vf) / this.spec.top), -0.05, 0.06) : 0;
    const k = dt ? 1 - Math.exp(-dt * 8) : 1;
    this.body.rotation.z += (roll - this.body.rotation.z) * k;
    this.body.rotation.x += (pitch - this.body.rotation.x) * k;
    for (const w of this.wheels.front) { w.rotation.y = this.steer * 0.42; w.rotation.x = this.spin; }
    for (const w of this.wheels.back) w.rotation.x = this.spin;
  }
}
