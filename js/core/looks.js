// Garage: what a car can look like. Only looks, never speed. Points from races unlock each item
// (nothing is spent: once you have the points, the item is yours). Shared with the server, which checks it.

export const LOOKS = {
  paint: [
    { id: 'stock', name: 'Фабрична', pts: 0, color: null },
    { id: 'snow', name: 'Снежнобяла', pts: 10, color: '#f2f2ee' },
    { id: 'kerb', name: 'Бордюрено червено', pts: 25, color: '#d7261e' },
    { id: 'pine', name: 'Борова зелена', pts: 45, color: '#1f6b3a' },
    { id: 'lake', name: 'Езерно синьо', pts: 70, color: '#1d5fbf' },
    { id: 'amber', name: 'Кехлибар', pts: 100, color: '#ffb627' },
    { id: 'night', name: 'Нощно черно', pts: 140, color: '#17181c' },
    { id: 'plum', name: 'Слива', pts: 190, color: '#6b2a7a' },
    { id: 'gold', name: 'Злато', pts: 300, color: '#c9a227', metal: true },
    { id: 'chrome', name: 'Хром', pts: 450, color: '#c8ccd2', metal: true }
  ],
  plate: [
    { id: 'none', name: 'Без номер', pts: 0 },
    { id: 'white', name: 'Бял номер', pts: 0 },
    { id: 'kerb', name: 'Червен номер', pts: 30 },
    { id: 'amber', name: 'Жълт номер', pts: 80 },
    { id: 'gold', name: 'Златен номер', pts: 250 }
  ],
  spoiler: [
    { id: 'none', name: 'Без спойлер', pts: 0 },
    { id: 'lip', name: 'Малък', pts: 20 },
    { id: 'gt', name: 'Състезателен', pts: 60 },
    { id: 'wing', name: 'Голямо крило', pts: 160 }
  ],
  trail: [
    { id: 'blue', name: 'Синя', pts: 0, color: '#39c0ff' },
    { id: 'fire', name: 'Огнена', pts: 35, color: '#ff6a1a' },
    { id: 'lime', name: 'Лайм', pts: 90, color: '#9dff3a' },
    { id: 'violet', name: 'Виолетова', pts: 200, color: '#b45cff' },
    { id: 'rainbow', name: 'Дъга', pts: 400, color: null }
  ]
};

export const DEFAULT_LOOK = { paint: 'stock', plate: 'none', num: 7, spoiler: 'none', trail: 'blue' };

export const item = (kind, id) => (LOOKS[kind] || []).find(x => x.id === id);

/** Is this item unlocked with that many points? */
export const isUnlocked = (kind, id, points) => { const it = item(kind, id); return !!it && (points || 0) >= it.pts; };

/** Take any look (from a save, from the network) and return a safe one: unknown or locked parts fall back to the default. */
export function cleanLook(look, points = Infinity) {
  const out = { ...DEFAULT_LOOK };
  if (!look || typeof look !== 'object') return out;
  for (const kind of Object.keys(LOOKS)) if (isUnlocked(kind, look[kind], points)) out[kind] = look[kind];
  const n = Math.round(Number(look.num));
  if (Number.isFinite(n) && n >= 0 && n <= 99) out.num = n;
  return out;
}

/** The next thing that unlocks after `points`, for the "X points until …" hint. */
export function nextUnlock(points) {
  let best = null;
  for (const [kind, list] of Object.entries(LOOKS)) for (const it of list) if (it.pts > points && (!best || it.pts < best.pts)) best = { kind, ...it };
  return best;
}
