import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CARS, TRACKS, THEMES, RIVALS, LAPS } from './data.js';
import { buildTrack } from './track.js';
import { buildWorld, measure, Smoke } from './world.js';
import { Car, collide } from './car.js';
import { Sound } from './audio.js';
import { lapCheck as lapCount, rank, gridSlot, pointsFor } from './core/race.js';
import { cleanLook, DEFAULT_LOOK } from './core/looks.js';
import { Api, RaceLink, Smoother } from './net.js';
import { applyLook, updateTrails, disposeTrails, disposeLook } from './garage.js';
import { openGarage } from './garage-ui.js';

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return localStorage.getItem('rali:' + k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem('rali:' + k, String(v)); } catch (e) { /* private mode */ } }
};
const fmtTime = t => { if (t == null || !isFinite(t)) return '—'; const m = Math.floor(t / 60), s = t - m * 60; return m + ':' + s.toFixed(2).padStart(5, '0').replace('.', ','); };
const QS = new URLSearchParams(location.search);
const AUTO = QS.has('auto'); // self-driving player, for testing
const PLAYABLE = CARS.filter(c => !c.aiOnly);
const carName = id => (CARS.find(c => c.id === id) || CARS[0]).name;
const placeWord = p => p === 1 ? 'Победа!' : p + '-' + (p === 2 ? 'ро' : p === 3 ? 'то' : p === 7 || p === 8 ? 'мо' : 'то') + ' място';
const coarse = matchMedia('(pointer: coarse)').matches;

/* ---------- quality: picked automatically, lowered if the frame rate drops ---------- */
const QUALITY = ['low', 'mid', 'high'];
let qualityPref = store.get('quality') || 'auto';
let quality = qualityPref !== 'auto' ? qualityPref : (store.get('autoq') || (coarse ? 'mid' : 'high'));

