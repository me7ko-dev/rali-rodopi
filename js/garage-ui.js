// The garage screen: a side sheet (bottom sheet in portrait) over the live menu scene, so the car stays visible.
//   const g = openGarage({ points, look, carName, onChange(look), onClose(look) });  g.close() closes it from outside.
// Builds its own DOM and loads css/garage.css itself. onChange fires on every pick, onClose on "Готово" or Escape.
import { LOOKS, cleanLook, isUnlocked, nextUnlock } from './core/looks.js';

const KINDS = [
  { kind: 'paint', tab: 'Боя', label: 'боя' },
  { kind: 'plate', tab: 'Номер', label: 'номер' },
  { kind: 'spoiler', tab: 'Спойлер', label: 'спойлер' },
  { kind: 'trail', tab: 'Следа от нитро', label: 'следа от нитро' }
];
const PLATE = { white: ['#f6f2e8', '#14161b'], kerb: ['#e23b2e', '#f6f2e8'], amber: ['#ffb627', '#14161b'], gold: ['linear-gradient(160deg,#f7dd7a,#c9a227 55%,#9c7a14)', '#2a1d05'] };
const LOCK = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M4 7V5a4 4 0 1 1 8 0v2h1v8H3V7h1Zm2 0h4V5a2 2 0 1 0-4 0v2Z"/></svg>';
const CAR = 'M3 25V17q0-3 5-3l8-1 7-6h17l9 6 9 1.5q4 1 4 4.5V25Z';
const SPOILERS = {
  none: '',
  lip: '<path d="M3 14.2 11 13.4 3 10.6Z" fill="var(--amber)"/>',
  gt: '<path d="M7 14V9" stroke="var(--amber)" stroke-width="1.6"/><rect x="1.5" y="7.6" width="11" height="2" fill="var(--amber)"/>',
  wing: '<path d="M5 14V5M9.5 13.4V5" stroke="var(--amber)" stroke-width="1.6"/><rect x="0" y="3.4" width="15" height="2.2" fill="var(--amber)"/><rect x="0" y="1.2" width="1.4" height="5.6" fill="var(--amber)"/>'
};
const pad = n => String(n).padStart(2, '0');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let cssReady = null;
function loadCss() {
  if (cssReady) return cssReady;
  const href = new URL('../css/garage.css', import.meta.url).href;
  let link = document.querySelector('link[data-garage-css]');
  cssReady = new Promise(resolve => {
    if (link && link.sheet) return resolve();
    if (!link) { link = document.createElement('link'); link.rel = 'stylesheet'; link.href = href; link.dataset.garageCss = ''; document.head.appendChild(link); }
    link.addEventListener('load', resolve, { once: true }); link.addEventListener('error', resolve, { once: true });
    setTimeout(resolve, 3000);
  });
  return cssReady;
}

function swatch(kind, it, num) {
  if (kind === 'paint') {
    if (!it.color) return '<span class="gar-sw gar-paint gar-stock"></span>';
    const bg = it.metal ? `linear-gradient(135deg,#fff8 0,${it.color} 38%,${it.color} 60%,#0006 100%),${it.color}` : it.color;
    return `<span class="gar-sw gar-paint" style="background:${bg}"></span>`;
  }
  if (kind === 'plate') {
    if (it.id === 'none') return '<span class="gar-sw gar-plate gar-noplate">—</span>';
    const [bg, fg] = PLATE[it.id];
    return `<span class="gar-sw gar-plate" style="background:${bg};color:${fg}"><i>РР</i><b data-num>${pad(num)}</b></span>`;
  }
  if (kind === 'spoiler') return `<span class="gar-sw gar-spoiler"><svg viewBox="0 0 65 28" aria-hidden="true"><path d="${CAR}" fill="currentColor"/><circle cx="16" cy="25" r="3.6" fill="#14161b" stroke="currentColor" stroke-width="1.4"/><circle cx="50" cy="25" r="3.6" fill="#14161b" stroke="currentColor" stroke-width="1.4"/>${SPOILERS[it.id] || ''}</svg></span>`;
  const bg = it.color ? `linear-gradient(90deg,transparent,${it.color}88 45%,${it.color} 85%,#fff)` : 'linear-gradient(90deg,transparent,#ff3b3b 20%,#ffb627 35%,#9dff3a 50%,#39c0ff 65%,#b45cff 82%,#fff)';
  return `<span class="gar-sw gar-trail" style="background:${bg}"></span>`;
}

