import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CARS, TRACKS, THEMES, RIVALS, LAPS } from './data.js';
import { buildTrack, W } from './track.js';
import { buildWorld, measure, Smoke } from './world.js';
import { Car, collide } from './car.js';
import { Sound } from './audio.js';

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const store = {
  get(k) { try { return localStorage.getItem('rali:' + k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem('rali:' + k, String(v)); } catch (e) {} }
};
const fmtTime = t => { if (t == null || !isFinite(t)) return '—'; const m = Math.floor(t / 60), s = t - m * 60; return m + ':' + s.toFixed(2).padStart(5, '0').replace('.', ','); };
const AUTO = new URLSearchParams(location.search).has('auto'); // self-driving player, for testing

/* ---------- renderer ---------- */
const stage = $('stage');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
stage.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, 1, 0.8, 4200);
function resize() {
  const w = stage.clientWidth || innerWidth, h = stage.clientHeight || innerHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();

/* ---------- assets ---------- */
const PROPS = ['treeLarge', 'treeSmall', 'grandStandCovered', 'grandStand', 'overheadRoundColored', 'billboard', 'tentLong', 'flagCheckers', 'lightPostLarge', 'bannerTowerRed', 'pitsGarage'];
const carModels = {}, propModels = {};
async function loadAll() {
  const loader = new GLTFLoader();
  const jobs = [...CARS.map(c => ['car', c.id, `assets/cars/${c.id}.glb`]), ...PROPS.map(p => ['prop', p, `assets/props/${p}.glb`])];
  let done = 0;
  await Promise.all(jobs.map(async ([kind, id, url]) => {
    const g = await loader.loadAsync(url);
    g.scene.traverse(o => { if (o.isMesh) for (const m of [].concat(o.material)) { m.metalness = 0; m.roughness = kind === 'car' ? 0.55 : 0.9; } });
    if (kind === 'car') carModels[id] = g.scene; else propModels[id] = measure(g.scene);
    $('loadBar').style.width = (++done / jobs.length * 100) + '%';
  }));
}

/* ---------- game state ---------- */
const sound = new Sound();
const smoke = new Smoke(); scene.add(smoke.points);
let trackI = clamp(parseInt(store.get('track') || '0', 10) || 0, 0, TRACKS.length - 1);
let carI = clamp(parseInt(store.get('car') || '0', 10) || 0, 0, 5);
let track = null, world = null, cars = [], player = null;
let state = 'loading', paused = false, time = 0, countT = 0, clock = 0, wrongT = 0, order = [];
const mapBase = document.createElement('canvas'); mapBase.width = mapBase.height = 340;
let mapFit = { k: 1, ox: 0, oz: 0 };

function setTrack(i) {
  trackI = i; store.set('track', i);
  if (world) world.dispose();
  if (track) { track.group.traverse(o => o.geometry && o.geometry.dispose()); track.group.removeFromParent(); }
  track = buildTrack(TRACKS[i]);
  world = buildWorld(track, THEMES[TRACKS[i].theme], propModels);
  scene.add(track.group, world.root); scene.fog = world.fog;
  // minimap background
  const g = mapBase.getContext('2d'), b = track.box, pad = 26;
  const k = (340 - pad * 2) / Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
  mapFit = { k, ox: 170 - (b.minX + b.maxX) / 2 * k, oz: 170 - (b.minZ + b.maxZ) / 2 * k };
  g.clearRect(0, 0, 340, 340); g.lineJoin = 'round';
  for (const [w, c] of [[15, 'rgba(10,11,15,.75)'], [8, '#f6f2e8']]) {
    g.beginPath();
    for (let n = 0; n < track.M; n += 2) g.lineTo(track.px[n] * k + mapFit.ox, track.pz[n] * k + mapFit.oz);
    g.closePath(); g.lineWidth = w; g.strokeStyle = c; g.stroke();
  }
  g.fillStyle = '#e23b2e'; g.fillRect(track.px[0] * k + mapFit.ox - 4, track.pz[0] * k + mapFit.oz - 9, 8, 18);
  makeCars();
}

function makeCars() {
  for (const c of cars) c.obj.removeFromParent();
  cars = [];
  const pSpec = CARS[carI];
  const rivals = CARS.filter(c => c !== pSpec).slice(0, 5);
  const M = track.M;
  rivals.forEach((spec, k) => {
    const s = { ...spec, top: (spec.top + pSpec.top) / 2 * (1.0 - k * 0.022), acc: (spec.acc + pSpec.acc) / 2 };
    const c = new Car(s, carModels[spec.id], RIVALS[k], false);
    c.skill = 1.0 - k * 0.035; c.baseLane = c.lane = (k % 2 ? -1 : 1) * (1.2 + (k % 3)); c.rank = k;
    cars.push(c);
  });
  player = new Car(pSpec, carModels[pSpec.id], 'Ти', true);
  player.baseLane = 0; player.skill = 0.97;
  cars.push(player);
  cars.forEach((c, k) => {
    const idx = M - 5 - k * 4;
    c.place(track, idx, k % 2 ? -3.2 : 3.2);
    c.total = idx - M; c.lapsDone = -1; c.lapStart = 0; c.finish = null; c.lapTimes = []; c.hit = 0;
    scene.add(c.obj);
  });
  order = cars.slice();
}

/* ---------- input ---------- */
const keys = new Set(), touch = {};
const coarse = matchMedia('(pointer: coarse)').matches;
addEventListener('keydown', e => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  if (e.repeat) return;
  keys.add(e.code);
  if ((e.code === 'KeyP' || e.code === 'Escape') && (state === 'race' || state === 'count')) togglePause();
  if (e.code === 'KeyR' && state === 'race' && !paused) { player.place(track, player.idx, 0); say('Върнат на пистата'); }
  if (e.code === 'Enter' && state === 'menu') startRace();
});
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
document.querySelectorAll('#touch button').forEach(b => {
  const k = b.dataset.k;
  b.addEventListener('pointerdown', e => { touch[k] = true; b.setPointerCapture(e.pointerId); e.preventDefault(); });
  for (const ev of ['pointerup', 'pointercancel']) b.addEventListener(ev, () => { touch[k] = false; });
});
function playerInput() {
  const left = keys.has('ArrowLeft') || keys.has('KeyA') || touch.left, right = keys.has('ArrowRight') || keys.has('KeyD') || touch.right;
  const brake = keys.has('ArrowDown') || keys.has('KeyS') || touch.brake;
  const gas = keys.has('ArrowUp') || keys.has('KeyW') || (coarse && !brake);
  return { steer: (left ? 1 : 0) - (right ? 1 : 0), throttle: gas ? 1 : 0, brake: brake ? 1 : 0, hand: keys.has('Space') || !!touch.hand, nitro: keys.has('ShiftLeft') || keys.has('ShiftRight') || !!touch.nitro };
}