/* ---------- renderer ---------- */
const stage = $('stage');
const renderer = new THREE.WebGLRenderer({ antialias: !coarse, powerPreference: 'high-performance' });
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
stage.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, 1, 0.8, 4200);
function resize() {
  const w = stage.clientWidth || innerWidth, h = stage.clientHeight || innerHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
}
function applyQuality() {
  const dpr = window.devicePixelRatio || 1;
  renderer.setPixelRatio(quality === 'high' ? Math.min(dpr, 2) : quality === 'mid' ? Math.min(dpr, 1.5) : Math.min(dpr, 1) * (coarse ? 0.8 : 1));
  renderer.shadowMap.enabled = quality !== 'low';
  if (world) world.root.traverse(o => {
    if (o.isDirectionalLight && o.castShadow) {
      const size = quality === 'high' ? 2048 : 1024;
      if (o.shadow.mapSize.x !== size) { o.shadow.mapSize.set(size, size); o.shadow.map?.dispose(); o.shadow.map = null; }
    }
  });
  scene.traverse(o => { if (o.material) for (const m of [].concat(o.material)) m.needsUpdate = true; });
  resize();
  if (window.__game) window.__game.quality = quality;
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
const api = new Api();
const sound = new Sound();
const smoke = new Smoke(); scene.add(smoke.points);
let trackI = clamp(parseInt(store.get('track') || '0', 10) || 0, 0, TRACKS.length - 1);
let carI = clamp(parseInt(store.get('car') || '0', 10) || 0, 0, PLAYABLE.length - 1);
let mode = ['solo', 'champ', 'online'].includes(store.get('mode')) ? store.get('mode') : 'solo';
let track = null, world = null, cars = [], player = null;
let state = 'loading', paused = false, time = 0, countT = 0, clock = 0, wrongT = 0, order = [];
let race = { kind: 'solo' };     // kind: solo | champ | online | fallback (online that lost the server)
let champ = null;                // { round, table: {name: points}, names }
let link = null;                 // RaceLink while online
let online = null;               // the room as the server described it
let sendT = 0;
const mapBase = document.createElement('canvas'); mapBase.width = mapBase.height = 340;
let mapFit = { k: 1, ox: 0, oz: 0 };

// garage points and look: the profile's when signed in, else this browser's
const localPts = () => parseInt(store.get('pts') || '0', 10) || 0;
const garagePts = () => api.me ? api.me.garage : localPts();
function myLook() {
  if (api.me) return cleanLook(api.me.look, api.me.garage);
  let l = null; try { l = JSON.parse(store.get('look') || 'null'); } catch (e) { /* */ }
  return cleanLook(l, localPts());
}

function setTrack(i) {
  trackI = i;
  if (race.kind !== 'online') store.set('track', i);
  if (world) world.dispose();
  if (track) { track.group.traverse(o => o.geometry && o.geometry.dispose()); track.group.removeFromParent(); }
  track = buildTrack(TRACKS[i]);
  world = buildWorld(track, THEMES[TRACKS[i].theme], propModels, { low: quality === 'low' });
  scene.add(track.group, world.root); scene.fog = world.fog;
  applyQuality();
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
}

function clearCars() {
  disposeTrails(cars);
  for (const c of cars) { disposeLook(c); c.obj.removeFromParent(); }
  cars = []; player = null;
  labels.clear();
}
function addCar(c, slot) {
  const { idx, lateral } = gridSlot(track.M, slot);
  c.place(track, idx, lateral);
  c.total = idx - track.M; c.lapsDone = -1; c.lapStart = 0; c.finish = null; c.lapTimes = []; c.hit = 0; c.slot = slot;
  scene.add(c.obj); cars.push(c);
  return c;
}

/** Five rivals and you, for the solo race and the championship. */
function makeCars() {
  clearCars();
  const pSpec = PLAYABLE[carI];
  const rivals = CARS.filter(c => c !== pSpec).slice(0, 5);
  rivals.forEach((spec, k) => {
    const s = { ...spec, top: (spec.top + pSpec.top) / 2 * (1.0 - k * 0.022), acc: (spec.acc + pSpec.acc) / 2 };
    const c = new Car(s, carModels[spec.id], RIVALS[k], false);
    c.skill = 1.0 - k * 0.035; c.baseLane = c.lane = (k % 2 ? -1 : 1) * (1.2 + (k % 3)); c.rank = k;
    addCar(c, k);
  });
  player = new Car(pSpec, carModels[pSpec.id], 'Ти', true);
  player.baseLane = 0; player.skill = 0.97;
  addCar(player, 5);
  player.look = myLook(); applyLook(player, player.look);
  order = cars.slice();
}

/** Online: every player from the server, in their grid slots. Others are "ghosts" moved by the network. */
function makeOnlineCars(players) {
  clearCars();
  for (const p of players.slice().sort((a, b) => a.slot - b.slot)) {
    const spec = CARS.find(c => c.id === p.car) || PLAYABLE[0];
    const me = p.id === link.you;
    const c = new Car(spec, carModels[spec.id], me ? (api.me?.name || 'Ти') : p.name, me);
    c.netId = p.id; c.isBot = p.bot;
    if (!me) { c.ghost = true; c.remote = true; c.smooth = new Smoother(); c.skill = 0.95; c.baseLane = c.lane = (p.slot % 2 ? -1 : 1) * 2; }
    addCar(c, p.slot);
    c.look = cleanLook(me ? myLook() : p.look);
    applyLook(c, c.look);
    if (me) player = c;
  }
  if (!player) throw new Error('no player car');
  order = cars.slice();
}

/* ---------- name tags over the other cars ---------- */
const labels = {
  pool: new Map(), root: $('labels'), v: new THREE.Vector3(),
  clear() { for (const el of this.pool.values()) el.remove(); this.pool.clear(); },
  update() {
    const show = race.kind === 'online' || race.kind === 'fallback';
    const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
    for (const c of cars) {
      if (c === player || !show || !(state === 'race' || state === 'count' || state === 'done')) { const el = this.pool.get(c); if (el) el.hidden = true; continue; }
      let el = this.pool.get(c);
      if (!el) { el = document.createElement('div'); el.className = 'tag' + (c.isBot ? ' bot' : ''); el.textContent = c.name + (c.isBot ? ' · бот' : ''); this.root.appendChild(el); this.pool.set(c, el); }
      this.v.set(c.x, 3.1, c.z).project(camera);
      const dist = Math.hypot(c.x - camera.position.x, c.z - camera.position.z);
      const vis = this.v.z < 1 && Math.abs(this.v.x) < 1.1 && Math.abs(this.v.y) < 1.1 && dist < 160;
      el.hidden = !vis;
      if (vis) { el.style.transform = `translate(${((this.v.x + 1) / 2 * w).toFixed(1)}px, ${((1 - this.v.y) / 2 * h).toFixed(1)}px) translate(-50%, -100%)`; el.style.opacity = dist > 90 ? 0.55 : 1; }
    }
  }
};

/* ---------- input ---------- */
const keys = new Set(), touch = {};
addEventListener('keydown', e => {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  if (e.repeat) return;
  keys.add(e.code);
  if ((e.code === 'KeyP' || e.code === 'Escape') && (state === 'race' || state === 'count')) togglePause();
  if (e.code === 'KeyR' && state === 'race' && !paused) { player.place(track, player.idx, 0); say('Върнат на пистата'); }
  if (e.code === 'Enter' && state === 'menu' && mode !== 'online' && !document.querySelector('.garage, #boards:not([hidden])')) go();
});
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
document.querySelectorAll('#touch button').forEach(b => {
  const k = b.dataset.k;
  b.addEventListener('pointerdown', e => { touch[k] = true; b.setPointerCapture(e.pointerId); e.preventDefault(); if (navigator.vibrate && k === 'nitro') navigator.vibrate(12); });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, () => { touch[k] = false; });
});
$('touchReset')?.addEventListener('click', () => { if (state === 'race' && !paused) { player.place(track, player.idx, 0); say('Върнат на пистата'); } });
function playerInput() {
  const left = keys.has('ArrowLeft') || keys.has('KeyA') || touch.left, right = keys.has('ArrowRight') || keys.has('KeyD') || touch.right;
  const brake = keys.has('ArrowDown') || keys.has('KeyS') || touch.brake;
  const gas = keys.has('ArrowUp') || keys.has('KeyW') || (coarse && !brake);
  return { steer: (left ? 1 : 0) - (right ? 1 : 0), throttle: gas ? 1 : 0, brake: brake ? 1 : 0, hand: keys.has('Space') || !!touch.hand, nitro: keys.has('ShiftLeft') || keys.has('ShiftRight') || !!touch.nitro };
}

