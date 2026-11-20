// JARVIS Hands VR: the parts with no browser in them, so they can be checked with Node.
// The same rules as the laptop app (C:\Projects\JARVIS-Hands\hands.py), measured there:
//   pinch starts below 0.26 and ends above 0.38 (gap between thumb and index tips, in hand
//   sizes), and only once the fingers have stayed apart 0.1 s; a lost hand is waited for
//   0.5 s (0.6 s while it holds something); a smaller copy of a hand on top of it is a ghost.

export const PINCH_ON = 0.26;
export const PINCH_OFF = 0.38;
export const PINCH_RELEASE = 0.1;
export const GRACE = 0.5;
export const HOLD_GRACE = 0.6;
export const GHOST_NEAR = 0.45;
export const HAND_WIDTH_M = 0.08;     // knuckle row of a teenage hand, metres (for depth)

const d2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// One hand in one picture. pts: 21 [x, y] in the picture's 0..1 coordinates, aspect = w / h.
export function readHand(pts, aspect = 16 / 9) {
  const p = pts.map(([x, y]) => [x * aspect, y]);           // square units, so sizes are fair
  const size = Math.max(d2(p[0], p[9]), d2(p[5], p[17]) * 1.3, 1e-6);
  const palm = [0, 5, 9, 13, 17].reduce((s, i) => [s[0] + p[i][0] / 5, s[1] + p[i][1] / 5], [0, 0]);
  const gap = d2(p[4], p[8]) / size;
  const reach = [[8, 5], [12, 9], [16, 13], [20, 17]].map(([t, m]) => d2(p[t], p[0]) / Math.max(d2(p[m], p[0]), 1e-6));
  const ext = [[8, 6], [12, 10], [16, 14], [20, 18]].map(([t, j]) => d2(p[t], p[0]) > d2(p[j], p[0]) * 1.05);
  const fist = reach.every((r) => r < 1.0) && gap < 0.55;
  const open = ext.every(Boolean) && gap > 0.55;
  const point = ext[0] && !ext[1] && !ext[2] && !ext[3];
  return {
    size, gap, fist, open, point,
    palm: [palm[0] / aspect, palm[1]],
    pinchPt: [(pts[4][0] + pts[8][0]) / 2, (pts[4][1] + pts[8][1]) / 2],
    tip: pts[8],
  };
}

// Pinch with two thresholds and a let-go grace, like the laptop app.
export function stepPinch(state, gap, fist, dt) {
  const s = { ...state, down: false, up: false };
  const was = s.on;
  if (fist) {
    s.on = false;
    s.apart = 0;
  } else if (was) {
    s.apart = gap < PINCH_OFF ? 0 : s.apart + dt;
    s.on = s.apart < PINCH_RELEASE;
  } else {
    s.apart = 0;
    s.on = gap < PINCH_ON;
  }
  s.down = s.on && !was;
  s.up = was && !s.on;
  return s;
}

// Which hand in this picture is which hand from the last one: nearest pairs first, ghosts
// (a smaller copy on top of a hand) dropped, a lost hand kept for a moment.
export class Matcher {
  constructor() { this.tracks = []; this.next = 1; }

  step(hands, dt, busy = () => false) {
    // hands: [{palm, size, ...readHand}]
    const ghosts = new Set();
    for (let i = 0; i < hands.length; i++) {
      for (let j = i + 1; j < hands.length; j++) {
        const big = Math.max(hands[i].size, hands[j].size);
        if (d2(hands[i].palm, hands[j].palm) * 16 / 9 >= GHOST_NEAR * big) continue;
        const mid = [(hands[i].palm[0] + hands[j].palm[0]) / 2, (hands[i].palm[1] + hands[j].palm[1]) / 2];
        const near = this.tracks.filter((t) => d2(t.hand.palm, mid) * 16 / 9 < big).length;
        if (near >= 2) continue;
        ghosts.add(hands[i].size < hands[j].size ? i : j);
      }
    }
    const pairs = [];
    hands.forEach((h, ci) => {
      if (ghosts.has(ci)) return;
      this.tracks.forEach((t, ti) => {
        const d = d2(t.hand.palm, h.palm) * 16 / 9;
        if (d < Math.max(0.25, 2.5 * Math.max(h.size, t.hand.size))) pairs.push([d, ci, ti]);
      });
    });
    pairs.sort((a, b) => a[0] - b[0]);
    const match = new Map(), used = new Set();
    for (const [, ci, ti] of pairs) {
      if (!match.has(ci) && !used.has(ti)) { match.set(ci, ti); used.add(ti); }
    }
    const now = [];
    hands.forEach((h, ci) => {
      if (ghosts.has(ci)) return;
      let t;
      if (match.has(ci)) t = this.tracks[match.get(ci)];
      else t = { id: this.next++, pinch: { on: false, apart: 0, down: false, up: false }, still: [], age: 0 };
      t.hand = h;
      t.missing = 0;
      t.age += dt;
      t.pinch = stepPinch(t.pinch, h.gap, h.fist, dt);
      t.still.push([t.age, h.palm[0], h.palm[1]]);
      while (t.still.length && t.still[0][0] < t.age - 0.6) t.still.shift();
      now.push(t);
    });
    this.tracks.forEach((t, ti) => {
      if (used.has(ti)) return;
      if (t.missing + dt <= (busy(t) || t.pinch.on ? HOLD_GRACE : GRACE)) {
        t.missing += dt;
        t.age += dt;
        t.pinch = { ...t.pinch, down: false, up: false };
        now.push(t);
      }
    });
    this.tracks = now;
    return now;
  }
}