/* ---------- menu ---------- */
function buildMenu() {
  const tl = $('trackList'), cl = $('carList');
  tl.innerHTML = ''; cl.innerHTML = '';
  TRACKS.forEach((t, i) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'opt'; b.setAttribute('aria-pressed', i === trackI);
    const len = i === trackI && track ? track.length : null, best = parseFloat(store.get(t.id + ':lap'));
    b.innerHTML = `<b>${t.name}</b><small>${t.sub}</small><small>Най-добра обиколка: ${fmtTime(isNaN(best) ? null : best)}</small>`;
    b.addEventListener('click', () => { if (i !== trackI) { setTrack(i); buildMenu(); } });
    tl.appendChild(b);
  });
  const mx = { top: 66, acc: 29, grip: 1.25 }, mn = { top: 46, acc: 17, grip: 0.8 };
  CARS.filter(c => !c.aiOnly).forEach((c, i) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'opt'; b.setAttribute('aria-pressed', i === carI);
    const bar = (label, key) => `<span class="stat">${label}<span class="bar"><span style="width:${Math.round((c[key] - mn[key]) / (mx[key] - mn[key]) * 100)}%"></span></span></span>`;
    b.innerHTML = `<b>${c.name}</b><small>${c.note}</small>${bar('Скорост', 'top')}${bar('Ускорение', 'acc')}${bar('Сцепление', 'grip')}`;
    b.addEventListener('click', () => { if (i !== carI) { carI = i; store.set('car', i); makeCars(); buildMenu(); } });
    cl.appendChild(b);
  });
}
function showMenu() {
  state = 'menu'; paused = false; sound.quiet();
  makeCars(); buildMenu();
  $('menu').hidden = false; $('hud').hidden = true; $('finish').hidden = true; $('pause').hidden = true;
}
function startRace() {
  sound.start();
  makeCars();
  time = 0; countT = 3; wrongT = 0; state = 'count'; paused = false; lastCount = 4;
  $('menu').hidden = true; $('finish').hidden = true; $('pause').hidden = true; $('hud').hidden = false;
  $('touch').hidden = !coarse; $('hLaps').textContent = LAPS; $('hOf').textContent = cars.length;
  const best = parseFloat(store.get(TRACKS[trackI].id + ':lap')); $('hBest').textContent = fmtTime(isNaN(best) ? null : best);
  // snap the camera behind the car
  const f = player.heading; camHeading = f;
  camera.position.set(player.x - Math.sin(f) * 9, 3.8, player.z - Math.cos(f) * 9);
}
function togglePause() { paused = !paused; $('pause').hidden = !paused; if (paused) sound.quiet(); }
let msgT = 0;
function say(text, secs = 1.8) { const m = $('msg'); m.textContent = text; m.classList.add('on'); msgT = secs; }