/* ---------- menu ---------- */
function buildMenu() {
  document.querySelectorAll('.modes button').forEach(b => b.setAttribute('aria-selected', b.dataset.mode === mode));
  $('paneSolo').hidden = mode !== 'solo'; $('paneChamp').hidden = mode !== 'champ'; $('paneOnline').hidden = mode !== 'online';
  $('btnGo').hidden = mode === 'online';
  $('btnGo').textContent = mode === 'champ' ? (champ && champ.round > 0 && champ.round < TRACKS.length ? 'Продължи' : 'Старт') : 'Старт';
  const tl = $('trackList'), cl = $('carList');
  tl.innerHTML = ''; cl.innerHTML = '';
  TRACKS.forEach((t, i) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'opt'; b.setAttribute('aria-pressed', i === trackI);
    const best = parseFloat(store.get(t.id + ':lap'));
    b.innerHTML = `<b>${esc(t.name)}</b><small>${esc(t.sub)}</small><small>Най-добра обиколка: ${fmtTime(isNaN(best) ? null : best)}</small>`;
    b.addEventListener('click', () => { if (i !== trackI) { setTrack(i); makeCars(); buildMenu(); } });
    tl.appendChild(b);
  });
  const mx = { top: 66, acc: 29, grip: 1.25 }, mn = { top: 46, acc: 17, grip: 0.8 };
  PLAYABLE.forEach((c, i) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'opt'; b.setAttribute('aria-pressed', i === carI);
    const bar = (label, key) => `<span class="stat">${label}<span class="bar"><span style="width:${Math.round((c[key] - mn[key]) / (mx[key] - mn[key]) * 100)}%"></span></span></span>`;
    b.innerHTML = `<b>${esc(c.name)}</b><small>${esc(c.note)}</small>${bar('Скорост', 'top')}${bar('Ускорение', 'acc')}${bar('Сцепление', 'grip')}`;
    b.addEventListener('click', () => { if (i !== carI) { carI = i; store.set('car', i); makeCars(); buildMenu(); } });
    cl.appendChild(b);
  });
  // championship
  const ct = $('champTable');
  if (champ && champ.round > 0) {
    ct.innerHTML = `<p>Писта ${Math.min(champ.round + 1, TRACKS.length)} от ${TRACKS.length}: <b>${esc(TRACKS[Math.min(champ.round, TRACKS.length - 1)].name)}</b></p>` + champTableHtml();
  } else ct.innerHTML = `<p>${TRACKS.map(t => esc(t.name)).join(' → ')}</p>`;
  $('btnChampNew').hidden = !(champ && champ.round > 0);
  $('ptsBadge').textContent = garagePts() + ' т.';
  $('btnQuality').textContent = 'Качество: ' + ({ auto: 'авто', high: 'високо', mid: 'средно', low: 'ниско' }[qualityPref]);
  buildOnlinePane();
}
function champTableHtml() {
  const rows = Object.entries(champ.table).sort((a, b) => b[1] - a[1]);
  return `<table class="mini">${rows.map(([n, p], i) => `<tr class="${n === 'Ти' ? 'me' : ''}"><td>${i + 1}</td><td>${esc(n)}</td><td>${p} т.</td></tr>`).join('')}</table>`;
}
function buildOnlinePane() {
  const me = api.me;
  $('onAuth').hidden = !!me; $('onHome').hidden = !me;
  if (!api.online) { $('onAuth').hidden = true; $('onStatus').textContent = 'Онлайн е изключен в този адрес.'; return; }
  if (me) {
    $('onHello').innerHTML = `Здравей, <b>${esc(me.name)}</b>`;
    $('onStats').textContent = `${me.points} точки онлайн · ${me.week} тази седмица · ${me.races} състезания · ${me.wins} победи`;
  }
  const sel = $('roomTrack');
  if (!sel.options.length) {
    sel.innerHTML = '<option value="random">Случайна писта</option>' + TRACKS.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  }
}
function setMode(m) {
  mode = m; store.set('mode', m);
  $('onStatus').textContent = '';
  buildMenu();
}
document.querySelectorAll('.modes button').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));

function showMenu() {
  if (link) { link.close(); link = null; }
  online = null; race = { kind: mode === 'champ' ? 'champ' : 'solo' };
  state = 'menu'; paused = false; sound.quiet();
  if (track.def !== TRACKS[trackI] || !track) setTrack(trackI);
  makeCars(); buildMenu();
  for (const id of ['hud', 'finish', 'pause', 'lobby']) $(id).hidden = true;
  $('menu').hidden = false;
}

/** The big button: a solo race or the next championship race. */
function go() {
  if (mode === 'champ') {
    if (!champ || champ.round >= TRACKS.length) newChamp();
    if (trackI !== champ.round) setTrack(champ.round);
    race = { kind: 'champ' };
  } else race = { kind: 'solo' };
  startRace();
}
function newChamp() {
  champ = { round: 0, table: {} };
  for (const n of [...RIVALS, 'Ти']) champ.table[n] = 0;
  store.set('champ', JSON.stringify(champ));
}
try { const c = JSON.parse(store.get('champ') || 'null'); if (c && typeof c.round === 'number' && c.table) champ = c; } catch (e) { /* */ }

function startRace() {
  sound.start();
  makeCars();
  time = 0; countT = 3; wrongT = 0; state = 'count'; paused = false; lastCount = 4;
  showHud();
}
function showHud() {
  for (const id of ['menu', 'finish', 'pause', 'lobby']) $(id).hidden = true;
  $('hud').hidden = false;
  $('touch').hidden = !coarse; $('hLaps').textContent = race.laps || LAPS; $('hOf').textContent = cars.length;
  const best = parseFloat(store.get(TRACKS[trackI].id + ':lap')); $('hBest').textContent = fmtTime(isNaN(best) ? null : best);
  $('hNet').hidden = race.kind !== 'online';
  const f = player.heading; camHeading = f;
  camera.position.set(player.x - Math.sin(f) * 9, 3.8, player.z - Math.cos(f) * 9);
  fps.reset();
}
function togglePause() {
  // online the race goes on without you, so "pause" only opens the menu
  paused = !paused; $('pause').hidden = !paused; if (paused) sound.quiet();
  $('pauseNote').hidden = race.kind !== 'online';
}
let msgT = 0;
function say(text, secs = 1.8) { const m = $('msg'); m.textContent = text; m.classList.add('on'); msgT = secs; }