/**
 * Open the garage overlay.
 * @param {{ points?: number, look?: object, carName?: string, onChange?: (look: object) => void, onClose?: (look: object) => void }} opts
 * @returns {{ el: HTMLElement, close: () => void, readonly look: object }}
 */
export function openGarage({ points = 0, look, carName = '', onChange = () => {}, onClose = () => {} } = {}) {
  loadCss();
  points = Math.max(0, Math.floor(Number(points) || 0));
  let cur = cleanLook(look, points), tab = 'paint', closed = false;
  const before = document.activeElement;

  const root = document.createElement('div');
  root.className = 'gar'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-labelledby', 'garTitle');
  root.style.visibility = 'hidden';
  const nx = nextUnlock(points), kindLabel = k => KINDS.find(x => x.kind === k).label;
  root.innerHTML = `
    <div class="gar-sheet">
      <header class="gar-head">
        <div class="gar-title"><span class="eyebrow">Гараж</span><h2 id="garTitle">${esc(carName || 'Твоята кола')}</h2></div>
        <div class="gar-pts" aria-label="Точки: ${points}"><b>${points}</b><span>точки</span></div>
      </header>
      <div class="gar-next">${nx
        ? `<p>Следва: <b>${esc(nx.name)}</b> (${kindLabel(nx.kind)}) — още ${nx.pts - points} т.</p><div class="bar" aria-hidden="true"><span style="width:${Math.round(points / nx.pts * 100)}%"></span></div>`
        : '<p>Всичко е отключено. Браво!</p>'}</div>
      <div class="gar-tabs" role="tablist" aria-label="Части">
        ${KINDS.map(k => `<button type="button" role="tab" id="garTab-${k.kind}" aria-controls="garPanel" data-tab="${k.kind}">${k.tab}</button>`).join('')}
      </div>
      <div class="gar-body" id="garPanel" role="tabpanel"></div>
      <footer class="gar-foot"><button type="button" class="go gar-done">Готово</button><span class="gar-hint">Само за външния вид. Нищо не се харчи: отключеното остава твое.</span></footer>
    </div>`;
  const $ = s => root.querySelector(s);
  const body = $('.gar-body'), tabs = [...root.querySelectorAll('[role=tab]')];

  function emit() { try { onChange({ ...cur }); } catch (e) { console.error(e); } }

  function renderTab(focusSelected) {
    for (const t of tabs) { const on = t.dataset.tab === tab; t.setAttribute('aria-selected', on); t.tabIndex = on ? 0 : -1; }
    body.setAttribute('aria-labelledby', 'garTab-' + tab);
    const k = KINDS.find(x => x.kind === tab);
    let html = '';
    if (tab === 'plate') {
      html += `<div class="gar-num">
        <span class="gar-num-l" id="garNumL">Състезателен номер</span>
        <div class="gar-num-c">
          <button type="button" class="gar-step" data-step="-1" aria-label="По-малък номер">−</button>
          <output class="gar-num-v" aria-live="polite" for="garNumR">${pad(cur.num)}</output>
          <button type="button" class="gar-step" data-step="1" aria-label="По-голям номер">+</button>
        </div>
        <input type="range" id="garNumR" min="0" max="99" step="1" value="${cur.num}" aria-labelledby="garNumL">
        <p class="gar-num-h"${cur.plate === 'none' ? '' : ' hidden'}>Номерът се вижда, когато избереш табела.</p>
      </div>`;
    }
    html += `<div class="gar-items" role="group" aria-label="${esc(k.tab)}">` + LOOKS[tab].map(it => {
      const open = isUnlocked(tab, it.id, points), sel = cur[tab] === it.id;
      const st = sel ? '<span class="gar-st gar-sel">Избрано</span>' : open ? '<span class="gar-st">Отключено</span>' : `<span class="gar-st gar-lock">${LOCK}още ${it.pts - points} т.</span>`;
      return `<button type="button" class="gar-item${open ? '' : ' locked'}" data-id="${it.id}" aria-pressed="${sel}"${open ? '' : ' aria-disabled="true"'}
        aria-label="${esc(it.name)}${sel ? ', избрано' : open ? '' : `, заключено, още ${it.pts - points} точки`}">${swatch(tab, it, cur.num)}<span class="gar-nm">${esc(it.name)}</span>${st}</button>`;
    }).join('') + '</div>';
    body.innerHTML = html;
    body.scrollTop = 0;
    if (focusSelected) { const s = body.querySelector('.gar-item[aria-pressed=true]'); if (s) s.focus({ preventScroll: false }); }
  }

  function pick(id) {
    if (!isUnlocked(tab, id, points) || cur[tab] === id) return;
    cur = { ...cur, [tab]: id };
    for (const b of body.querySelectorAll('.gar-item')) {
      const sel = b.dataset.id === id, open = !b.classList.contains('locked');
      b.setAttribute('aria-pressed', sel);
      const it = LOOKS[tab].find(x => x.id === b.dataset.id);
      b.setAttribute('aria-label', it.name + (sel ? ', избрано' : open ? '' : `, заключено, още ${it.pts - points} точки`));
      const st = b.querySelector('.gar-st');
      if (open) { st.className = 'gar-st' + (sel ? ' gar-sel' : ''); st.textContent = sel ? 'Избрано' : 'Отключено'; }
    }
    const h = body.querySelector('.gar-num-h'); if (h) h.hidden = cur.plate !== 'none';
    emit();
  }

  function setNum(n) {
    n = Math.max(0, Math.min(99, Math.round(n)));
    if (n === cur.num) return;
    cur = { ...cur, num: n };
    const o = body.querySelector('.gar-num-v'), r = body.querySelector('#garNumR');
    if (o) o.textContent = pad(n);
    if (r && +r.value !== n) r.value = n;
    for (const b of body.querySelectorAll('[data-num]')) b.textContent = pad(n);
    emit();
  }

  root.addEventListener('click', e => {
    const t = e.target.closest('button');
    if (!t || !root.contains(t)) return;
    if (t.dataset.tab) { if (t.dataset.tab !== tab) { tab = t.dataset.tab; renderTab(false); } return; }
    if (t.classList.contains('gar-item')) return pick(t.dataset.id);
    if (t.dataset.step) return setNum(cur.num + Number(t.dataset.step));
    if (t.classList.contains('gar-done')) close();
  });
  root.addEventListener('input', e => { if (e.target.id === 'garNumR') setNum(+e.target.value); });

  // keyboard: arrows move between tabs and between items, Tab stays inside the sheet, Esc closes.
  // Keys never reach the game behind (Enter would start the race there).
  root.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); return close(); }
    const a = document.activeElement;
    if (a && a.getAttribute('role') === 'tab' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End')) {
      e.preventDefault();
      const i = tabs.indexOf(a), n = tabs.length;
      const j = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + n) % n;
      tab = tabs[j].dataset.tab; renderTab(false); tabs[j].focus();
      return;
    }
    if (a && a.classList.contains('gar-item') && /^Arrow/.test(e.key)) {
      e.preventDefault();
      const items = [...body.querySelectorAll('.gar-item')], i = items.indexOf(a);
      const cols = Math.max(1, Math.round(body.querySelector('.gar-items').clientWidth / a.offsetWidth));
      const d = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols }[e.key];
      const j = Math.max(0, Math.min(items.length - 1, i + d));
      items[j].focus();
      return;
    }
    if (e.key === 'Tab') {
      const f = [...root.querySelectorAll('button, input, [tabindex="0"]')].filter(x => x.tabIndex >= 0 && x.offsetParent !== null);
      if (!f.length) return;
      if (e.shiftKey && a === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && a === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
  });
  const onWinKey = e => { if (e.key === 'Escape' && !root.contains(e.target)) { e.stopPropagation(); e.preventDefault(); close(); } };
  window.addEventListener('keydown', onWinKey, true);

  function close() {
    if (closed) return;
    closed = true;
    window.removeEventListener('keydown', onWinKey, true);
    root.remove();
    if (before && before.focus && document.contains(before)) before.focus();
    try { onClose({ ...cur }); } catch (e) { console.error(e); }
  }

  document.body.appendChild(root);
  renderTab(false);
  cssReady.then(() => { if (closed) return; root.style.visibility = ''; tabs[0].focus(); });
  return { el: root, close, get look() { return { ...cur }; } };
}
