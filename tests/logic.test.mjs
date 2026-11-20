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

// ---------------------------------------------------------------- second version (21 Nov 2026)
// A repeatable shake, so the checks give the same answer every run.
function shaker(seed = 7) {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
}
const spread = (xs) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length); };

test('a still hand that shakes by a few pixels is drawn steady (less than half the shake)', () => {
  const rnd = shaker(), sm = new L.HandSmoother(), raw = [], out = [];
  const base = hand({});
  for (let i = 0; i < 120; i++) {
    const pts = base.map(([x, y]) => [x + rnd() * 0.008, y + rnd() * 0.008]);
    const got = sm.step(pts, 1 / 30);
    if (i > 30) { raw.push(pts[8][0]); out.push(got[8][0]); }
  }
  assert.ok(spread(out) < 0.5 * spread(raw), `raw ${spread(raw).toFixed(5)} smoothed ${spread(out).toFixed(5)}`);
});

test('a fast hand is followed closely (smoothing lets go when it moves)', () => {
  const sm = new L.HandSmoother();
  let lagFast = 0;
  for (let i = 0; i < 30; i++) {                     // a full picture width a second
    const pts = hand({}, 0.2 + i / 30);
    lagFast = Math.abs(sm.step(pts, 1 / 30)[9][0] - pts[9][0]);
  }
  const plain = new L.OneEuro(L.SMOOTH_MIN_CUTOFF, 0, 1);   // the same smoothing with no let-go
  let lagPlain = 0;
  for (let i = 0; i < 30; i++) { const x = 0.2 + i / 30; lagPlain = Math.abs(plain.filter(x, 1 / 30) - x); }
  assert.ok(lagFast < 0.03, `fast hand trails by ${lagFast.toFixed(3)} of the picture`);
  assert.ok(lagFast < lagPlain / 2, `${lagFast} vs ${lagPlain}`);
});

test('the depth guess is smoothed: a shaking size gives a steady distance', () => {
  const rnd = shaker(3), f = new L.OneEuro(0.7, 2.5, 1), raw = [], out = [];
  for (let i = 0; i < 120; i++) {
    const d = L.handDepth(hand({}, 0.5, 0.7, 0.12 * (1 + rnd() * 0.12)), 70, 16 / 9);
    const got = f.filter(d, 1 / 30);
    if (i > 30) { raw.push(d); out.push(got); }
  }
  assert.ok(spread(out) < 0.4 * spread(raw), `raw ${spread(raw).toFixed(4)} smoothed ${spread(out).toFixed(4)}`);
});

test('camera width is the long side, so a phone held upright reads the same hand as the same distance', () => {
  // The same real hand: in a landscape picture (16:9) and in the upright one (9:16) from the same camera.
  const wide = L.handDepth(hand({}, 0.5, 0.7, 0.12, 16 / 9), 70, 16 / 9);
  const upright = hand({}, 0.5, 0.7, 0.12 * 9 / 16, 9 / 16);   // same pixels, the picture is now taller
  const tall = L.handDepth(upright, 70, 9 / 16);
  assert.ok(Math.abs(tall / wide - 1) < 0.02, `landscape ${wide.toFixed(3)} m, upright ${tall.toFixed(3)} m`);
  assert.deepEqual(L.tans(70, 16 / 9).map((x) => +x.toFixed(4)), L.tans(70, 9 / 16).slice().reverse().map((x) => +x.toFixed(4)));
});

test('you grab what your fingers are in front of, even when the distance guess is badly off', () => {
  const model = { centre: [0, 0, -0.45], radius: 0.11 };
  const other = { centre: [0.3, 0, -0.45], radius: 0.11 };
  // Fingers straight in front of the model, guessed at 0.75 m (the old 3D test needed 0.15 m):
  assert.equal(L.pickByRay([0.01, 0.0, -0.75], [model, other]), 0);
  assert.equal(L.pickByRay([0.3, 0.0, -0.45], [model, other]), 1);
  assert.equal(L.pickByRay([-0.4, 0.3, -0.45], [model, other]), -1, 'empty air');
  // A big thing just beside and behind your head: never grabbed.
  assert.equal(L.pickByRay([0, 0, -1], [{ centre: [0.1, 0, 0.02], radius: 0.3 }]), -1, 'nothing behind you');
  // Two in line: the nearer one.
  assert.equal(L.pickByRay([0, 0, -1], [{ centre: [0, 0, -1.2], radius: 0.25 }, model]), 1);
});

test('a line through the fingers meets the menu face where you see it', () => {
  const hit = L.rayPlane([0, 0, 0], [0.1, 0, -1], [0, 0, -0.5], [0, 0, 1]);
  assert.deepEqual(hit.map((x) => +x.toFixed(4)), [0.05, 0, -0.5]);
  assert.equal(L.rayPlane([0, 0, 0], [0, 0, 1], [0, 0, -0.5], [0, 0, 1]), null, 'pointing away');
});

test('head turn readings are blended for the moment the picture was taken', () => {
  const log = new L.OrientationLog(1000);
  const yaw = (deg) => [0, Math.sin((deg * Math.PI) / 360), 0, Math.cos((deg * Math.PI) / 360)];
  log.add(1000, yaw(0));
  log.add(1100, yaw(20));
  const mid = log.at(1050);
  const deg = (2 * Math.atan2(mid[1], mid[3]) * 180) / Math.PI;
  assert.ok(Math.abs(deg - 10) < 0.01, `${deg}`);
  assert.deepEqual(log.at(900), yaw(0), 'before the first: the first');
  assert.deepEqual(log.at(5000), yaw(20), 'after the last: the last');
  log.add(1050, yaw(90));
  assert.equal(log.size, 2, 'a reading from the past is ignored');
});

test('the picture behind each eye slides the opposite way, and not at all for one picture', () => {
  const f = 1400, s = (side) => L.pictureShift(side, f, 0.03, 0.5);
  assert.ok(s(-1) > 0 && s(1) < 0, 'left eye: right; right eye: left');
  assert.ok(Math.abs(s(-1) - 42) < 0.01, `${s(-1)} px`);
  assert.equal(s(0), 0);
});