$('btnGo').addEventListener('click', go);
$('btnMenu').addEventListener('click', showMenu);
$('btnQuit').addEventListener('click', showMenu);
$('btnResume').addEventListener('click', togglePause);
$('btnAgain').addEventListener('click', () => {
  if (race.kind === 'online' && online?.mode === 'quick') { goOnline({ mode: 'quick' }); return; }
  if (race.kind === 'online' && online?.mode === 'code') { $('finish').hidden = true; showLobby(online); return; }
  if (race.kind === 'champ' && champ.round >= TRACKS.length) newChamp();
  if (race.kind === 'champ') { setTrack(champ.round); }
  if (race.kind === 'fallback') race = { kind: 'solo' };
  startRace();
});
$('btnChampNew').addEventListener('click', () => { newChamp(); buildMenu(); });
$('btnQuality').addEventListener('click', () => {
  const order = ['auto', 'high', 'mid', 'low'];
  qualityPref = order[(order.indexOf(qualityPref) + 1) % order.length]; store.set('quality', qualityPref);
  quality = qualityPref === 'auto' ? (store.get('autoq') || (coarse ? 'mid' : 'high')) : qualityPref;
  setTrack(trackI); makeCars(); buildMenu();
});

/* ---------- garage ---------- */
$('btnGarage').addEventListener('click', () => {
  const before = player.look;
  $('menu').hidden = true;
  openGarage({
    points: garagePts(), look: myLook(), carName: PLAYABLE[carI].name,
    onChange: l => { player.look = l; applyLook(player, l); },
    onClose: async l => {
      const look = cleanLook(l, garagePts());
      player.look = look; applyLook(player, look);
      if (api.me) { try { await api.look(look); } catch (e) { say(e.message, 3); player.look = before; } }
      else store.set('look', JSON.stringify(look));
      if (state === 'menu') $('menu').hidden = false;
      buildMenu();
    }
  });
});
/** Points for the garage after a race on your own. Signed in: on the server (capped there); else in this browser. */
async function earnSolo(place) {
  const pts = Math.ceil(pointsFor(place, true) / 2);
  if (AUTO) return 0;
  if (api.me) {
    try { const r = await api.solo(TRACKS[trackI].id, place); buildMenu(); return r.got; } catch (e) { return 0; }
  }
  store.set('pts', localPts() + pts);
  return pts;
}

/* ---------- online: sign in ---------- */
async function authAction(kind) {
  const name = $('onName').value, pass = $('onPass').value, st = $('onStatus');
  st.textContent = kind === 'reg' ? 'Правя профила…' : 'Влизам…';
  try {
    if (kind === 'reg') await api.register(name, pass); else await api.login(name, pass);
    $('onPass').value = '';
    // the points earned before the profile come along once
    if (localPts() > 0 && !api.me.imported) { try { const r = await api.importPoints(localPts()); if (r.got) store.set('pts', 0); } catch (e) { /* */ } }
    st.textContent = '';
    player.look = myLook(); applyLook(player, player.look);
  } catch (e) { st.textContent = e.message; }
  buildMenu();
}
$('onForm').addEventListener('submit', e => { e.preventDefault(); authAction('login'); });
$('btnReg').addEventListener('click', () => authAction('reg'));
$('btnLogout').addEventListener('click', async () => { await api.logout(); player.look = myLook(); applyLook(player, player.look); buildMenu(); });
$('btnDelete').addEventListener('click', async () => {
  const pass = prompt('Изтриване на профила завинаги. Напиши паролата си:');
  if (!pass) return;
  try { await api.deleteMe(pass); $('onStatus').textContent = 'Профилът е изтрит.'; } catch (e) { $('onStatus').textContent = e.message; }
  buildMenu();
});
$('btnQuick').addEventListener('click', () => goOnline({ mode: 'quick' }));
$('btnCreate').addEventListener('click', async () => {
  $('onStatus').textContent = 'Правя стаята…';
  try { const r = await api.room($('roomTrack').value, Number($('roomLaps').value)); goOnline({ code: r.code }); } catch (e) { $('onStatus').textContent = e.message; }
});
$('codeForm').addEventListener('submit', e => {
  e.preventDefault();
  const code = $('roomCode').value.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) { $('onStatus').textContent = 'Кодът е от 6 букви и цифри.'; return; }
  goOnline({ code });
});

/* ---------- online: the race ---------- */
let quickRetry = 0;
async function goOnline(params) {
  if (link) { link.close(); link = null; }
  const st = $('onStatus');
  st.textContent = 'Свързвам се…';
  for (const id of ['finish', 'hud', 'pause']) $(id).hidden = true;
  state = 'menu';
  const l = link = new RaceLink(api);
  l.on('hello', m => { if (l !== link) return; online = m; if (m.phase === 'wait') showLobby(m); })
    .on('lobby', m => { if (l !== link) return; online = { ...online, ...m }; if (state === 'menu' || state === 'lobby' || (state === 'done' && $('finish').hidden)) showLobby(online); else if (state === 'done') lobbyNote(); })
    .on('start', m => { if (l === link) startOnline(m); })
    .on('s', m => { if (l === link) onSnapshot(m); })
    .on('fin', m => { if (l !== link) return; const c = cars.find(x => x.slot === m.slot); if (c && c !== player) c.finish = m.time; })
    .on('res', m => { if (l === link) onlineResults(m); })
    .on('saved', async () => { if (l !== link) return; try { await api.refresh(); } catch (e) { /* */ } buildOnlinePane(); })
    .on('err', m => {
      if (l !== link) return;
      if (m.code === 'started' && params.mode === 'quick' && quickRetry++ < 2) { setTimeout(() => goOnline(params), 300); return; }
      link = null; backToOnlineMenu(m.msg);
    })
    .on('lost', () => { if (l === link && state !== 'menu') { say('Връзката прекъсна. Опитвам отново…', 4); $('hNet').textContent = 'няма връзка'; } })
    .on('back', () => { if (l === link) { say('Връзката се върна', 1.5); } })
    .on('dead', () => { if (l === link) lostServer(); })
    .on('closed', () => { if (l !== link) return; link = null; if (state === 'lobby') backToOnlineMenu('Стаята се затвори.'); });
  try {
    await l.connect({ car: PLAYABLE[carI].id, ...params });
    st.textContent = '';
    if (params.mode === 'quick') quickRetry = 0;
  } catch (e) {
    if (l === link) { link = null; backToOnlineMenu(e.message); }
  }
}
function backToOnlineMenu(msg) {
  if (link) { link.close(); link = null; }
  mode = 'online'; showMenu(); $('onStatus').textContent = msg || '';
}