// Has this hand's palm stayed within `limit` (picture fractions) for `secs`?
export function isStill(track, secs = 0.4, limit = 0.03) {
  const pts = track.still.filter((q) => q[0] >= track.age - secs);
  if (pts.length < 2 || pts[pts.length - 1][0] - pts[0][0] < secs * 0.7) return false;
  const xs = pts.map((q) => q[1]), ys = pts.map((q) => q[2]);
  return Math.max(...xs) - Math.min(...xs) < limit && Math.max(...ys) - Math.min(...ys) < limit;
}

// A point in the camera picture (0..1) as a direction from the camera, in "tangent" units at
// depth 1 (x right, y up, looking down -z), for a camera of the given field of view (degrees).
export function pictureToRay(u, v, hfovDeg, aspect) {
  const tx = Math.tan((hfovDeg * Math.PI) / 360);
  const ty = tx / aspect;
  return [(u - 0.5) * 2 * tx, (0.5 - v) * 2 * ty, -1];
}

// How far away a hand is, in metres, from how wide its knuckle row looks.
export function handDepth(pts, hfovDeg, aspect) {
  const a = pictureToRay(pts[5][0], pts[5][1], hfovDeg, aspect);
  const b = pictureToRay(pts[17][0], pts[17][1], hfovDeg, aspect);
  const c = pictureToRay(pts[0][0], pts[0][1], hfovDeg, aspect);
  const e = pictureToRay(pts[9][0], pts[9][1], hfovDeg, aspect);
  const w = Math.max(Math.hypot(a[0] - b[0], a[1] - b[1]), Math.hypot(c[0] - e[0], c[1] - e[1]) / 1.15, 1e-4);
  return Math.min(Math.max(HAND_WIDTH_M / w, 0.15), 1.5);
}

// The 3D point (camera space, metres) for a picture point at a depth.
export function pointAt(u, v, depth, hfovDeg, aspect) {
  const r = pictureToRay(u, v, hfovDeg, aspect);
  return [r[0] * depth, r[1] * depth, -depth];
}

// The middle part of the camera picture shown in an eye's view (same height, sides cut off),
// and where a picture point lands in that view (0..1), or null off the sides.
export function cropFor(videoAspect, viewAspect) {
  const w = Math.min(1, viewAspect / videoAspect);       // fraction of the picture's width shown
  const h = Math.min(1, videoAspect / viewAspect);
  return { w, h, x0: (1 - w) / 2, y0: (1 - h) / 2 };
}

export function pictureToView(u, v, crop) {
  const x = (u - crop.x0) / crop.w, y = (v - crop.y0) / crop.h;
  return x < 0 || x > 1 || y < 0 || y > 1 ? null : [x, y];
}

// The slice of a ring menu a point is in (2D, any units), or null.
export function ringSlot(p, centre, rIn, rOut, n) {
  const dx = p[0] - centre[0], dy = p[1] - centre[1];
  const r = Math.hypot(dx, dy);
  if (r < rIn || r > rOut) return null;
  const a = (Math.atan2(dy, dx) + Math.PI / 2 + 2 * Math.PI) % (2 * Math.PI);
  return Math.floor(a / ((2 * Math.PI) / n)) % n;
}

// A model from models.json made safe: at most 60 parts, at most 4,000 points, numbers only.
export function cleanModel(m) {
  if (!m || typeof m.name !== 'string' || !Array.isArray(m.parts)) throw new Error('not a model');
  const parts = [];
  let total = 0;
  for (const p of m.parts.slice(0, 60)) {
    if (!Array.isArray(p.v) || !Array.isArray(p.e)) continue;
    const v = p.v.filter((q) => Array.isArray(q) && q.length === 3 && q.every(Number.isFinite));
    if (!v.length || total + v.length > 4000) continue;
    const e = p.e.filter((q) => Array.isArray(q) && q.length === 2 && q.every((i) => Number.isInteger(i) && i >= 0 && i < v.length));
    const c = Array.isArray(p.c) && p.c.length === 3 && p.c.every(Number.isFinite) ? p.c : [0, 0, 0];
    total += v.length;
    parts.push({ v, e, c });
  }
  if (!parts.length) throw new Error('no parts');
  return { name: m.name.slice(0, 24), parts };
}
