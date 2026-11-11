// Garage catalog rules (js/core/looks.js): node --test test/garage.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOOKS, DEFAULT_LOOK, item, isUnlocked, cleanLook, nextUnlock } from '../js/core/looks.js';

test('catalog: unique ids, free default in every kind, defaults exist', () => {
  for (const [kind, list] of Object.entries(LOOKS)) {
    const ids = list.map(x => x.id);
    assert.equal(new Set(ids).size, ids.length, kind + ' ids are unique');
    assert.ok(list.some(x => x.pts === 0), kind + ' has a free item');
    assert.ok(item(kind, DEFAULT_LOOK[kind]), kind + ' default is in the catalog');
    assert.equal(item(kind, DEFAULT_LOOK[kind]).pts, 0, kind + ' default is free');
    for (const x of list) { assert.ok(Number.isInteger(x.pts) && x.pts >= 0, `${kind}/${x.id} pts`); assert.ok(x.name, `${kind}/${x.id} has a name`); }
  }
  assert.ok(Number.isInteger(DEFAULT_LOOK.num) && DEFAULT_LOOK.num >= 0 && DEFAULT_LOOK.num <= 99);
});

test('isUnlocked: by points, unknown ids and kinds never', () => {
  assert.equal(isUnlocked('paint', 'stock', 0), true);
  assert.equal(isUnlocked('paint', 'gold', 299), false);
  assert.equal(isUnlocked('paint', 'gold', 300), true);
  assert.equal(isUnlocked('paint', 'gold', undefined), false);
  assert.equal(isUnlocked('paint', 'stock', undefined), true);
  assert.equal(isUnlocked('paint', 'nope', 1e9), false);
  assert.equal(isUnlocked('wheels', 'stock', 1e9), false);
  assert.equal(isUnlocked('paint', undefined, 1e9), false);
});

test('cleanLook: garbage in, default out', () => {
  for (const bad of [null, undefined, 5, 'x', [], true]) assert.deepEqual(cleanLook(bad), DEFAULT_LOOK);
  const out = cleanLook(null);
  out.paint = 'gold';
  assert.equal(DEFAULT_LOOK.paint, 'stock', 'the default is not shared by reference');
});

test('cleanLook: locked items fall back to the defaults, unlocked ones stay', () => {
  const want = { paint: 'gold', plate: 'gold', num: 42, spoiler: 'wing', trail: 'rainbow' };
  assert.deepEqual(cleanLook(want, 0), { ...DEFAULT_LOOK, num: 42 });
  assert.deepEqual(cleanLook(want, 1000), want);
  assert.deepEqual(cleanLook(want), want, 'no points given = everything allowed');
  const mid = cleanLook(want, 200);
  assert.equal(mid.paint, 'stock'); // gold needs 300
  assert.equal(mid.plate, 'none'); // gold plate needs 250
  assert.equal(mid.spoiler, 'wing'); // 160
  assert.equal(mid.trail, 'blue'); // rainbow needs 400
  assert.deepEqual(cleanLook({ paint: 'kerb', trail: 'fire' }, 25), { ...DEFAULT_LOOK, paint: 'kerb' }, 'fire needs 35');
});

test('cleanLook: unknown ids and extra keys are rejected', () => {
  const out = cleanLook({ paint: 'pink', plate: '<b>', spoiler: 42, trail: { id: 'fire' }, speed: 99, __proto__: { paint: 'gold' } });
  assert.deepEqual(out, DEFAULT_LOOK);
  assert.deepEqual(Object.keys(out).sort(), Object.keys(DEFAULT_LOOK).sort());
});

test('cleanLook: numbers are rounded, out of range keeps the default', () => {
  const n = v => cleanLook({ num: v }).num;
  assert.equal(n(0), 0);
  assert.equal(n(99), 99);
  assert.equal(n(12.4), 12);
  assert.equal(n(98.6), 99);
  assert.equal(n('33'), 33);
  assert.ok(n(-0.4) === 0, '-0.4 rounds to 0 (core returns -0, same in JSON)');
  assert.equal(n(null), 0, 'Number(null) is 0, so a null number reads as 0 (core behaviour)');
  for (const bad of [100, 99.6, -1, -0.6, NaN, Infinity, 'abc', undefined, {}]) assert.equal(n(bad), DEFAULT_LOOK.num, 'num ' + String(bad));
});

test('nextUnlock: the cheapest item above the points', () => {
  assert.deepEqual(nextUnlock(0), { kind: 'paint', ...item('paint', 'snow') });
  const all = Object.entries(LOOKS).flatMap(([kind, list]) => list.map(x => ({ kind, ...x })));
  for (const p of [0, 9, 10, 24, 25, 100, 299, 449]) {
    const nx = nextUnlock(p);
    assert.ok(nx.pts > p, `next after ${p} costs more`);
    assert.equal(nx.pts, Math.min(...all.filter(x => x.pts > p).map(x => x.pts)), `next after ${p} is the cheapest`);
    assert.ok(!isUnlocked(nx.kind, nx.id, p) && isUnlocked(nx.kind, nx.id, nx.pts));
  }
  assert.equal(nextUnlock(Math.max(...all.map(x => x.pts))), null, 'nothing left at the top');
  assert.equal(nextUnlock(1e9), null);
});