function showLobby(m) {
  state = 'lobby';
  for (const id of ['menu', 'hud', 'finish', 'pause']) $(id).hidden = true;
  $('lobby').hidden = false;
  const t = TRACKS.find(x => x.id === m.track);
  $('lbTitle').textContent = m.mode === 'code' ? 'Стая ' + m.code : 'Бързо състезание';
  $('lbTrack').textContent = `${t ? t.name : ''} · ${m.laps} ${m.laps === 1 ? 'обиколка' : 'обиколки'}`;
  $('lbCode').hidden = m.mode !== 'code';
  $('lbCodeVal').textContent = m.code || '';
  $('lbList').innerHTML = (m.players || []).map(p => `<li class="${p.id === link?.you ? 'me' : ''}"><b>${esc(p.name)}</b><small>${esc(carName(p.car))}${p.id === m.host ? ' · домакин' : ''}${p.bot ? ' · бот' : ''}</small></li>`).join('');
  const host = m.mode === 'code' && m.host === link?.you;
  $('lbStart').hidden = !host;
  lobbyNote();
  // show the track behind the lobby
  const ti = TRACKS.findIndex(x => x.id === m.track);
  if (ti >= 0 && ti !== trackI) { setTrack(ti); makeCars(); }
}
function lobbyNote() {
  if (!online || !link) return;
  const m = online;
  if (m.mode === 'quick') {
    const left = Math.max(0, Math.ceil((m.deadline - link.serverNow()) / 1000));
    $('lbNote').textContent = m.phase === 'wait' ? (left > 0 ? `Събираме хора… ботовете идват след ${left} s` : 'Тръгваме…') : 'Тръгваме…';
  } else {
    const host = m.host === link.you, n = (m.players || []).length;
    $('lbNote').textContent = host ? (n < 2 ? 'Дай кода на приятел. Можеш да тръгнеш и сам (с ботове).' : 'Натисни „Старт“, когато всички са тук.') : 'Чакаме домакина да натисне „Старт“.';
  }
}
$('lbStart').addEventListener('click', () => link?.send({ t: 'start' }));
$('lbLeave').addEventListener('click', () => backToOnlineMenu(''));
$('lbCopy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(online.code); $('lbCopy').textContent = 'Копирано'; } catch (e) { /* */ } });

function startOnline(m) {
  online = { ...online, ...m };
  const ti = TRACKS.findIndex(x => x.id === m.track);
  if (ti < 0) { backToOnlineMenu('Тази писта я няма в играта. Обнови страницата.'); return; }
  race = { kind: 'online', laps: m.laps, startAt: m.startAt };
  if (ti !== trackI) setTrack(ti);
  sound.start();
  makeOnlineCars(m.players);
  time = 0; wrongT = 0; state = 'count'; paused = false; lastCount = 4; sendT = 0;
  countT = (m.startAt - link.serverNow()) / 1000;
  showHud();
}
const snap = {};
function onSnapshot(m) {
  for (const [slot, x, z, h, v, total, f] of m.c) {
    const c = cars.find(o => o.slot === slot);
    if (!c || c === player || !c.smooth) continue;
    c.smooth.push(m.n, x, z, h, v, total); c.netFlags = f;
  }
  if (link) $('hNet').textContent = Math.round(link.rtt) + ' ms';
}
const DELAY_MS = 130;
function moveRemotes(dt) {
  const t = link.serverNow() - race.startAt - DELAY_MS - Math.min(150, link.rtt / 2);
  for (const c of cars) {
    if (!c.remote || !c.smooth.sample(t, snap)) continue;
    const px = c.x, pz = c.z;
    c.x = snap.x; c.z = snap.z; c.heading = snap.h; c.total = snap.total;
    c.vf = snap.v; c.vx = (c.x - px) / Math.max(dt, 1e-3); c.vz = (c.z - pz) / Math.max(dt, 1e-3);
    c.idx = track.locate(c.x, c.z, c.idx); c.d = track.lateral(c.x, c.z, c.idx); c.onRoad = Math.abs(c.d) <= 8.3;
    c.boosting = !!(c.netFlags & 1); c.vl = c.netFlags & 2 ? 6 : 0;
    c.spin += c.vf * dt / 0.51; c.yawRate = 0;
    c.sync(dt);
  }
}
/** The server is gone for good: the others become bots and the race goes on, just not for the leaderboard. */
function lostServer() {
  if (link) { link.closed = true; link = null; }
  if (state === 'lobby' || state === 'menu') { backToOnlineMenu('Връзката със сървъра падна. Опитай пак или играй сам с ботове.'); return; }
  race = { ...race, kind: 'fallback' };
  for (const c of cars) if (c.remote) {
    c.remote = false; c.ghost = false; c.isBot = true;
    c.vx = Math.sin(c.heading) * c.vf; c.vz = Math.cos(c.heading) * c.vf;
    c.lapsDone = Math.floor(c.total / track.M); c.lapStart = time;
  }
  $('hNet').textContent = 'без сървър';
  say('Сървърът не отговаря. Продължаваш с ботове (не влиза в класацията).', 4);
}

function onlineResults(m) {
  race.results = m;
  const mine = m.rows.find(r => r.id === link?.you);
  if (state !== 'done') { state = 'done'; }
  const why = { speed: 'невъзможна скорост', laptime: 'невъзможно бърза обиколка', clock: 'грешен часовник', checkpoint: 'пропусната отсечка', jump: 'скок по пистата', offtrack: 'извън пистата', data: 'грешни данни' };
  $('fTrack').textContent = TRACKS[trackI].name + ' · онлайн';
  $('fTitle').textContent = mine ? placeWord(mine.place) : 'Финал';
  $('fTable').innerHTML = m.rows.map(r => `<tr class="${r.id === link?.you ? 'me' : ''}${r.valid ? '' : ' bad'}"><td>${r.place}</td><td>${esc(r.name)} <small>· ${r.bot ? 'бот' : esc(carName(r.car))}</small></td><td>${r.time != null ? fmtTime(r.time) : 'не завърши'}</td><td>${r.bot ? '' : r.valid ? '+' + r.points + ' т.' : 'не се брои'}</td></tr>`).join('');
  let note = '';
  if (mine) {
    note = mine.valid ? (mine.best != null ? `Най-бърза обиколка ${fmtTime(mine.best)}. ` : '') + `+${mine.points} точки за класацията и гаража.` : `Сървърът не прие резултата: ${mine.why.split(',').map(w => why[w] || w).join(', ')}.`;
  }
  $('fNote').textContent = note;
  $('btnAgain').textContent = online?.mode === 'code' ? 'Реванш' : 'Още едно';
  $('finish').hidden = false; $('hud').hidden = true; $('btnAgain').focus();
  if (mine) sound.beep(mine.place === 1 ? 1047 : 660, 0.5, 0.2, 'triangle');
}

/* ---------- leaderboards ---------- */
let boardTab = 'week';
$('btnBoards').addEventListener('click', () => { $('boards').hidden = false; showBoard(boardTab); });
$('bdClose').addEventListener('click', () => { $('boards').hidden = true; });
function boardTabs() {
  $('bdTabs').innerHTML = `<button type="button" data-t="week">Седмица</button>` + TRACKS.map(t => `<button type="button" data-t="${t.id}">${esc(t.name)}</button>`).join('');
  $('bdTabs').querySelectorAll('button').forEach(b => b.addEventListener('click', () => showBoard(b.dataset.t)));
}
async function showBoard(tab) {
  boardTab = tab;
  if (!$('bdTabs').children.length) boardTabs();
  $('bdTabs').querySelectorAll('button').forEach(b => b.setAttribute('aria-selected', b.dataset.t === tab));
  const list = $('bdList'), mine = $('bdMe');
  list.innerHTML = '<tr><td colspan="3">Зареждам…</td></tr>'; mine.textContent = '';
  try {
    if (tab === 'week') {
      const r = await api.week();
      list.innerHTML = r.top.length ? r.top.map((x, i) => `<tr><td>${i + 1}</td><td>${esc(x.name)}</td><td>${x.points} т.</td></tr>`).join('') : '<tr><td colspan="3">Още никой тази седмица. Бъди първи.</td></tr>';
      mine.innerHTML = r.me ? `Ти си <b>${r.me.rank}.</b> с ${r.me.points} т. от ${r.me.races} състезания` : api.me ? 'Още нямаш точки тази седмица.' : 'Влез в „Онлайн“, за да видиш своя ред.';
    } else {
      const r = await api.top(tab);
      list.innerHTML = r.top.length ? r.top.map((x, i) => `<tr><td>${i + 1}</td><td>${esc(x.name)} <small>· ${esc(carName(x.car))}</small></td><td>${fmtTime(x.ms / 1000)}</td></tr>`).join('') : '<tr><td colspan="3">Още няма времена на тази писта.</td></tr>';
      mine.innerHTML = r.me ? `Ти си <b>${r.me.rank}.</b> с ${fmtTime(r.me.ms / 1000)}` : api.me ? 'Още нямаш онлайн време тук.' : 'Влез в „Онлайн“, за да видиш своя ред.';
    }
  } catch (e) { list.innerHTML = `<tr><td colspan="3">${esc(e.message)}</td></tr>`; }
}

/* ---------- race ---------- */
let lastCount = 4, tableT = 0;
function lapCheck(c) {
  if (c.remote) return;
  const laps = race.laps || LAPS;
  const ev = lapCount(c, time, track.M, laps);
  if (!ev || !c.isPlayer) return;
  const lt = c.lapTimes[c.lapTimes.length - 1];
  const key = TRACKS[trackI].id + ':lap', best = parseFloat(store.get(key));
  const record = !AUTO && (isNaN(best) || lt < best);
  if (record) store.set(key, lt.toFixed(3));
  if (ev === 'lap') {
    if (record) { $('hBest').textContent = fmtTime(lt); say('Най-добра обиколка: ' + fmtTime(lt), 2.6); sound.beep(1320, 0.25, 0.15, 'sine'); }
    else if (c.lapsDone === laps - 1) say('Последна обиколка');
    else say('Обиколка ' + fmtTime(lt));
  }
  if (ev === 'finish') finishRace();
}
function ranking() { order = rank(cars); }
function finishRace() {
  state = 'done'; ranking();
  const place = order.indexOf(player) + 1;
  const lap = Math.min(...player.lapTimes);
  if (race.kind === 'online') {
    // the server has the last word; until it answers, show where we are
    $('fTrack').textContent = TRACKS[trackI].name + ' · онлайн';
    $('fTitle').textContent = 'Финал!';
    $('fNote').textContent = `Най-бърза обиколка ${fmtTime(lap)}. Чакаме останалите и сървъра…`;
    $('btnAgain').textContent = 'Още едно';
    fillTable(); $('finish').hidden = false; $('hud').hidden = true;
    sound.beep(place === 1 ? 1047 : 660, 0.5, 0.2, 'triangle');
    return;
  }
  $('fTrack').textContent = TRACKS[trackI].name + (race.kind === 'champ' ? ` · шампионат ${champ.round + 1}/${TRACKS.length}` : race.kind === 'fallback' ? ' · без сървър' : '');
  $('fTitle').textContent = placeWord(place);
  const key = TRACKS[trackI].id + ':race', best = parseFloat(store.get(key));
  const rec = !AUTO && (isNaN(best) || player.finish < best); if (rec) store.set(key, player.finish.toFixed(3));
  let note = `Най-бърза обиколка ${fmtTime(lap)}. ` + (rec ? 'Това е най-доброто ти време на тази писта.' : `Рекордът ти тук е ${fmtTime(best)}.`);
  $('btnAgain').textContent = 'Още веднъж';
  if (race.kind === 'champ') {
    order.forEach((c, i) => { const n = c.isPlayer ? 'Ти' : c.name; champ.table[n] = (champ.table[n] || 0) + pointsFor(i + 1, true); });
    champ.round++;
    store.set('champ', JSON.stringify(champ));
    const last = champ.round >= TRACKS.length;
    const standings = Object.entries(champ.table).sort((a, b) => b[1] - a[1]);
    const pos = standings.findIndex(([n]) => n === 'Ти') + 1;
    note += last ? ` Шампионатът свърши: ${pos === 1 ? 'ти си шампион!' : 'ти си ' + pos + '-и в класирането.'}` : ` В шампионата си ${pos}-и.`;
    $('btnAgain').textContent = last ? 'Нов шампионат' : 'Следваща писта';
  }
  if (race.kind !== 'fallback') earnSolo(place).then(got => { if (got) $('fNote').textContent = note + ` +${got} т. за гаража.`; });
  $('fNote').textContent = note;
  fillTable();
  if (race.kind === 'champ') $('fTable').insertAdjacentHTML('afterend', '');
  $('finish').hidden = false; $('hud').hidden = true; $('btnAgain').focus();
  sound.beep(place === 1 ? 1047 : 660, 0.5, 0.2, 'triangle');
}
function fillTable() {
  if (race.results) return; // online: the server's table is final
  ranking();
  let html = order.map((c, i) => `<tr class="${c.isPlayer ? 'me' : ''}"><td>${i + 1}</td><td>${esc(c.name)} <small>· ${c.isBot ? 'бот' : esc(carName(c.spec.id))}</small></td><td>${c.finish != null ? fmtTime(c.finish) : 'още кара'}</td></tr>`).join('');
  if (race.kind === 'champ' && champ) html += `<tr class="sep"><td colspan="3">Шампионат след ${champ.round} от ${TRACKS.length}</td></tr>` + Object.entries(champ.table).sort((a, b) => b[1] - a[1]).map(([n, p], i) => `<tr class="${n === 'Ти' ? 'me' : ''}"><td>${i + 1}</td><td>${esc(n)}</td><td>${p} т.</td></tr>`).join('');
  $('fTable').innerHTML = html;
}

/* ---------- frame ---------- */
let camHeading = 0;
const focus = new THREE.Vector3(), camGoal = new THREE.Vector3();
const mapCtx = $('map').getContext('2d');
const hud = { pos: $('hPos'), lap: $('hLap'), time: $('hTime'), spd: $('hSpd'), nitro: $('hNitro'), count: $('count'), board: $('hBoard') };
const idle = { steer: 0, throttle: 0, brake: 0, hand: false, nitro: false };

/** Frame-rate watch: during a race, lower the quality when the phone can't keep up. */
const fps = {
  n: 0, t: 0, low: 0,
  reset() { this.n = 0; this.t = 0; this.low = 0; },
  tick(dt) {
    if (qualityPref !== 'auto' || state !== 'race' || paused) return;
    this.n++; this.t += dt;
    if (this.t < 3) return;
    const f = this.n / this.t; this.n = 0; this.t = 0;
    if (window.__game) window.__game.fps = Math.round(f);
    if (f < 28 && quality !== 'low') {
      if (++this.low >= 2) {
        quality = QUALITY[QUALITY.indexOf(quality) - 1]; store.set('autoq', quality); this.low = 0;
        applyQuality(); say('По-ниско качество за по-гладка игра', 2);
      }
    } else this.low = 0;
  }
};

function simulate(dt) {
  let pIn = idle;
  for (const c of cars) {
    if (c.remote) continue;
    let inp;
    if (c.isPlayer && state === 'race' && !AUTO) inp = pIn = paused ? idle : playerInput();
    else {
      inp = c.drive(track, cars);
      if (!c.isPlayer && race.kind !== 'online' && race.kind !== 'fallback') { const gap = (c.total - player.total) * track.ds; c.band = gap > 140 ? 0.93 : gap < -140 ? 1.06 : 1; }
      if (c.finish != null) { inp.throttle = c.vf < 22 ? 0.6 : 0; }
      if (c.isPlayer) pIn = inp;
    }
    c.update(dt, inp, track);
  }
  collide(cars);
  for (const c of cars) lapCheck(c);
  return pIn;
}

let frames = 0;
function frame(now) {
  requestAnimationFrame(frame); frames++;
  const dt = Math.min((now - last) / 1000, 0.05); last = now;
  if (state === 'loading') return;
  clock += dt;
  let pIn = idle;
  const isOnline = race.kind === 'online' && link;

  if (state === 'lobby' && Math.floor(clock * 4) !== Math.floor((clock - dt) * 4)) lobbyNote();
  if (!paused || isOnline) {
    if (state === 'count') {
      countT = isOnline ? (race.startAt - link.serverNow()) / 1000 : countT - dt;
      const n = Math.ceil(countT);
      if (n !== lastCount && n > 0 && n <= 3) { lastCount = n; hud.count.textContent = n; sound.beep(440, 0.15); }
      pIn = playerInput();
      if (isOnline) moveRemotes(dt);
      if (countT <= 0) { state = 'race'; time = isOnline ? (link.serverNow() - race.startAt) / 1000 : 0; hud.count.textContent = 'Старт!'; sound.beep(880, 0.5); setTimeout(() => { if (hud.count.textContent === 'Старт!') hud.count.textContent = ''; }, 900); }
    } else if (state === 'race' || state === 'done') {
      time += dt;
      if (state === 'done') { tableT -= dt; if (tableT <= 0) { tableT = 0.5; if (!race.results) fillTable(); } }
      if (isOnline) moveRemotes(dt);
      pIn = simulate(dt / 2); pIn = simulate(dt / 2);
      if (isOnline) {
        sendT += dt;
        if (sendT >= 1 / 15) {
          sendT = 0;
          link.send({ t: 'p', x: +player.x.toFixed(2), z: +player.z.toFixed(2), h: +player.heading.toFixed(3), v: +player.vf.toFixed(2), k: +time.toFixed(3), f: (player.boosting ? 1 : 0) | (Math.abs(player.vl) > 5 ? 2 : 0) });
        }
      }
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
    updateTrails(dt, cars);
    if (msgT > 0) { msgT -= dt; if (msgT <= 0) $('msg').classList.remove('on'); }
    fps.tick(dt);
  }

  // sound
  if ((state === 'count' || state === 'race') && !paused) {
    const ratio = state === 'count' ? pIn.throttle * 0.5 : Math.abs(player.vf) / player.spec.top;
    sound.engine(ratio, pIn.throttle, true); sound.skid(player.onRoad ? clamp((Math.abs(player.vl) - 4) / 60, 0, 0.16) : 0.02);
  } else sound.quiet();

  // camera
  const sp = clamp(Math.abs(player.vf) / player.spec.top, 0, 1.3);
  if (state === 'menu' || state === 'done' || state === 'lobby') {
    const a = clock * 0.22, r = state === 'done' ? 12 : 8.5;
    camGoal.set(player.x + Math.sin(a) * r, state === 'done' ? 4.5 : 2.6, player.z + Math.cos(a) * r);
    camera.position.lerp(camGoal, 1 - Math.exp(-dt * (state === 'done' ? 3 : 20)));
    camera.fov += (48 - camera.fov) * 0.1; camera.updateProjectionMatrix();
    camera.lookAt(player.x, 1.1, player.z);
  } else if (!paused || isOnline) {
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
  world.update(camera, focus, dt, cars);

  // HUD
  if (state === 'race' || state === 'count') {
    const laps = race.laps || LAPS;
    hud.pos.textContent = order.indexOf(player) + 1;
    hud.lap.textContent = clamp(player.lapsDone + 1, 1, laps);
    hud.time.textContent = fmtTime(Math.max(0, time));
    hud.spd.textContent = Math.round(Math.abs(player.vf) * 3.6);
    hud.nitro.style.width = (player.nitro * 100).toFixed(0) + '%';
    if (Math.floor(clock * 4) !== Math.floor((clock - dt) * 4)) {
      // positions board: everyone, or the top 3 + you on small screens
      const small = innerHeight < 500, me = order.indexOf(player);
      hud.board.innerHTML = order.map((c, i) => (!small || i < 3 || i === me) ? `<li class="${c === player ? 'me' : ''}${c.finish != null ? ' fin' : ''}"><b>${i + 1}</b>${esc(c === player ? (race.kind === 'online' ? c.name : 'Ти') : c.name)}</li>` : '').join('');
    }
    mapCtx.clearRect(0, 0, 340, 340); mapCtx.drawImage(mapBase, 0, 0);
    for (const c of cars) {
      mapCtx.beginPath(); mapCtx.arc(c.x * mapFit.k + mapFit.ox, c.z * mapFit.k + mapFit.oz, c.isPlayer ? 9 : 6, 0, 6.3);
      mapCtx.fillStyle = c.isPlayer ? '#ffb627' : c.remote && !c.isBot ? '#39c0ff' : '#14161b'; mapCtx.fill();
      mapCtx.lineWidth = 2.5; mapCtx.strokeStyle = c.isPlayer ? '#14161b' : '#f6f2e8'; mapCtx.stroke();
    }
  }
  labels.update();
  renderer.render(scene, camera);
}

let last = performance.now();
loadAll().then(async () => {
  setTrack(trackI);
  $('loading').hidden = true;
  showMenu();
  window.__game = {
    get cars() { return cars; }, get player() { return player; }, get track() { return track; }, get state() { return state; }, get time() { return time; },
    get frames() { return frames; }, get race() { return race; }, get link() { return link; }, api, quality,
    startRace, solo: () => { mode = 'solo'; go(); }, champ: () => { mode = 'champ'; go(); }, goOnline, setMode
  };
  requestAnimationFrame(frame);
  // signed in from before? fetch the profile quietly; the game works without it
  if (api.token) { try { await api.refresh(); } catch (e) { /* offline */ } if (state === 'menu') { player.look = myLook(); applyLook(player, player.look); buildMenu(); } }
}).catch(err => {
  console.error(err);
  $('loadText').textContent = 'Моделите не се заредиха. Играта трябва да се отвори през локалния сървър, не като файл.';
});
