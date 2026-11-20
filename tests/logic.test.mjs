// node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as L from '../js/logic.js';

// A made-up hand, the same shapes as the laptop app's checks. size in picture-height units.
const OPEN = {0: [0, 0], 1: [0.25, 0.15], 2: [0.48, 0.35], 3: [0.62, 0.55], 4: [0.72, 0.75], 5: [0.28, 0.95],
  6: [0.32, 1.35], 7: [0.34, 1.62], 8: [0.35, 1.85], 9: [0, 1], 10: [0, 1.45], 11: [0, 1.75], 12: [0, 2],
  13: [-0.22, 0.93], 14: [-0.26, 1.33], 15: [-0.28, 1.6], 16: [-0.29, 1.82], 17: [-0.42, 0.8],
  18: [-0.5, 1.1], 19: [-0.54, 1.3], 20: [-0.57, 1.48]};
const FIST = {4: [0.3, 0.7], 6: [0.3, 1.25], 7: [0.28, 0.95], 8: [0.2, 0.6], 10: [0, 1.3], 11: [0, 0.95], 12: [0, 0.55],
  14: [-0.25, 1.22], 15: [-0.22, 0.9], 16: [-0.18, 0.55], 18: [-0.48, 1.02], 19: [-0.42, 0.75], 20: [-0.35, 0.5]};
const PINCH = {4: [0.72, 0.85], 6: [0.4, 1.25], 7: [0.58, 1.2], 8: [0.7, 0.95]};
const POINT = {...FIST, 6: [0.32, 1.35], 7: [0.34, 1.62], 8: [0.35, 1.85], 4: [0.12, 0.62]};

function hand(pose, cx = 0.5, cy = 0.7, size = 0.12, aspect = 16 / 9) {
  const p = {...OPEN, ...pose};
  return Array.from({length: 21}, (_, i) => [cx + (p[i][0] * size) / aspect, cy - p[i][1] * size]);
}

test('an open hand, a fist, a pinch and a pointing hand are read right', () => {
  const o = L.readHand(hand({})), f = L.readHand(hand(FIST)), p = L.readHand(hand(PINCH)), pt = L.readHand(hand(POINT));
  assert.ok(o.open && !o.fist && o.gap > 0.55);
  assert.ok(f.fist && !f.open);
  assert.ok(p.gap < L.PINCH_ON && !p.fist);
  assert.ok(pt.point && !pt.open);
});

test('a pinch starts below 0.26, survives a flicker, and ends after 0.1 s apart', () => {
  let s = {on: false, apart: 0};
  s = L.stepPinch(s, 0.2, false, 1 / 30);
  assert.ok(s.on && s.down);
  s = L.stepPinch(s, 0.6, false, 1 / 30);
  assert.ok(s.on && !s.up, 'one picture apart is not a let-go');
  s = L.stepPinch(s, 0.2, false, 1 / 30);
  for (let i = 0; i < 5; i++) s = L.stepPinch(s, 0.6, false, 1 / 30);
  assert.ok(!s.on);
  s = L.stepPinch({on: false, apart: 0}, 0.3, false, 1 / 30);
  assert.ok(!s.on, '0.30 is between the two lines: not a new pinch');
  s = L.stepPinch({on: true, apart: 0}, 0.1, true, 1 / 30);
  assert.ok(!s.on, 'a fist is never a pinch');
});

test('the same hand keeps its id through a 0.4 s blink; a ghost copy is not a second hand', () => {
  const m = new L.Matcher();
  const h = L.readHand(hand({}));
  for (let i = 0; i < 5; i++) m.step([h], 1 / 30);
  const id = m.tracks[0].id;
  for (let i = 0; i < 12; i++) m.step([], 1 / 30);
  assert.equal(m.tracks.length, 1, 'still waited for');
  m.step([h], 1 / 30);
  assert.equal(m.tracks[0].id, id);
  const ghost = L.readHand(hand({}, 0.49, 0.69, 0.07));
  for (let i = 0; i < 5; i++) m.step([h, ghost], 1 / 30);
  assert.equal(m.tracks.length, 1);
  for (let i = 0; i < 20; i++) m.step([], 1 / 30);
  assert.equal(m.tracks.length, 0, 'gone for good after the grace');
});

test('two real hands keep their own ids when the list order swaps', () => {
  const m = new L.Matcher();
  const a = L.readHand(hand({}, 0.3)), b = L.readHand(hand({}, 0.7));
  for (let i = 0; i < 4; i++) m.step([a, b], 1 / 30);
  const left = m.tracks.find((t) => t.hand.palm[0] < 0.5).id;
  for (let i = 0; i < 4; i++) m.step(i % 2 ? [b, a] : [a, b], 1 / 30);
  assert.equal(m.tracks.find((t) => t.hand.palm[0] < 0.5).id, left);
});

test('a still palm is still; a moving one is not', () => {
  const m = new L.Matcher();
  const h = L.readHand(hand({}));
  for (let i = 0; i < 20; i++) m.step([h], 1 / 30);
  assert.ok(L.isStill(m.tracks[0]));
  for (let i = 0; i < 20; i++) m.step([L.readHand(hand({}, 0.3 + i * 0.01))], 1 / 30);
  assert.ok(!L.isStill(m.tracks[0]));
});

test('a hand that looks half as wide is twice as far away', () => {
  const near = L.handDepth(hand({}, 0.5, 0.7, 0.2), 70, 16 / 9);
  const far = L.handDepth(hand({}, 0.5, 0.7, 0.1), 70, 16 / 9);
  assert.ok(Math.abs(far / near - 2) < 0.05, `${near} ${far}`);
  assert.ok(near > 0.15 && near < 1.0, `a hand filling a fifth of the picture is at arm's length: ${near}`);
});

test('the middle of the picture is straight ahead; the crop maps the middle to the middle', () => {
  assert.deepEqual(L.pointAt(0.5, 0.5, 0.4, 70, 16 / 9).map((x) => Math.round(x * 1000) / 1000), [0, 0, -0.4]);
  const crop = L.cropFor(16 / 9, 1.08);
  assert.ok(crop.w < 1 && crop.h === 1);
  assert.deepEqual(L.pictureToView(0.5, 0.5, crop), [0.5, 0.5]);
  assert.equal(L.pictureToView(0.02, 0.5, crop), null, 'the cut-off side is not in view');
});

test('the ring menu finds the slice a point is in', () => {
  assert.equal(L.ringSlot([0, -1], [0, 0], 0.5, 1.5, 8), 0, 'straight up is the first slice');
  assert.equal(L.ringSlot([1, 0], [0, 0], 0.5, 1.5, 8), 2);
  assert.equal(L.ringSlot([0, 0.1], [0, 0], 0.5, 1.5, 8), null, 'the middle is no slice');
});

test('every model in models.json is clean and complete', () => {
  const models = JSON.parse(readFileSync(new URL('../models.json', import.meta.url)));
  assert.ok(models.length >= 17);
  for (const m of models) {
    const c = L.cleanModel(m);
    assert.equal(c.parts.length, m.parts.length, m.name);
  }
  assert.ok(models.some((m) => m.name === 'GAUNTLET'));
  assert.throws(() => L.cleanModel({name: 'x', parts: [{v: [[NaN, 0, 0]], e: []}]}));
});