$('btnGo').addEventListener('click', startRace);
$('btnAgain').addEventListener('click', startRace);
$('btnMenu').addEventListener('click', showMenu);
$('btnQuit').addEventListener('click', showMenu);
$('btnResume').addEventListener('click', togglePause);

/* ---------- race ---------- */
let lastCount = 4, tableT = 0;
function lapCheck(c) {
  const laps = Math.floor(c.total / track.M);
  if (laps <= c.lapsDone) return;
  c.lapsDone = laps;
  if (laps >= 1) {
    const lt = time - c.lapStart; c.lapTimes.push(lt);
    if (c.isPlayer) {
      const key = TRACKS[trackI].id + ':lap', best = parseFloat(store.get(key));
      if (AUTO) { /* test runs never set records */ }
      else if (isNaN(best) || lt < best) { store.set(key, lt.toFixed(3)); $('hBest').textContent = fmtTime(lt); say('Най-добра обиколка: ' + fmtTime(lt), 2.6); sound.beep(1320, 0.25, 0.15, 'sine'); }
      else if (laps === LAPS - 1) say('Последна обиколка');
      else if (laps < LAPS) say('Обиколка ' + fmtTime(lt));
    }
  }
  c.lapStart = time;
  if (laps >= LAPS && c.finish == null) { c.finish = time; if (c.isPlayer) finishRace(); }
}
function ranking() {
  order = cars.slice().sort((a, b) => (b.finish != null ? 1e7 - b.finish : b.total) - (a.finish != null ? 1e7 - a.finish : a.total));
}
function finishRace() {
  state = 'done'; ranking();
  const place = order.indexOf(player) + 1;
  $('fTrack').textContent = TRACKS[trackI].name;
  $('fTitle').textContent = ['', 'Победа!', '2-ро място', '3-то място', '4-то място', '5-то място', '6-то място'][place];
  const key = TRACKS[trackI].id + ':race', best = parseFloat(store.get(key));
  const rec = !AUTO && (isNaN(best) || player.finish < best); if (rec) store.set(key, player.finish.toFixed(3));
  const lap = Math.min(...player.lapTimes);
  $('fNote').textContent = `Най-бърза обиколка ${fmtTime(lap)}. ` + (rec ? 'Това е най-доброто ти време на тази писта.' : `Рекордът ти тук е ${fmtTime(best)}.`);
  fillTable(); $('finish').hidden = false; $('hud').hidden = true; $('btnAgain').focus();
  sound.beep(place === 1 ? 1047 : 660, 0.5, 0.2, 'triangle');
}
function fillTable() {
  ranking();
  $('fTable').innerHTML = order.map((c, i) => `<tr class="${c.isPlayer ? 'me' : ''}"><td>${i + 1}</td><td>${c.name} <small>· ${CARS.find(s => s.id === c.spec.id).name}</small></td><td>${c.finish != null ? fmtTime(c.finish) : 'още кара'}</td></tr>`).join('');
}

/* ---------- frame ---------- */
let camHeading = 0;
const focus = new THREE.Vector3(), camGoal = new THREE.Vector3();
const mapCtx = $('map').getContext('2d');
const hud = { pos: $('hPos'), lap: $('hLap'), time: $('hTime'), spd: $('hSpd'), nitro: $('hNitro'), count: $('count') };
const idle = { steer: 0, throttle: 0, brake: 0, hand: false, nitro: false };

function simulate(dt) {
  let pIn = idle;
  for (const c of cars) {
    let inp;
    if (c.isPlayer && state === 'race' && !AUTO) inp = pIn = playerInput();
    else {
      inp = c.drive(track, cars);
      if (!c.isPlayer) { const gap = (c.total - player.total) * track.ds; c.band = gap > 140 ? 0.93 : gap < -140 ? 1.06 : 1; }
      if (c.finish != null) { inp.throttle = c.vf < 22 ? 0.6 : 0; }
      if (c.isPlayer) pIn = inp;
    }
    c.update(dt, inp, track);
  }
  collide(cars);
  for (const c of cars) lapCheck(c);
  return pIn;
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.05); last = now;
  if (state === 'loading') return;
  clock += dt;
  let pIn = idle;

  if (!paused) {
    if (state === 'count') {
      countT -= dt;
      const n = Math.ceil(countT);
      if (n !== lastCount && n > 0) { lastCount = n; hud.count.textContent = n; sound.beep(440, 0.15); }
      pIn = playerInput();
      if (countT <= 0) { state = 'race'; hud.count.textContent = 'Старт!'; sound.beep(880, 0.5); setTimeout(() => { if (hud.count.textContent === 'Старт!') hud.count.textContent = ''; }, 900); }
    } else if (state === 'race' || state === 'done') {
      if (state === 'race') time += dt;
      else { time += dt; tableT -= dt; if (tableT <= 0) { tableT = 0.5; fillTable(); } }
      pIn = simulate(dt / 2); pIn = simulate(dt / 2);
      if (state === 'race') {
        ranking();
        const along = player.vx * track.tx[player.idx] + player.vz * track.tz[player.idx];
        wrongT = along < -3 ? wrongT + dt : 0;
        if (wrongT > 1) say('Обратна посока', 0.4);
        if (player.hit > 7) sound.thud(player.hit);
      }
      for (const c of cars) c.hit = 0;
    }

    // smoke and dust
    for (const c of cars) {
      const slide = Math.abs(c.vl) > 5.5 && Math.abs(c.vf) > 6, dust = !c.onRoad && Math.abs(c.vf) > 9;
      if ((slide || dust) && Math.random() < 0.7) {
        const fx = Math.sin(c.heading), fz = Math.cos(c.heading), side = Math.random() < 0.5 ? 1 : -1;
        smoke.emit(c.x - fx * 1.7 + fz * side * 0.9, 0.35, c.z - fz * 1.7 - fx * side * 0.9, dust ? 2.1 : 1.5);
      }
    }
    smoke.update(dt);
    if (msgT > 0) { msgT -= dt; if (msgT <= 0) $('msg').classList.remove('on'); }
  }

  // sound
  if (state === 'count' || state === 'race') {
    const ratio = state === 'count' ? pIn.throttle * 0.5 : Math.abs(player.vf) / player.spec.top;
    if (!paused) { sound.engine(ratio, pIn.throttle, true); sound.skid(player.onRoad ? clamp((Math.abs(player.vl) - 4) / 60, 0, 0.16) : 0.02); }
  } else sound.quiet();

  // camera
  const sp = clamp(Math.abs(player.vf) / player.spec.top, 0, 1.3);
  if (state === 'menu' || state === 'done') {
    const a = clock * 0.22, r = state === 'menu' ? 8.5 : 12;
    camGoal.set(player.x + Math.sin(a) * r, state === 'menu' ? 2.6 : 4.5, player.z + Math.cos(a) * r);
    camera.position.lerp(camGoal, 1 - Math.exp(-dt * (state === 'menu' ? 20 : 3)));
    camera.fov += (48 - camera.fov) * 0.1; camera.updateProjectionMatrix();
    camera.lookAt(player.x, 1.1, player.z);
  } else if (!paused) {
    let dh = player.heading - camHeading; while (dh > Math.PI) dh -= 2 * Math.PI; while (dh < -Math.PI) dh += 2 * Math.PI;
    camHeading += dh * (1 - Math.exp(-dt * 5.5));
    const back = 8.6 + sp * 1.6;
    camGoal.set(player.x - Math.sin(camHeading) * back, 3.7 - sp * 0.4, player.z - Math.cos(camHeading) * back);
    camera.position.lerp(camGoal, 1 - Math.exp(-dt * 11));
    const fov = 60 + sp * 15 + (player.boosting ? 7 : 0);
    camera.fov += (fov - camera.fov) * (1 - Math.exp(-dt * 4)); camera.updateProjectionMatrix();
    camera.lookAt(player.x + Math.sin(player.heading) * 6, 1.5, player.z + Math.cos(player.heading) * 6);
    if (player.boosting) { camera.position.x += (Math.random() - 0.5) * 0.06; camera.position.y += (Math.random() - 0.5) * 0.06; }
  }
  focus.set(player.x, 0, player.z);
  world.update(camera, focus);

  // HUD
  if (state === 'race' || state === 'count') {
    hud.pos.textContent = order.indexOf(player) + 1;
    hud.lap.textContent = clamp(player.lapsDone + 1, 1, LAPS);
    hud.time.textContent = fmtTime(time);
    hud.spd.textContent = Math.round(Math.abs(player.vf) * 3.6);
    hud.nitro.style.width = (player.nitro * 100).toFixed(0) + '%';
    mapCtx.clearRect(0, 0, 340, 340); mapCtx.drawImage(mapBase, 0, 0);
    for (const c of cars) {
      mapCtx.beginPath(); mapCtx.arc(c.x * mapFit.k + mapFit.ox, c.z * mapFit.k + mapFit.oz, c.isPlayer ? 9 : 6, 0, 6.3);
      mapCtx.fillStyle = c.isPlayer ? '#ffb627' : '#14161b'; mapCtx.fill();
      mapCtx.lineWidth = 2.5; mapCtx.strokeStyle = c.isPlayer ? '#14161b' : '#f6f2e8'; mapCtx.stroke();
    }
  }
  renderer.render(scene, camera);
}

let last = performance.now();
loadAll().then(() => {
  setTrack(trackI);
  $('loading').hidden = true;
  showMenu();
  window.__game = { get cars() { return cars; }, get player() { return player; }, get track() { return track; }, get state() { return state; }, get time() { return time; }, startRace };
  requestAnimationFrame(frame);
}).catch(err => {
  console.error(err);
  $('loadText').textContent = 'Моделите не се заредиха. Играта трябва да се отвори през локалния сървър, не като файл.';
});
